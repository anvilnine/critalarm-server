import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createAuthHandler } from "../better-auth.js";

// better-auth links a social sign-in to an existing user whose email matches.
// For a provider on accountLinking.trustedProviders it skips the incoming
// email_verified claim, so with google on that list a Google ID token that says
// email_verified=false for somebody else's address signed in as that person.
//
// No network: Google's signing keys are a key made here, served by a stubbed
// fetch, and every other URL is refused.

const BASE = "https://alerts.example.com";
const CLIENT_ID = "client.example.test";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function googleIdToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT_ID, iat: now, exp: now + 600, ...claims }));
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
  AUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
  AUTH_GOOGLE_CLIENT_SECRET: "not-a-real-secret",
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
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return Response.json({ keys: [jwk] });
    throw new Error(`no network in this test: ${url}`);
  });
});
afterAll(() => { vi.unstubAllGlobals(); db.close(); });
afterEach(() => { db.prepare('DELETE FROM "account" WHERE providerId = \'google\'').run(); });

// An existing person who signed up with Apple, whose address is verified.
const stamp = new Date().toISOString();
db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, 1, NULL, ?, ?)').run("u_victim", "Victim", "victim@example.com", stamp, stamp);
db.prepare('INSERT INTO "account" (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("a_apple", "apple-sub-victim", "apple", "u_victim", stamp, stamp);

async function googleSignIn(emailVerified: boolean): Promise<{ status: number; userId: string | undefined }> {
  const token = googleIdToken({ sub: "google-sub-other", email: "victim@example.com", email_verified: emailVerified, name: "Somebody" });
  const response = await app.request(`${BASE}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ provider: "google", idToken: { token } }),
  });
  const body = await response.json() as { user?: { id?: string } };
  return { status: response.status, userId: body.user?.id };
}

const googleRows = () => db.prepare('SELECT userId FROM "account" WHERE providerId = \'google\'').all();

describe("Google sign-in and an existing user with the same email", () => {
  it("does not link a Google identity whose email is not verified", async () => {
    const result = await googleSignIn(false);
    expect(result.status).not.toBe(200);
    expect(result.userId).toBeUndefined();
    expect(googleRows()).toEqual([]);
  });

  it("still links one whose email Google has verified", async () => {
    const result = await googleSignIn(true);
    expect(result).toEqual({ status: 200, userId: "u_victim" });
    expect(googleRows()).toEqual([{ userId: "u_victim" }]);
  });
});
