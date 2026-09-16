import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { IdentityResolver } from "../auth/identity.js";
import type { Clock } from "../incident/types.js";
import { sweepDeviceIntoTopics } from "../tier/subscriptions.js";
import type { V1Env } from "./auth.js";

// api.md §3.7. Signing in does not create an account. Registration already made
// one (§4.2) and it has owned topics, devices and billing ever since. These
// routes attach a human identity to an account that exists, and in one case move
// a handset from one existing account to another.

export const linkSchema = z.object({ identity_token: z.string().min(1) });
export const switchSchema = z.object({ identity_token: z.string().min(1), into_account: z.string().min(1) });

export type LinkOutcome =
  | { status: 200; body: { account_id: string; outcome: "claimed" | "attached" } }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 409; body: { error: "choose"; into_account: string; topics: number; incidents: number } }
  | { status: 409; body: { error: "account has another identity" } };

export type SwitchOutcome =
  | { status: 200; body: { account_id: string } }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 409; body: { error: "account has another identity" } };

// accounts.merged_into points a tombstone at the account that survived it, so a
// credential that still names the old one resolves forward. The hop count is
// bounded because a cycle here would hang a request.
function liveAccount(db: Database.Database, accountId: string): string {
  let current = accountId;
  for (let hop = 0; hop < 8; hop += 1) {
    const row = db.prepare("SELECT merged_into FROM accounts WHERE id = ?").get(current) as { merged_into: string | null } | undefined;
    if (row === undefined || row.merged_into === null) return current;
    current = row.merged_into;
  }
  return current;
}

function identityAccount(db: Database.Database, userId: string): string | undefined {
  const row = db.prepare("SELECT account_id FROM account_identities WHERE user_id = ?").get(userId) as { account_id: string } | undefined;
  return row === undefined ? undefined : liveAccount(db, row.account_id);
}

function accountIdentity(db: Database.Database, accountId: string): string | undefined {
  const row = db.prepare("SELECT user_id FROM account_identities WHERE account_id = ?").get(accountId) as { user_id: string } | undefined;
  return row?.user_id;
}

// "Empty" is no topics and no incidents. Registration runs long before any
// sign-in screen, so almost every second handset arrives holding an account with
// nothing in it, and without this count every one of them would prompt.
export function accountContent(db: Database.Database, accountId: string): { topics: number; incidents: number } {
  const topics = db.prepare("SELECT COUNT(*) AS count FROM topics WHERE account_id = ?").get(accountId) as { count: number };
  const incidents = db.prepare("SELECT COUNT(*) AS count FROM incidents WHERE topic_id IN (SELECT id FROM topics WHERE account_id = ?)").get(accountId) as { count: number };
  return { topics: topics.count, incidents: incidents.count };
}

// Every device on the losing account, not only the caller's. The account is
// about to become a tombstone, and a device left pointing at one has no tier, no
// caps and no topics: it is stranded.
//
// Subscriptions carry no account of their own (they hang off devices.account_id),
// so the old rows would keep the moved handset subscribed to topics it no longer
// has access to. They are dropped and re-swept from the target's topics.
function moveDevices(db: Database.Database, from: string, into: string): void {
  const devices = db.prepare("SELECT id FROM devices WHERE account_id = ?").all(from) as { id: string }[];
  for (const device of devices) {
    db.prepare("DELETE FROM subscriptions WHERE device_id = ?").run(device.id);
    db.prepare("UPDATE devices SET account_id = ? WHERE id = ?").run(into, device.id);
    sweepDeviceIntoTopics(db, into, device.id);
  }
}

// The tombstone. join_token_hash goes with it: an aj_ minted for this account
// would otherwise keep attaching new handsets to a dead tenant, which is the
// same failure as a live tk_ on a dead tenant, one route along.
function tombstone(db: Database.Database, accountId: string, into: string): void {
  db.prepare("UPDATE accounts SET merged_into = ?, join_token_hash = NULL WHERE id = ?").run(into, accountId);
}

// api.md §3.7, the switch branch that can silently stop paging somebody.
// authenticateTopic matches on the topic token alone and never looks at the
// account (src/ingress/auth.ts), so an abandoned account's tk_ tokens keep
// accepting publishes, keep opening incidents, and have no device left to ring.
// The contract allows revoking the tokens or answering 410 on publish. This is
// the revoke. Nothing else in the request path has to learn about tombstones.
function revokeTopicTokens(db: Database.Database, accountId: string): void {
  db.prepare("DELETE FROM topic_tokens WHERE topic_id IN (SELECT id FROM topics WHERE account_id = ?)").run(accountId);
}

