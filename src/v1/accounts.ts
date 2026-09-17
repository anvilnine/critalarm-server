import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { IdentityResolver } from "../auth/identity.js";
import type { TokenRevoker } from "../auth/revoke.js";
import type { Clock } from "../incident/types.js";
import { highestEntitledTier, isHigherTier } from "../tier/revenuecat.js";
import { sweepDeviceIntoTopics, sweepTopicIntoDevices } from "../tier/subscriptions.js";
import type { Tier } from "../tier/types.js";
import type { V1Env } from "./auth.js";

// api.md §3.7. Signing in does not create an account. Registration already made
// one (§4.2) and it has owned topics, devices and billing ever since. These
// routes attach a human identity to an account that exists, and in one case move
// a handset from one existing account to another.

export const linkSchema = z.object({ identity_token: z.string().min(1) });
export const switchSchema = z.object({ identity_token: z.string().min(1), into_account: z.string().min(1) });
export const mergeSchema = z.object({ identity_token: z.string().min(1), into_account: z.string().min(1) });
// The delete body is optional: an account with no identity is erased on the
// dv_ alone, and that call has nothing to put in a body.
export const deleteSchema = z.object({ identity_token: z.string().min(1).optional() });

export type LinkOutcome =
  | { status: 200; body: { account_id: string; outcome: "claimed" | "attached" } }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 409; body: { error: "choose"; into_account: string; topics: number; incidents: number } }
  | { status: 409; body: { error: "account has another identity" } };

export type SwitchOutcome =
  | { status: 200; body: { account_id: string } }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 409; body: { error: "account has another identity" } };

export type MergeOutcome =
  | { status: 200; body: { account_id: string; merged_from: string } }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 409; body: { error: "already merged" } }
  | { status: 409; body: { error: "same account" } }
  | { status: 409; body: { error: "live incident"; incident_id: string } };

export type DeleteOutcome =
  | { status: 204 }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 409; body: { error: "live incident"; incident_id: string } };

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

