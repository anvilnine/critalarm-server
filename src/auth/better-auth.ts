import { betterAuth } from "better-auth";
import type Database from "better-sqlite3";
import type { AppleAuthConfig, AuthConfig, Config } from "../config.js";
import type { Clock } from "../incident/types.js";
import { appleClientSecretMinter } from "./apple-client-secret.js";

// api.md §3.7 and accounts-plan §12. better-auth carries the OAuth flows,
// Google's OIDC, session storage and linking several identities to one user.
// Its `user`, `session` and `account` tables are the identity storage;
// migration 14 creates them.
//
// It does not mint or rotate Apple's client secret. It takes a `clientSecret`
// string and uses it as given, so `apple-client-secret.ts` does that job.
//
// Nothing here is mounted without credentials. The Apple and Google apps do not
// exist yet, and a server with no provider configured has to start and serve
// everything else, the same way STATS_KEY and RELAY_REGISTRATION_SECRET gate
// their surfaces. No placeholder credential, no crash.

export type AuthHandler = (request: Request) => Promise<Response>;

export function authIsConfigured(auth: AuthConfig | undefined): boolean {
  return auth !== undefined && (auth.apple !== undefined || auth.google !== undefined);
}

const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

// better-auth hands this object straight to its Apple provider and the provider
// reads `clientSecret` off it every time it talks to Apple, so a getter is what
// makes a minted secret re-mintable. A plain string would freeze whatever was
// minted at boot, and Apple refuses it once it expires.
export function appleProvider(apple: AppleAuthConfig, clock: Clock): { clientId: string; clientSecret: string; appBundleIdentifier?: string } {
  const credential = apple.credential;
  const secret = credential.kind === "secret"
    ? () => credential.clientSecret
    : appleClientSecretMinter(apple.clientId, credential.signingKey, clock);
  return {
    clientId: apple.clientId,
    get clientSecret() { return secret(); },
    ...(apple.appBundleIdentifier === undefined ? {} : { appBundleIdentifier: apple.appBundleIdentifier }),
  };
}

export function createAuthHandler(config: Config, db: Database.Database, clock: Clock = systemClock): AuthHandler | undefined {
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
      ...(auth.apple === undefined ? {} : { apple: appleProvider(auth.apple, clock) }),
      ...(auth.google === undefined ? {} : { google: { clientId: auth.google.clientId, clientSecret: auth.google.clientSecret } }),
    },
  });
  return (request: Request) => instance.handler(request);
}
