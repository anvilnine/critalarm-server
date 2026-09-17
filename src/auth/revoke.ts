import type Database from "better-sqlite3";
import type { AuthConfig } from "../config.js";
import type { Clock } from "../incident/types.js";
import { appleProvider } from "./better-auth.js";

// api.md §3.7, the part of a delete that happens outside this server. Apple
// requires an app that uses Sign in with Apple to revoke the person's tokens
// when their account goes, and Google asks for the same. better-auth stores
// both providers' tokens in its `account` table, so this reads them there and
// tells the provider to drop them.
//
// Every call is best effort. A person must not be stuck holding an account
// because Apple is down, so a bad status or a dead connection is logged and the
// delete carries on. The log line carries the provider and the status, never a
// token: this repo is public and its logs get pasted into issues.

export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface TokenRevoker {
  revoke(userId: string): Promise<void>;
}

// What a server with no sign-in configured gets. There is nothing to revoke,
// so the delete goes straight to the database.
export const noTokenRevoker: TokenRevoker = { revoke: async () => {} };

type ProviderRow = { providerId: string; refreshToken: string | null; accessToken: string | null };

type AppleCredentials = { clientId: string; clientSecret: string };

function appleRequest(apple: AppleCredentials, token: string, hint: string): Request {
  return new Request(APPLE_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: apple.clientId, client_secret: apple.clientSecret, token, token_type_hint: hint }).toString(),
  });
}

function googleRequest(token: string): Request {
  return new Request(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

// `fetch` is injected the way RelayClient takes it, so a test never reaches the
// real Apple. The Apple credentials come from `appleProvider`, whose
// `clientSecret` getter runs the S22 minter, so a process that has been up for
// months revokes with a secret Apple still accepts.
export function providerTokenRevoker(db: Database.Database, auth: AuthConfig | undefined, clock: Clock, fetchImpl?: (request: Request) => Promise<Response>): TokenRevoker {
  if (auth === undefined) return noTokenRevoker;
  const apple = auth.apple === undefined ? undefined : appleProvider(auth.apple, clock);
  const call = fetchImpl ?? ((request: Request) => fetch(request));
  return {
    async revoke(userId: string): Promise<void> {
      const rows = db
        .prepare('SELECT "providerId" AS providerId, "refreshToken" AS refreshToken, "accessToken" AS accessToken FROM "account" WHERE "userId" = ?')
        .all(userId) as ProviderRow[];
      for (const row of rows) {
        // Apple wants the refresh token. The access token is the fallback for a
        // row written before the person ever came back, which has no refresh
        // token on it.
        const token = row.refreshToken ?? row.accessToken;
        if (token === null || token === "") continue;
        const hint = row.refreshToken === null ? "access_token" : "refresh_token";
        let request: Request | undefined;
        if (row.providerId === "apple" && apple !== undefined) request = appleRequest({ clientId: apple.clientId, clientSecret: apple.clientSecret }, token, hint);
        if (row.providerId === "google") request = googleRequest(token);
        // A provider whose credentials are gone from the configuration, or one
        // better-auth grew that this does not know. Nothing to call.
        if (request === undefined) continue;
        try {
          const response = await call(request);
          if (response.status >= 400) console.warn("provider_revoke_rejected", { provider: row.providerId, status: response.status });
        } catch {
          console.warn("provider_revoke_failed", { provider: row.providerId });
        }
      }
    },
  };
}