// A merge blocks on `acked` as well as `open`, which the erase further down
// does not. The erase must never trap somebody in an account they asked to
// leave; a merge is optional, so it can wait. And it has to wait:
// incidents_one_active_per_topic (src/store/migrations.ts) is unique on
// topic_id where the state is open or acked, so two topics that each carry an
// active incident cannot be folded into one row at all. Refusing before the
// transaction opens is what keeps that from ever being attempted.
function activeIncident(db: Database.Database, family: string[]): string | undefined {
  const marks = family.map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT id FROM incidents WHERE state IN ('open', 'acked') AND topic_id IN (SELECT id FROM topics WHERE account_id IN (${marks})) LIMIT 1`)
    .get(...family) as { id: string } | undefined;
  return row?.id;
}

function mergedInto(db: Database.Database, accountId: string): string | null {
  const row = db.prepare("SELECT merged_into FROM accounts WHERE id = ?").get(accountId) as { merged_into: string | null } | undefined;
  return row === undefined ? null : row.merged_into;
}

export interface MergeCounts {
  devices: number;
  topics_repointed: number;
  topics_folded: number;
  tokens_repointed: number;
  incidents: number;
  messages: number;
  billing_ids: number;
  tier_before: Tier;
  tier_after: Tier;
}

// api.md §3.7, the fold. Everything the source owns arrives on the target and
// the source becomes a tombstone. Topics are merged row by row and never
// renamed: authenticateTopic matches on the topic name (src/ingress/auth.ts) so
// a rename answers 401 to every live tk_, and topic_hash is derived from the
// name (src/v1/topics.ts) so a rename also changes the hash every device is
// subscribed to. Both failures are silent: the webhook keeps publishing and
// nobody is paged.
export function mergeAccounts(db: Database.Database, clock: Clock, identities: IdentityResolver, sourceAccount: string, identityToken: string, intoAccount: string): MergeOutcome {
  const identity = identities.resolve(identityToken);
  if (identity === null) return { status: 401, body: { error: "unauthorized" } };
  // Both ends, the same pair switchAccount checks: the token resolves to an
  // identity, and that identity owns the account named in the body.
  const target = identityAccount(db, identity.userId);
  if (target === undefined || target !== liveAccount(db, intoAccount)) return { status: 401, body: { error: "unauthorized" } };
  const source = liveAccount(db, sourceAccount);
  // The contract does not spell this one out. A source account carrying a
  // different identity would hand one person's topics and history to another,
  // and this credential does not carry that authority, so it is the same 401
  // switchAccount already answers for "this identity does not own that account".
  const claimedBy = accountIdentity(db, source);
  if (claimedBy !== undefined && claimedBy !== identity.userId) return { status: 401, body: { error: "unauthorized" } };

  // Read merged_into off the rows themselves, before liveAccount resolves it
  // forward. Either side already being a tombstone is "already merged", and
  // resolving first would quietly turn that into a merge of the survivors.
  if (mergedInto(db, sourceAccount) !== null || mergedInto(db, intoAccount) !== null) {
    return { status: 409, body: { error: "already merged" } };
  }
  if (source === target) return { status: 409, body: { error: "same account" } };
  const ringing = activeIncident(db, [...accountFamily(db, source), ...accountFamily(db, target)]);
  if (ringing !== undefined) return { status: 409, body: { error: "live incident", incident_id: ringing } };

  // No device cap check. insertDeviceForAccount is the only place caps.devices
  // is enforced and a repoint never reaches it. That is deliberate: a merge is
  // not somebody asking for another handset, and refusing it here would leave a
  // person with two accounts and no way to join them.
  db.transaction(() => {
    // Every tombstone that pointed at the source now points at the target, so
    // no chain ever grows past one hop.
    db.prepare("UPDATE accounts SET merged_into = ? WHERE merged_into = ?").run(target, source);

    // Topics before devices. moveDevices re-sweeps each handset against the
    // target's topics, and running it first would sweep against a set the
    // source's topics had not joined yet.
    const counts: MergeCounts = { devices: 0, topics_repointed: 0, topics_folded: 0, tokens_repointed: 0, incidents: 0, messages: 0, billing_ids: 0, tier_before: "free", tier_after: "free" };
    const topics = db.prepare("SELECT id, name, topic_hash FROM topics WHERE account_id = ?").all(source) as { id: string; name: string; topic_hash: string }[];
    for (const topic of topics) {
      // Hash or name, because topics carries both UNIQUE (account_id, name) and
      // UNIQUE (account_id, topic_hash). Two topics called prod made under
      // different base_url values have different hashes and the same name, so
      // matching on the hash alone would repoint one into the other's account
      // and trip the name index.
      const survivor = db.prepare("SELECT id FROM topics WHERE account_id = ? AND (topic_hash = ? OR name = ?)").get(target, topic.topic_hash, topic.name) as { id: string } | undefined;
      if (survivor === undefined) {
        db.prepare("UPDATE topics SET account_id = ? WHERE id = ?").run(target, topic.id);
        // The target's own handsets hold no subscription for a topic that has
        // only just arrived, and without this they would not ring for it.
        sweepTopicIntoDevices(db, target, topic.topic_hash);
        counts.topics_repointed += 1;
        continue;
      }
      // topic_tokens.hash is globally unique and carries no account, so a
      // repointed token keeps publishing with no re-issue.
      counts.tokens_repointed += db.prepare("UPDATE topic_tokens SET topic_id = ? WHERE topic_id = ?").run(survivor.id, topic.id).changes;
      counts.incidents += db.prepare("UPDATE incidents SET topic_id = ? WHERE topic_id = ?").run(survivor.id, topic.id).changes;
      counts.messages += db.prepare("UPDATE messages SET topic_id = ? WHERE topic_id = ?").run(survivor.id, topic.id).changes;
      db.prepare("DELETE FROM topics WHERE id = ?").run(topic.id);
      counts.topics_folded += 1;
    }

    counts.devices = (db.prepare("SELECT COUNT(*) AS count FROM devices WHERE account_id = ?").get(source) as { count: number }).count;
    moveDevices(db, source, target);

    counts.billing_ids = db.prepare("UPDATE account_billing_ids SET account_id = ? WHERE account_id = ?").run(target, source).changes;
    counts.tier_before = (db.prepare("SELECT tier FROM accounts WHERE id = ?").get(target) as { tier: Tier }).tier;
    // The highest of both accounts' subscriptions, never last write wins.
    //
    // A merge only ever raises a tier. The recompute reads account_billing_ids
    // and nothing else, so an account that is paid but holds no row there comes
    // back as free, and an unrelated merge must not be the thing that takes
    // somebody's subscription away. tier_after is what the account ends on, so
    // it stays at tier_before whenever the write is skipped.
    const recomputed = highestEntitledTier({ db }, target);
    counts.tier_after = isHigherTier(recomputed, counts.tier_before) ? recomputed : counts.tier_before;
    if (counts.tier_after !== counts.tier_before) {
      // A tier_changes row like any other, with a null event_id because no
      // webhook caused it.
      db.prepare("UPDATE accounts SET tier = ? WHERE id = ?").run(counts.tier_after, target);
      db.prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(`tch_${randomUUID()}`, target, counts.tier_before, counts.tier_after, `merge from ${source}`, null, clock.now());
    }

    // relay_p4_usage is keyed on (account_id, day_start), so a plain repoint
    // aborts as soon as both accounts have sent a priority 4 today. The counts
    // add up instead, and then the source's rows go.
    db.prepare(
      `INSERT INTO relay_p4_usage (account_id, day_start, count)
         SELECT ?, day_start, count FROM relay_p4_usage WHERE account_id = ?
         ON CONFLICT(account_id, day_start) DO UPDATE SET count = count + excluded.count`,
    ).run(target, source);
    db.prepare("DELETE FROM relay_p4_usage WHERE account_id = ?").run(source);

    // Never deleted. Four tables cascade off accounts(id), and a dv_ or an
    // app_user_id still naming the old id has to resolve forward.
    tombstone(db, source, target);

    // This moved rows across five tables and cannot be undone. The audit row is
    // the only thing that answers a support question about it later.
    db.prepare("INSERT INTO account_merges (id, from_account, into_account, merged_at, detail) VALUES (?, ?, ?, ?, ?)")
      .run(`mrg_${randomUUID()}`, source, target, clock.now(), JSON.stringify(counts));
  })();
  return { status: 200, body: { account_id: target, merged_from: source } };
}

// api.md §3.7, the erase. Every account id that goes with `accountId`: the
// account itself and every tombstone whose merged_into chain ends at it. A
// tombstone still owns rows (a switch leaves its topics behind), so leaving one
// would leave a dead tenant holding topics nobody can reach.
function accountFamily(db: Database.Database, accountId: string): string[] {
  const family = [accountId];
  for (let hop = 0; hop < 8; hop += 1) {
    const marks = family.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT id FROM accounts WHERE merged_into IN (${marks})`).all(...family) as { id: string }[];
    const found = rows.map((row) => row.id).filter((id) => !family.includes(id));
    if (found.length === 0) break;
    family.push(...found);
  }
  return family;
}

