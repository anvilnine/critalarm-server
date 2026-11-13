import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { z } from "zod";
import { dateMillis, type IdentityResolver } from "../auth/identity.js";
import type { TokenRevoker } from "../auth/revoke.js";
import type { Clock } from "../incident/types.js";
import { textBody } from "../body-limit.js";
import type { V1Env } from "./auth.js";
import { accountFamily, accountIdentities, liveAccount, openIncident } from "./accounts.js";

// api.md §3.7, the ways to sign in that an account holds. One row per provider
// sign-in, which is one row of better-auth's `account` table, not one per
// better-auth user: a user who signs in with Apple and with Google under one
// verified address is two rows here.

// A session older than this cannot remove a way to sign in. A handset keeps
// its session for a long time, and a reinstalled iPhone still holds it.
export const RECENT_SIGN_IN_SECONDS = 300;

const APPLE_RELAY_DOMAIN = "privaterelay.appleid.com";

export const removeSchema = z.object({ identity_token: z.string().optional() });

type SignInRow = { rowId: string; providerId: "apple" | "google"; createdAt: string | number | null; email: string; userId: string; linkedAt: number };

export type SignIn = { id: string; rowId: string; userId: string; provider: "apple" | "google"; email: string; linkedAt: number };

export type IdentityView = {
  id: string;
  provider: "apple" | "google";
  email_hint?: string;
  email?: string;
  email_hidden: boolean;
  linked_at: number;
  current: boolean;
};

export type RemoveOutcome =
  | { status: 204 }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 403; body: { error: "recent sign-in required" } }
  | { status: 404; body: { error: "not found" } }
  | { status: 409; body: { error: "last identity" } }
  | { status: 409; body: { error: "live incident"; incident_id: string } };

// Opaque and stable. The better-auth row id names exactly one provider sign-in
// and never changes, and hashing it keeps the internal id off the wire.
function identityId(rowId: string): string {
  return `idn_${createHash("sha256").update(`identity:${rowId}`).digest("hex").slice(0, 32)}`;
}

// The first character of the local part, exactly three dots, then the whole
// domain. Three dots whatever the length, so the length of the local part is
// not recoverable from the hint.
export function emailHint(email: string): string {
  const at = email.lastIndexOf("@");
  const local = at < 0 ? email : email.slice(0, at);
  const first = Array.from(local)[0] ?? "";
  return at < 0 ? `${first}•••` : `${first}•••@${email.slice(at + 1)}`;
}

function isRelayAddress(email: string): boolean {
  const at = email.lastIndexOf("@");
  return at >= 0 && email.slice(at + 1).toLowerCase() === APPLE_RELAY_DOMAIN;
}

// Every provider sign-in of every identity on the account, oldest first.
//
// linked_at is when this way to sign in reached the account: the later of the
// identity joining the account and the provider sign-in being made. The first
// provider is made at sign-in, just before the identity joins, so that is the
// join time. A second provider that better-auth linked to the same user later
// is the time it was made.
export function accountSignIns(db: Database.Database, accountId: string): SignIn[] {
  const rows = db
    .prepare(
      `SELECT a."id" AS rowId, a."providerId" AS providerId, a."createdAt" AS createdAt, u."email" AS email, i.user_id AS userId, i.linked_at AS linkedAt
         FROM account_identities i
         JOIN "user" u ON u."id" = i.user_id
         JOIN "account" a ON a."userId" = i.user_id
        WHERE i.account_id = ? AND a."providerId" IN ('apple', 'google')`,
    )
    .all(accountId) as SignInRow[];
  return rows
    .map((row): SignIn => {
      const created = dateMillis(row.createdAt);
      const linkedAt = created === null ? row.linkedAt : Math.max(row.linkedAt, Math.floor(created / 1000));
      return { id: identityId(row.rowId), rowId: row.rowId, userId: row.userId, provider: row.providerId, email: row.email, linkedAt };
    })
    .sort((left, right) => left.linkedAt - right.linkedAt || left.id.localeCompare(right.id));
}

// What a device token alone learns is the hint. The address itself needs a
// live session of an identity on this account, and a header that is missing,
// bad or someone else's is read as no header, never as 401: a handset that has
// lost its session must still be able to say which account it is on.
export function listIdentities(db: Database.Database, identities: IdentityResolver, sourceAccount: string, identityToken: string | undefined): { identities: IdentityView[] } {
  const account = liveAccount(db, sourceAccount);
  const resolved = identityToken === undefined || identityToken === "" ? null : identities.resolve(identityToken);
  const current = resolved !== null && accountIdentities(db, account).includes(resolved.userId) ? resolved.userId : undefined;
  return {
    identities: accountSignIns(db, account).map((row): IdentityView => {
      const hidden = isRelayAddress(row.email);
      return {
        id: row.id,
        provider: row.provider,
        ...(hidden ? {} : { email_hint: emailHint(row.email) }),
        ...(hidden || current === undefined ? {} : { email: row.email }),
        email_hidden: hidden,
        linked_at: row.linkedAt,
        current: current !== undefined && row.userId === current,
      };
    }),
  };
}

