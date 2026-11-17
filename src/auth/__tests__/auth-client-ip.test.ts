import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { AUTH_CLIENT_IP_HEADER, createAuthHandler } from "../better-auth.js";

// better-auth's rate limiter counts per client address. Left to itself it
// reads X-Forwarded-For, trusts it only when it holds exactly one address, and
// otherwise counts every request in one shared bucket per path, where its
// sign-in rule allows 3 calls in 10 seconds. With no proxy there is no such
// header, and behind a proxy that appends, a caller who sends their own makes
// two: four sign-ins from anybody then turned everybody away. The server now
// hands better-auth the address its own limits count, in a header it sets.

const BASE = "https://alerts.example.com";

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    BASE_URL: BASE,
    RELAY_URL: "https://relay.critalarm.app",
    DATA_DIR: "/tmp",
    ALLOW_NOOP_PUSH: "true",
    MODE: "relay",
    AUTH_SECRET: "a".repeat(32),
    AUTH_APPLE_CLIENT_ID: "app.example.signin",
    AUTH_APPLE_CLIENT_SECRET: "not-a-real-secret",
    ...extra,
  });
}

const databases: ReturnType<typeof openDatabase>[] = [];
function database() {
  const db = openDatabase(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}
afterAll(() => { for (const db of databases) db.close(); });

const deps = (cfg: ReturnType<typeof config>, db: ReturnType<typeof openDatabase>) => ({
  config: cfg,
  db,
  clock: { now: () => 1_760_000_000 },
  ids: { message: () => "m", incident: () => "i", timer: () => "t" },
  dispatch: async () => {},
});

// The env @hono/node-server passes, with the socket the request came in on.
const peer = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

function recordingApp(cfg: ReturnType<typeof config>) {
  const seen: { address: string | null; body: string }[] = [];
  const app = createApp({
    ...deps(cfg, database()),
    authHandler: async (request: Request) => {
      seen.push({ address: request.headers.get(AUTH_CLIENT_IP_HEADER), body: await request.text() });
      return new Response("ok");
    },
  });
  return { app, seen };
}

describe("the client address /api/auth/* hands to better-auth", () => {
  it("is the socket peer when no proxy is trusted, and the body still arrives", async () => {
    const { app, seen } = recordingApp(config());
    await app.request(`${BASE}/api/auth/sign-in/social`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"provider\":\"apple\"}" }, peer("203.0.113.7"));
    expect(seen).toEqual([{ address: "203.0.113.7", body: "{\"provider\":\"apple\"}" }]);
  });

  it("replaces a value the caller sent, and ignores their X-Forwarded-For", async () => {
    const { app, seen } = recordingApp(config());
    await app.request(`${BASE}/api/auth/get-session`, { headers: { [AUTH_CLIENT_IP_HEADER]: "198.51.100.1", "x-forwarded-for": "198.51.100.2" } }, peer("203.0.113.7"));
    expect(seen.map((row) => row.address)).toEqual(["203.0.113.7"]);
  });

  it("follows BEHIND_PROXY=cloudflare the way every other limit does", async () => {
    const { app, seen } = recordingApp(config({ BEHIND_PROXY: "cloudflare" }));
    await app.request(`${BASE}/api/auth/get-session`, { headers: { "cf-connecting-ip": "192.0.2.44", "x-forwarded-for": "198.51.100.2, 192.0.2.44" } }, peer("10.0.0.2"));
    expect(seen.map((row) => row.address)).toEqual(["192.0.2.44"]);
  });

  it("follows BEHIND_PROXY=1, the right-most X-Forwarded-For entry", async () => {
    const { app, seen } = recordingApp(config({ BEHIND_PROXY: "1" }));
    await app.request(`${BASE}/api/auth/get-session`, { headers: { "x-forwarded-for": "198.51.100.2, 192.0.2.44" } }, peer("10.0.0.2"));
    expect(seen.map((row) => row.address)).toEqual(["192.0.2.44"]);
  });

  it("sets nothing when there is no address to give, and still drops the caller's value", async () => {
    const { app, seen } = recordingApp(config());
    await app.request(`${BASE}/api/auth/get-session`, { headers: { [AUTH_CLIENT_IP_HEADER]: "198.51.100.1" } });
    expect(seen.map((row) => row.address)).toEqual([null]);
  });
});

describe("better-auth's sign-in limit, counted per client", () => {
  const cfg = config();
  const db = database();
  const handler = createAuthHandler(cfg, db, undefined, { rateLimit: true });
  if (handler === undefined) throw new Error("auth handler not built");
  const app = createApp({ ...deps(cfg, db), authHandler: handler });

  const signIn = (address: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ provider: "apple", idToken: { token: "not-a-token" } }),
    }, peer(address));

  it("turns away the fourth call in ten seconds from one address and nobody else", async () => {
    for (let call = 0; call < 3; call += 1) expect((await signIn("203.0.113.7")).status).not.toBe(429);
    expect((await signIn("203.0.113.7")).status).toBe(429);
    // A second client is untouched by the first one's calls.
    expect((await signIn("203.0.113.8")).status).not.toBe(429);
  });

  it("cannot be stepped around with a made-up address", async () => {
    expect((await signIn("203.0.113.7", { [AUTH_CLIENT_IP_HEADER]: "198.51.100.9" })).status).toBe(429);
    expect((await signIn("203.0.113.7", { "x-forwarded-for": "198.51.100.10" })).status).toBe(429);
  });
});
