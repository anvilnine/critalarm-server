import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";

// api.md §3.7. The `identity_token` in the body of an account route is a
// better-auth session token, issued by this server's own /api/auth surface, not
// by Apple or Google. Resolving it means turning that token into the
// better-auth user behind it.
//
// This is the seam. The default reads better-auth's own `session` table, so the
// real path is exercised by seeding a session row, and a test that does not care
// about better-auth's schema can pass its own resolver to createApp instead.
export interface IdentityResolver {
  resolve(identityToken: string): { userId: string } | null;
}

type SessionRow = { userId: string; expiresAt: string | number | null };

// better-auth stores the session token in `session.token` as it was issued, so a
// lookup by value is enough. `expiresAt` has SQLite `date` affinity and
// better-auth writes it through Kysely, so it comes back as either an epoch
// number or an ISO string depending on the driver's binding. Both are handled
// rather than guessed at.
function expiryMillis(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function sessionIdentityResolver(db: Database.Database, clock: Clock): IdentityResolver {
  return {
    resolve(identityToken: string): { userId: string } | null {
      if (identityToken === "") return null;
      const row = db
        .prepare('SELECT "userId" AS userId, "expiresAt" AS expiresAt FROM "session" WHERE "token" = ?')
        .get(identityToken) as SessionRow | undefined;
      if (row === undefined) return null;
      const expires = expiryMillis(row.expiresAt);
      // An unreadable expiry is treated as expired. Erring the other way would
      // turn a storage surprise into a session that never ends.
      if (expires === null || expires <= clock.now() * 1000) return null;
      return { userId: row.userId };
    },
  };
}
