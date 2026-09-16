import { betterAuth } from "better-auth";
import type Database from "better-sqlite3";
import type { AuthConfig, Config } from "../config.js";

// api.md §3.7 and accounts-plan §12. better-auth carries the OAuth flows,
// Apple's client-secret JWT rotation, Google's OIDC, session storage and
// linking several identities to one user. Its `user`, `session` and `account`
// tables are the identity storage; migration 14 creates them.
//
// Nothing here is mounted without credentials. The Apple and Google apps do not
// exist yet, and a server with no provider configured has to start and serve
// everything else, the same way STATS_KEY and RELAY_REGISTRATION_SECRET gate
// their surfaces. No placeholder credential, no crash.

export type AuthHandler = (request: Request) => Promise<Response>;

export function authIsConfigured(auth: AuthConfig | undefined): boolean {
  return auth !== undefined && (auth.apple !== undefined || auth.google !== undefined);
}

export function createAuthHandler(config: Config, db: Database.Database): AuthHandler | undefined {
  const auth = config.auth;
  if (!authIsConfigured(auth) || auth === undefined) return undefined;
  const instance = betterAuth({
    database: db,
    baseURL: config.baseUrl,
    secret: auth.secret,
    // better-auth's own Apple example requires this. Apple POSTs the
    // authorization response from appleid.apple.com rather than from this
    // server's origin, and without the origin on the list the callback is
    // rejected.
    trustedOrigins: ["https://appleid.apple.com"],
    account: {
      accountLinking: {
        enabled: true,
        // Apple hands back a private relay address and Google a real one for the
        // same person. Without this the two identities never join up and one
        // human ends up holding two accounts.
        allowDifferentEmails: true,
        trustedProviders: ["apple", "google"],
      },
    },
    socialProviders: {
      ...(auth.apple === undefined ? {} : { apple: {
        clientId: auth.apple.clientId,
        clientSecret: auth.apple.clientSecret,
        ...(auth.apple.appBundleIdentifier === undefined ? {} : { appBundleIdentifier: auth.apple.appBundleIdentifier }),
      } }),
      ...(auth.google === undefined ? {} : { google: { clientId: auth.google.clientId, clientSecret: auth.google.clientSecret } }),
    },
  });
  return (request: Request) => instance.handler(request);
}