export interface DeleteCounts {
  accounts: number;
  devices: number;
  topics: number;
  incidents: number;
  messages: number;
  identities: number;
  billingEventsCleared: number;
}

// The whole erase, in one transaction, shared by DELETE /v1/account and
// `critalarm account delete`. Neither the live-incident check nor the identity
// check is in here: the route does both, and the operator command does neither.
//
// Most of the tree goes by cascade from accounts: devices (and device_tokens,
// which hang off devices the same way), topics with their tokens, incidents,
// timers, messages, subscriptions, relay_p4_usage, account_billing_ids and
// account_identities. What does not cascade is handled by hand below.
export function deleteAccount(db: Database.Database, accountId: string): DeleteCounts {
  const family = accountFamily(db, liveAccount(db, accountId));
  const marks = family.map(() => "?").join(", ");
  const count = (sql: string): number => (db.prepare(sql).get(...family) as { count: number }).count;
  return db.transaction((): DeleteCounts => {
    // account_identities cascades with the account, so the better-auth user has
    // to be read while the map still exists. It carries no foreign key back to
    // "user" (migrations.ts), so nothing would take that row otherwise.
    const users = (db.prepare(`SELECT user_id FROM account_identities WHERE account_id IN (${marks})`).all(...family) as { user_id: string }[]).map((row) => row.user_id);
    const counts: DeleteCounts = {
      accounts: count(`SELECT COUNT(*) AS count FROM accounts WHERE id IN (${marks})`),
      devices: count(`SELECT COUNT(*) AS count FROM devices WHERE account_id IN (${marks})`),
      topics: count(`SELECT COUNT(*) AS count FROM topics WHERE account_id IN (${marks})`),
      incidents: count(`SELECT COUNT(*) AS count FROM incidents WHERE topic_id IN (SELECT id FROM topics WHERE account_id IN (${marks}))`),
      messages: count(`SELECT COUNT(*) AS count FROM messages WHERE topic_id IN (SELECT id FROM topics WHERE account_id IN (${marks}))`),
      identities: users.length,
      billingEventsCleared: count(`SELECT COUNT(*) AS count FROM billing_events WHERE account_id IN (${marks})`),
    };
    // tier_changes.account_id references accounts with no ON DELETE, so the
    // account delete below fails while these rows are here.
    db.prepare(`DELETE FROM tier_changes WHERE account_id IN (${marks})`).run(...family);
    // billing_events has the same missing ON DELETE, but the rows stay: they
    // are the dedup log, and a webhook arriving after the delete must still
    // find its event id and apply nothing (api.md §4.3).
    db.prepare(`UPDATE billing_events SET account_id = NULL WHERE account_id IN (${marks})`).run(...family);
    db.prepare(`DELETE FROM account_merges WHERE from_account IN (${marks}) OR into_account IN (${marks})`).run(...family, ...family);
    // Tombstones first. accounts.merged_into points at the survivor and has no
    // ON DELETE either, so deleting the survivor while a tombstone still names
    // it breaks the foreign key. accountFamily lists the survivor first, so the
    // reverse of that order takes the deepest tombstone first.
    for (const id of [...family].reverse()) db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    // The better-auth user, which cascades its "session" and "account" rows.
    // The OAuth tokens live in "account".
    for (const user of users) db.prepare('DELETE FROM "user" WHERE id = ?').run(user);
    return counts;
  })();
}

