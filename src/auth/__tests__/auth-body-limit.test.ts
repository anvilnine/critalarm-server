import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createAuthHandler } from "../better-auth.js";

// better-auth reads the body of every /api/auth/* request itself. Until the
// bounded reader sat in front of it, an unauthenticated POST of any size was
// held in memory before better-auth looked at it.

const BASE = "https://alerts.example.com";
const LIMIT = 16_384;

const config = loadConfig({
  BASE_URL: BASE,
  RELAY_URL: "https://relay.critalarm.app",
  DATA_DIR: "/tmp",
  ALLOW_NOOP_PUSH: "true",
  MODE: "relay",
  AUTH_SECRET: "a".repeat(32),
  AUTH_APPLE_CLIENT_ID: "app.example.signin",
  AUTH_APPLE_CLIENT_SECRET: "not-a-real-secret",
});

const appDeps = (db: ReturnType<typeof openDatabase>) => ({
  config,
  db,
  clock: { now: () => 1_760_000_000 },
  ids: { message: () => "m", incident: () => "i", timer: () => "t" },
  dispatch: async () => {},
});

// A handler that only records what reached it, for the limit itself.
const seen: { method: string; body: string; contentType: string | null }[] = [];
const recordingDb = openDatabase(":memory:");
migrate(recordingDb);
const recording = createApp({
  ...appDeps(recordingDb),
  authHandler: async (request: Request) => {
    seen.push({ method: request.method, body: await request.text(), contentType: request.headers.get("content-type") });
    return new Response("ok");
  },
});

// The real better-auth, with Apple configured, for the form_post callback.
const authDb = openDatabase(":memory:");
migrate(authDb);
const authHandler = createAuthHandler(config, authDb);
const real = createApp({ ...appDeps(authDb), ...(authHandler === undefined ? {} : { authHandler }) });

afterAll(() => { recordingDb.close(); authDb.close(); });

function stream(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(4096, bytes - sent)).fill(97);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

describe("the body limit in front of /api/auth/*", () => {
  it("refuses a Content-Length over the limit without calling better-auth", async () => {
    seen.length = 0;
    const response = await recording.request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(LIMIT + 1) },
      body: "x".repeat(LIMIT + 1),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request" });
    expect(seen).toEqual([]);
  });

  it("refuses a streamed body with no Content-Length once it passes the limit", async () => {
    seen.length = 0;
    const response = await recording.request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream(8 * 1024 * 1024),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("hands better-auth the same body when it is under the limit", async () => {
    seen.length = 0;
    const body = JSON.stringify({ provider: "apple", idToken: { token: "t".repeat(LIMIT - 100) } });
    const response = await recording.request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: "POST", body, contentType: "application/json" }]);
  });

  it("passes a GET on untouched", async () => {
    seen.length = 0;
    expect((await recording.request(`${BASE}/api/auth/get-session`)).status).toBe(200);
    expect(seen).toEqual([{ method: "GET", body: "", contentType: null }]);
  });

  // Apple answers a web sign-in with response_mode=form_post: a POST from
  // appleid.apple.com with a urlencoded body. better-auth turns it into a GET
  // on the same callback with the fields in the query, so the fields arriving
  // in that redirect show the form was read from the rebuilt request.
  it("still lets Apple's form_post callback through to better-auth", async () => {
    const form = new URLSearchParams({ code: "c-apple-code", state: "s-apple-state", user: JSON.stringify({ name: { firstName: "A", lastName: "B" } }) });
    const response = await real.request(`${BASE}/api/auth/callback/apple`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com" },
      body: form.toString(),
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", BASE);
    expect(location.pathname).toBe("/api/auth/callback/apple");
    expect(location.searchParams.get("code")).toBe("c-apple-code");
    expect(location.searchParams.get("state")).toBe("s-apple-state");
  });

  it("refuses an oversized form_post before better-auth reads it", async () => {
    const form = new URLSearchParams({ code: "c", state: "s", user: "u".repeat(LIMIT) });
    const response = await real.request(`${BASE}/api/auth/callback/apple`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com" },
      body: form.toString(),
    });
    expect(response.status).toBe(400);
  });
});
