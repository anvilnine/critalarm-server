import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { AuthConfig } from "../../config.js";
import { APPLE_REVOKE_URL, GOOGLE_REVOKE_URL, noTokenRevoker, providerTokenRevoker } from "../revoke.js";

// api.md §3.7. Apple requires an app that carries Sign in with Apple to revoke
// the person's tokens when their account goes. Nothing here reaches Apple: the
// fetch is injected, the way RelayClient takes one.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const NOW = 1_760_000_000;
const CLOCK = { now: () => NOW };

function signingKey(): string {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function authWithApple(): AuthConfig {
  return {
    secret: "s".repeat(32),
    apple: { clientId: "app.critalarm.signin", credential: { kind: "key", signingKey: { teamId: "ABCDE12345", keyId: "FGHIJ67890", privateKey: signingKey() } } },
    google: { clientId: "google-client", clientSecret: "google-secret" },
  };
}

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (\'usr_1\', \'u\', \'u@example.com\', 0, 0, 0)').run();
  return db;
}

function addProvider(db: ReturnType<typeof openDatabase>, id: string, providerId: string, refreshToken: string | null, accessToken: string | null = null) {
  db.prepare('INSERT INTO "account" (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "createdAt", "updatedAt") VALUES (?, ?, ?, \'usr_1\', ?, ?, 0, 0)')
    .run(id, `${providerId}-subject`, providerId, accessToken, refreshToken);
}

function recorder() {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = async (request: Request) => {
    calls.push({ url: request.url, body: new URLSearchParams(await request.text()) });
    return new Response(null, { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("provider token revocation", () => {
  it("posts the refresh token and a minted client secret to Apple", async () => {
    const db = setup();
    addProvider(db, "oa_apple", "apple", "rt_apple");
    const { calls, fetchImpl } = recorder();

    await providerTokenRevoker(db, authWithApple(), CLOCK, fetchImpl).revoke("usr_1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(APPLE_REVOKE_URL);
    expect(calls[0]!.body.get("client_id")).toBe("app.critalarm.signin");
    expect(calls[0]!.body.get("token")).toBe("rt_apple");
    expect(calls[0]!.body.get("token_type_hint")).toBe("refresh_token");
    // The S22 minter signs it: header, claims and signature, with this server's
    // Services ID as the subject.
    const secret = calls[0]!.body.get("client_secret") ?? "";
    expect(secret.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(secret.split(".")[1]!, "base64url").toString())).toMatchObject({ iss: "ABCDE12345", sub: "app.critalarm.signin", aud: "https://appleid.apple.com", iat: NOW });
  });

  it("posts the token to Google", async () => {
    const db = setup();
    addProvider(db, "oa_google", "google", "rt_google");
    const { calls, fetchImpl } = recorder();

    await providerTokenRevoker(db, authWithApple(), CLOCK, fetchImpl).revoke("usr_1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GOOGLE_REVOKE_URL);
    expect(calls[0]!.body.get("token")).toBe("rt_google");
  });

  it("falls back to the access token when the row has no refresh token", async () => {
    const db = setup();
    addProvider(db, "oa_apple", "apple", null, "at_apple");
    const { calls, fetchImpl } = recorder();

    await providerTokenRevoker(db, authWithApple(), CLOCK, fetchImpl).revoke("usr_1");

    expect(calls[0]!.body.get("token")).toBe("at_apple");
    expect(calls[0]!.body.get("token_type_hint")).toBe("access_token");
  });

  it("skips a row with no token at all, and a provider it has no credentials for", async () => {
    const db = setup();
    addProvider(db, "oa_empty", "apple", null, null);
    addProvider(db, "oa_apple", "apple", "rt_apple");
    const { calls, fetchImpl } = recorder();

    // No Apple in the configuration, so the only callable row is skipped too.
    await providerTokenRevoker(db, { secret: "s".repeat(32) }, CLOCK, fetchImpl).revoke("usr_1");

    expect(calls).toEqual([]);
  });

  it("logs the provider and the status, never the token", async () => {
    const db = setup();
    addProvider(db, "oa_apple", "apple", "rt_secret_value");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await providerTokenRevoker(db, authWithApple(), CLOCK, async () => new Response("no", { status: 400 })).revoke("usr_1");
    await providerTokenRevoker(db, authWithApple(), CLOCK, async () => { throw new Error("connection reset"); }).revoke("usr_1");

    expect(warn.mock.calls.map((call) => call[0])).toEqual(["provider_revoke_rejected", "provider_revoke_failed"]);
    expect(warn.mock.calls[0]![1]).toEqual({ provider: "apple", status: 400 });
    expect(warn.mock.calls[1]![1]).toEqual({ provider: "apple" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("rt_secret_value");
    warn.mockRestore();
  });

  it("does nothing at all when sign-in is not configured", async () => {
    const db = setup();
    addProvider(db, "oa_apple", "apple", "rt_apple");
    let called = false;
    const revoker = providerTokenRevoker(db, undefined, CLOCK, async () => { called = true; return new Response(null, { status: 200 }); });

    await revoker.revoke("usr_1");
    await noTokenRevoker.revoke("usr_1");

    expect(called).toBe(false);
  });
});