export function linkIdentity(db: Database.Database, clock: Clock, identities: IdentityResolver, sourceAccount: string, identityToken: string): LinkOutcome {
  const identity = identities.resolve(identityToken);
  if (identity === null) return { status: 401, body: { error: "unauthorized" } };
  const source = liveAccount(db, sourceAccount);
  const claimedBy = accountIdentity(db, source);
  // The shared-handset case. api.md §3.7 requires 409 here and forbids letting
  // the unique index decide it at 500, so it is checked before anything is
  // written.
  if (claimedBy !== undefined && claimedBy !== identity.userId) {
    return { status: 409, body: { error: "account has another identity" } };
  }
  const target = identityAccount(db, identity.userId);

  if (target === undefined) {
    // Sign-up. One row, pointing at the account this device already has.
    // Nothing moves and no token changes.
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES (?, ?, ?)").run(identity.userId, source, clock.now());
    return { status: 200, body: { account_id: source, outcome: "claimed" } };
  }
  // Already linked to this very account. Same end state as the line above, so
  // the same answer: calling link twice is not an error.
  if (target === source) return { status: 200, body: { account_id: source, outcome: "claimed" } };

  const content = accountContent(db, source);
  if (content.topics === 0 && content.incidents === 0) {
    db.transaction(() => {
      moveDevices(db, source, target);
      tombstone(db, source, target);
    })();
    return { status: 200, body: { account_id: target, outcome: "attached" } };
  }
  return { status: 409, body: { error: "choose", into_account: target, topics: content.topics, incidents: content.incidents } };
}

export function switchAccount(db: Database.Database, identities: IdentityResolver, sourceAccount: string, identityToken: string, intoAccount: string): SwitchOutcome {
  const identity = identities.resolve(identityToken);
  if (identity === null) return { status: 401, body: { error: "unauthorized" } };
  const target = identityAccount(db, identity.userId);
  // Both ends are checked: the token resolves to an identity, and that identity
  // owns the account named in the body. A mismatch is not an authorisation this
  // credential carries, so 401.
  if (target === undefined || target !== liveAccount(db, intoAccount)) return { status: 401, body: { error: "unauthorized" } };
  const source = liveAccount(db, sourceAccount);
  // Already there. Nothing to do, and running the move would tombstone the
  // account the device just joined.
  if (source === target) return { status: 200, body: { account_id: target } };
  const claimedBy = accountIdentity(db, source);
  if (claimedBy !== undefined && claimedBy !== identity.userId) {
    return { status: 409, body: { error: "account has another identity" } };
  }
  db.transaction(() => {
    moveDevices(db, source, target);
    revokeTopicTokens(db, source);
    tombstone(db, source, target);
  })();
  return { status: 200, body: { account_id: target } };
}

type AccountDeps = { db: Database.Database; clock: Clock; identities: IdentityResolver; mode: "selfhosted" | "relay" | "hosted" };

export function mountAccountRoutes(r: Hono<V1Env>, auth: MiddlewareHandler<V1Env>, deps: AccountDeps): void {
  // api.md §3.7: a self-hosted server has one operator, one ad_ token and no
  // accounts to sign in to. The routes are mounted purely to refuse, and with
  // 501 rather than 404 so a client can tell "this server does not do sign-in"
  // apart from "you typed the path wrong".
  if (deps.mode === "selfhosted") {
    const refuse = (path: string) => r.post(path, (c) => c.json({ error: "not supported in selfhosted mode" }, 501));
    refuse("/v1/account/link");
    refuse("/v1/account/merge");
    refuse("/v1/account/switch");
    return;
  }

  // S18. Mounted so the 409 {"error":"choose"} that link returns points at a
  // path that exists and says what it is, instead of a 404.
  r.post("/v1/account/merge", (c) => c.json({ error: "not implemented" }, 501));

  r.use("/v1/account/link", auth);
  r.use("/v1/account/switch", auth);

  r.post("/v1/account/link", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid request" }, 400); }
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const result = linkIdentity(deps.db, deps.clock, deps.identities, c.get("account").accountId, parsed.data.identity_token);
    return c.json(result.body, result.status);
  });

  r.post("/v1/account/switch", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid request" }, 400); }
    const parsed = switchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const result = switchAccount(deps.db, deps.identities, c.get("account").accountId, parsed.data.identity_token, parsed.data.into_account);
    return c.json(result.body, result.status);
  });
}
