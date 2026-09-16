import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { authIsConfigured, createAuthHandler } from "../better-auth.js";
import { sessionIdentityResolver } from "../identity.js";

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BASE_URL: "https://alerts.example.com",
    RELAY_URL: "https://relay.critalarm.app",
    DATA_DIR: "/tmp",
    ALLOW_NOOP_PUSH: "true",
    ...extra,
  };
}

// The Apple and Google apps do not exist yet. A server with no credential has
// to start and serve everything else, exactly as it does with no STATS_KEY.
describe("sign-in credentials", () => {
  it("are absent from the config when unset, and the server still loads", () => {
    const config = loadConfig(env());
    expect(config.auth).toBeUndefined();
    expect(authIsConfigured(config.auth)).toBe(false);
  });

  it("build no handler when unset", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(createAuthHandler(loadConfig(env()), db)).toBeUndefined();
    db.close();
  });

  it("are refused when only half a provider pair is set", () => {
    expect(() => loadConfig(env({ APPLE_CLIENT_ID: "app.id" }))).toThrow("invalid configuration: APPLE sign-in credentials");
    expect(() => loadConfig(env({ GOOGLE_CLIENT_SECRET: "s" }))).toThrow("invalid configuration: GOOGLE sign-in credentials");
  });

  it("are refused without AUTH_SECRET, because a session cannot be signed", () => {
    expect(() => loadConfig(env({ APPLE_CLIENT_ID: "app.id", APPLE_CLIENT_SECRET: "s" }))).toThrow("invalid configuration: AUTH_SECRET");
  });

  it("are read from the environment when whole", () => {
    const config = loadConfig(env({
      AUTH_SECRET: "a".repeat(32),
      APPLE_CLIENT_ID: "app.critalarm.signin",
      APPLE_CLIENT_SECRET: "apple-jwt",
      APPLE_APP_BUNDLE_IDENTIFIER: "app.critalarm",
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
    }));
    expect(config.auth).toEqual({
      secret: "a".repeat(32),
      apple: { clientId: "app.critalarm.signin", clientSecret: "apple-jwt", appBundleIdentifier: "app.critalarm" },
      google: { clientId: "google-id", clientSecret: "google-secret" },
    });
    expect(authIsConfigured(config.auth)).toBe(true);
  });

  it("build a handler when one provider is whole", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const config = loadConfig(env({ AUTH_SECRET: "a".repeat(32), GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }));
    expect(createAuthHandler(config, db)).toBeInstanceOf(Function);
    db.close();
  });
});

// better-auth writes `session.expiresAt` through Kysely into a column with
// SQLite `date` affinity, and what comes back depends on the driver: an ISO
// string or an epoch number. Both are read, and anything unreadable counts as
// expired rather than as a session that never ends.
describe("the identity resolver", () => {
  const seed = (expiresAt: string | number | null) => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, 0, 0)').run("usr_1", "one", "one@example.com");
    db.prepare('INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, 0, 0, ?)').run("ses_1", expiresAt, "sess_1", "usr_1");
    return { db, resolver: sessionIdentityResolver(db, { now: () => 1_760_000_000 }) };
  };

  it("reads an ISO expiry", () => {
    const { db, resolver } = seed("2099-01-01T00:00:00.000Z");
    expect(resolver.resolve("sess_1")).toEqual({ userId: "usr_1" });
    db.close();
  });

  it("reads an epoch-seconds expiry", () => {
    const { db, resolver } = seed(1_760_000_100);
    expect(resolver.resolve("sess_1")).toEqual({ userId: "usr_1" });
    db.close();
  });

  it("reads an epoch-milliseconds expiry", () => {
    const { db, resolver } = seed(1_760_000_100_000);
    expect(resolver.resolve("sess_1")).toEqual({ userId: "usr_1" });
    db.close();
  });

  it("treats an expired, unreadable or missing session as no identity", () => {
    const expired = seed("2000-01-01T00:00:00.000Z");
    expect(expired.resolver.resolve("sess_1")).toBeNull();
    expired.db.close();
    const unreadable = seed("whenever");
    expect(unreadable.resolver.resolve("sess_1")).toBeNull();
    expect(unreadable.resolver.resolve("sess_missing")).toBeNull();
    expect(unreadable.resolver.resolve("")).toBeNull();
    unreadable.db.close();
  });
});