function sessionOf(identities: IdentityResolver, token: string): { userId: string; createdAt: number | null } | null {
  if (identities.resolveSession !== undefined) return identities.resolveSession(token);
  const resolved = identities.resolve(token);
  return resolved === null ? null : { userId: resolved.userId, createdAt: null };
}

// api.md §3.7, the order the contract writes: the identity_token, its age, the
// id, the last identity, then a ringing alarm. The dv_ is checked by the
// middleware before any of this.
export async function removeIdentity(db: Database.Database, clock: Clock, identities: IdentityResolver, revoker: TokenRevoker, sourceAccount: string, identityToken: string | undefined, id: string): Promise<RemoveOutcome> {
  const account = liveAccount(db, sourceAccount);
  const session = identityToken === undefined || identityToken === "" ? null : sessionOf(identities, identityToken);
  if (session === null || !accountIdentities(db, account).includes(session.userId)) return { status: 401, body: { error: "unauthorized" } };
  // A session whose age cannot be read is not known to be recent.
  if (session.createdAt === null || clock.now() - session.createdAt > RECENT_SIGN_IN_SECONDS) {
    return { status: 403, body: { error: "recent sign-in required" } };
  }
  const signIns = accountSignIns(db, account);
  const target = signIns.find((row) => row.id === id);
  if (target === undefined) return { status: 404, body: { error: "not found" } };
  // Counted in provider sign-ins across the whole account, so one identity
  // holding Apple and Google can drop one of them.
  if (signIns.length <= 1) return { status: 409, body: { error: "last identity" } };
  const ringing = openIncident(db, accountFamily(db, account));
  if (ringing !== undefined) return { status: 409, body: { error: "live incident", incident_id: ringing } };

  // Before the delete, because the provider tokens have to still be readable,
  // and outside the transaction, because it is a network call. Best effort:
  // a provider being down never keeps a way to sign in on an account.
  try { await revoker.revoke(target.userId, target.rowId); } catch { console.warn("provider_revoke_failed", { provider: target.provider }); }

  db.transaction(() => {
    // The provider sign-in, which holds the provider tokens.
    db.prepare('DELETE FROM "account" WHERE "id" = ?').run(target.rowId);
    // Every session of the identity (api.md §3.7). A session does not record
    // which provider made it, so one made with the removed provider cannot be
    // told apart from the rest.
    db.prepare('DELETE FROM "session" WHERE "userId" = ?').run(target.userId);
    const left = (db.prepare('SELECT COUNT(*) AS count FROM "account" WHERE "userId" = ?').get(target.userId) as { count: number }).count;
    if (left === 0) {
      // No way to sign in is left, so the identity itself goes. "user" has no
      // foreign key from account_identities, so both rows are removed here.
      db.prepare("DELETE FROM account_identities WHERE user_id = ?").run(target.userId);
      db.prepare('DELETE FROM "user" WHERE "id" = ?').run(target.userId);
    }
  })();
  return { status: 204 };
}

type IdentityDeps = { db: Database.Database; clock: Clock; identities: IdentityResolver; revoke: TokenRevoker };

// Mounted by mountAccountRoutes, after it has put the dv_ middleware on both
// paths, and never in selfhosted mode, where both answer 501 there.
export function mountIdentityRoutes(r: Hono<V1Env>, deps: IdentityDeps): void {
  r.get("/v1/account/identities", (c) => c.json(listIdentities(deps.db, deps.identities, c.get("account").accountId, c.req.header("X-Identity-Token"))));

  r.delete("/v1/account/identities/:id", async (c) => {
    // A missing body is a missing identity_token, which the contract answers
    // with 401, so an empty request is not a 400.
    let raw: string;
    try { raw = await textBody(c.req.raw); } catch { return c.json({ error: "invalid request" }, 400); }
    let identityToken: string | undefined;
    if (raw.trim() !== "") {
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return c.json({ error: "invalid request" }, 400); }
      const parsed = removeSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "invalid request" }, 400);
      identityToken = parsed.data.identity_token;
    }
    const result = await removeIdentity(deps.db, deps.clock, deps.identities, deps.revoke, c.get("account").accountId, identityToken, c.req.param("id"));
    return result.status === 204 ? c.body(null, 204) : c.json(result.body, result.status);
  });
}