// The operator command takes an account id or the sign-in email, and both end
// at one live account. A tombstone id resolves forward, so a support request
// quoting an old id still erases the account that survived it.
export function findAccount(db: Database.Database, given: { id: string } | { email: string }): string | undefined {
  if ("email" in given) {
    const row = db
      .prepare('SELECT i.account_id AS accountId FROM account_identities i JOIN "user" u ON u.id = i.user_id WHERE u.email = ?')
      .get(given.email) as { accountId: string } | undefined;
    return row === undefined ? undefined : liveAccount(db, row.accountId);
  }
  const row = db.prepare("SELECT id FROM accounts WHERE id = ?").get(given.id) as { id: string } | undefined;
  return row === undefined ? undefined : liveAccount(db, row.id);
}

// Only an `open` incident blocks. An `acked` one does not: nothing is ringing,
// and a person must never be stuck unable to leave. The tombstones are searched
// too, because their topics can still be publishing.
function openIncident(db: Database.Database, family: string[]): string | undefined {
  const marks = family.map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT id FROM incidents WHERE state = 'open' AND topic_id IN (SELECT id FROM topics WHERE account_id IN (${marks})) LIMIT 1`)
    .get(...family) as { id: string } | undefined;
  return row?.id;
}

export async function deleteAccountRequest(db: Database.Database, identities: IdentityResolver, revoker: TokenRevoker, sourceAccount: string, identityToken: string | undefined): Promise<DeleteOutcome> {
  const account = liveAccount(db, sourceAccount);
  const claimedBy = accountIdentity(db, account);
  // An account with no identity goes on the dv_ alone: every device on it holds
  // the same authority, the way every device can already delete a topic. One
  // with an identity needs that identity as well, so a handset left in a drawer
  // cannot wipe a signed-in account.
  if (claimedBy !== undefined) {
    const identity = identityToken === undefined ? null : identities.resolve(identityToken);
    if (identity === null || identity.userId !== claimedBy) return { status: 401, body: { error: "unauthorized" } };
  }
  const ringing = openIncident(db, accountFamily(db, account));
  if (ringing !== undefined) return { status: 409, body: { error: "live incident", incident_id: ringing } };
  // Outside the transaction and before it, because it is a network call and the
  // provider tokens have to still be readable. It never blocks the delete.
  if (claimedBy !== undefined) await revoker.revoke(claimedBy);
  deleteAccount(db, account);
  return { status: 204 };
}

type AccountDeps = { db: Database.Database; clock: Clock; identities: IdentityResolver; revoke: TokenRevoker; mode: "selfhosted" | "relay" | "hosted" };

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
    r.delete("/v1/account", (c) => c.json({ error: "not supported in selfhosted mode" }, 501));
    return;
  }

  r.use("/v1/account/link", auth);
  r.use("/v1/account/merge", auth);
  r.use("/v1/account/switch", auth);
  r.use("/v1/account", auth);

  r.post("/v1/account/link", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid request" }, 400); }
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const result = linkIdentity(deps.db, deps.clock, deps.identities, c.get("account").accountId, parsed.data.identity_token);
    return c.json(result.body, result.status);
  });

  r.post("/v1/account/merge", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid request" }, 400); }
    const parsed = mergeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const result = mergeAccounts(deps.db, deps.clock, deps.identities, c.get("account").accountId, parsed.data.identity_token, parsed.data.into_account);
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

  r.delete("/v1/account", async (c) => {
    // No body at all is the normal call for an account nobody has signed in to,
    // so an empty request is read as "no identity token" rather than refused.
    const raw = await c.req.text();
    let identityToken: string | undefined;
    if (raw.trim() !== "") {
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return c.json({ error: "invalid request" }, 400); }
      const parsed = deleteSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid request" }, 400);
      identityToken = parsed.data.identity_token;
    }
    const result = await deleteAccountRequest(deps.db, deps.identities, deps.revoke, c.get("account").accountId, identityToken);
    return result.status === 204 ? c.body(null, 204) : c.json(result.body, result.status);
  });
}
