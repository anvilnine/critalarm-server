import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createAuthHandler } from "../better-auth.js";

// The Apple half of google-link.test.ts. With apple on
// accountLinking.trustedProviders, better-auth linked an Apple identity to an
// existing user with the same email without reading Apple's email_verified.
// Apple documents email_verified false for some Sign in with Apple at Work &
// School users, so such a token for somebody else's address signed in as them.
//
// No network: Apple's signing keys are a key made here, served by a stubbed
// fetch, and every other URL is refused.

const BASE = "https://alerts.example.com";
const CLIENT_ID = "app.example.signin";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "a1", alg: "RS256", use: "sig" };

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function appleIdToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "a1", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: "https://appleid.apple.com", aud: CLIENT_ID, iat: now, exp: now + 600, ...claims }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

const db = openDatabase(":memory:");
migrate(db);
const config = loadConfig({
  BASE_URL: BASE,
  RELAY_URL: "https://relay.critalarm.app",
  DATA_DIR: "/tmp",
  ALLOW_NOOP_PUSH: "true",
  MODE: "relay",
  AUTH_SECRET: "a".repeat(32),
  AUTH_APPLE_CLIENT_ID: CLIENT_ID,
  AUTH_APPLE_CLIENT_SECRET: "not-a-real-secret",
});
const authHandler = createAuthHandler(config, db);
const app = createApp({
  config,
  db,
  clock: { now: () => Math.floor(Date.now() / 1000) },
  ids: { message: () => "m", incident: () => "i", timer: () => "t" },
  dispatch: async () => {},
  ...(authHandler === undefined ? {} : { authHandler }),
});

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://appleid.apple.com/auth/keys")) return Response.json({ keys: [jwk] });
    throw new Error(`no network in this test: ${url}`);
  });
});
afterAll(() => { vi.unstubAllGlobals(); db.close(); });
afterEach(() => { db.prepare('DELETE FROM "account" WHERE providerId = \'apple\'').run(); });

// An existing person who signed up with Google, whose address is verified.
const stamp = new Date().toISOString();
db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, 1, NULL, ?, ?)').run("u_victim", "Victim", "victim@example.com", stamp, stamp);
db.prepare('INSERT INTO "account" (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("a_google", "google-sub-victim", "google", "u_victim", stamp, stamp);

// Apple sends email_verified as the string "true" or "false" in some tokens
// and as a boolean in others. better-auth reads both.
async function appleSignIn(emailVerified: boolean | "true" | "false"): Promise<{ status: number; userId: string | undefined }> {
  const token = appleIdToken({ sub: "apple-sub-other", email: "victim@example.com", email_verified: emailVerified });
  const response = await app.request(`${BASE}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ provider: "apple", idToken: { token } }),
  });
  const body = await response.json() as { user?: { id?: string } };
  return { status: response.status, userId: body.user?.id };
}

const appleRows = () => db.prepare('SELECT userId FROM "account" WHERE providerId = \'apple\'').all();

describe("Apple sign-in and an existing user with the same email", () => {
  it.each([false, "false"] as const)("does not link an Apple identity whose email_verified is %s", async (value) => {
    const result = await appleSignIn(value);
    expect(result.status).not.toBe(200);
    expect(result.userId).toBeUndefined();
    expect(appleRows()).toEqual([]);
  });

  // The flow api.md §3.7 describes since 1.14.0: Google on one phone, Apple
  // on another, one account. It rests on this implicit link, which is why
  // disableImplicitLinking stays off.
  it.each([true, "true"] as const)("still links one whose email_verified is %s", async (value) => {
    const result = await appleSignIn(value);
    expect(result).toEqual({ status: 200, userId: "u_victim" });
    expect(appleRows()).toEqual([{ userId: "u_victim" }]);
  });
});
