import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readBytes } from "../body-limit.js";
import type { Config } from "../config.js";
import { createApp } from "../index.js";
import { openDatabase } from "../store/database.js";
import { migrate } from "../store/migrations.js";

// A body that counts how many 4 KiB chunks the server pulls from it, so a test
// can tell a bounded read from one that took the whole body first.
function counting(chunks: number): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const chunk = new Uint8Array(4096).fill(0x61);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) { controller.close(); return; }
      pulled += 1;
      controller.enqueue(chunk.slice());
    },
  // No chunk is pulled ahead of a read, so the count is what the server read.
  }, { highWaterMark: 0 });
  return { body, pulled: () => pulled };
}

const EIGHT_MIB = 2048;

function streamed(method: string, headers: Record<string, string>, chunks = EIGHT_MIB) {
  const source = counting(chunks);
  const init = { method, headers, body: source.body, duplex: "half" } as RequestInit;
  return { init, pulled: source.pulled };
}

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const config: Config = { mode: "hosted", baseUrl: "https://alerts.example.com", relayUrl: "https://relay.example.com", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false, revenueCat: { sharedSecret: "rc-secret", entitlements: { ent: "hosted" } } };
  let id = 0;
  const app = createApp({ config, db, clock: { now: () => 1_000 }, ids: { message: () => `m_${++id}`, incident: () => `inc_${++id}`, timer: () => `tm_${++id}` }, dispatch: async () => ({ delivered: 0 }) });
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'hosted', 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, app_version, last_seen) VALUES ('dev_1', 'acc_1', ?, 'ios', 'ab', '1.0.0', 1)").run(createHash("sha256").update("dv_1").digest("hex"));
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 0, 10, 60, 30, 'none', 1)").run();
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
  return { app, db };
}

const TOO_LARGE = { code: 41301, http: 413, error: "message too large" };

describe("readBytes", () => {
  it("refuses a Content-Length over the limit without pulling anything", async () => {
    const source = counting(EIGHT_MIB);
    const request = new Request("http://x/", { method: "POST", headers: { "content-length": String(EIGHT_MIB * 4096) }, body: source.body, duplex: "half" } as RequestInit);
    expect(await readBytes(request, 4096)).toBe("too large");
    expect(source.pulled()).toBe(0);
  });

  it("stops pulling once the body passes the limit", async () => {
    const source = counting(EIGHT_MIB);
    const request = new Request("http://x/", { method: "POST", body: source.body, duplex: "half" } as RequestInit);
    expect(await readBytes(request, 4096)).toBe("too large");
    expect(source.pulled()).toBeLessThanOrEqual(2);
  });

  it("returns a body at the limit whole", async () => {
    const request = new Request("http://x/", { method: "POST", body: "a".repeat(4096) });
    expect((await readBytes(request, 4096) as Uint8Array).byteLength).toBe(4096);
  });
});

describe("publish bodies are read only up to 4096 bytes", () => {
  it("answers an unauthenticated 8 MiB POST / with 413 after at most two chunks", async () => {
    const { app } = setup();
    const { init, pulled } = streamed("POST", { "content-type": "application/json" });
    const response = await app.request("/", init);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(TOO_LARGE);
    expect(pulled()).toBeLessThanOrEqual(2);
  });

  it("answers POST / with a Content-Length of 8 MiB without reading the body", async () => {
    const { app } = setup();
    const { init, pulled } = streamed("POST", { "content-type": "application/json", "content-length": String(EIGHT_MIB * 4096) });
    const response = await app.request("/", init);
    expect(response.status).toBe(413);
    expect(pulled()).toBe(0);
  });

  it.each(["POST", "PUT"])("answers an 8 MiB %s /prod with 413 after at most two chunks", async (method) => {
    const { app } = setup();
    const { init, pulled } = streamed(method, { Authorization: "Bearer tk_test" });
    const response = await app.request("/prod", init);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(TOO_LARGE);
    expect(pulled()).toBeLessThanOrEqual(2);
  });

  it("answers an 8 MiB /v1/topics/prod/send with 413 and stops reading", async () => {
    const { app } = setup();
    const { init, pulled } = streamed("POST", { Authorization: "Bearer dv_1", "content-type": "application/json" });
    const response = await app.request("/v1/topics/prod/send", init);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(TOO_LARGE);
    expect(pulled()).toBeLessThanOrEqual(17);
  });
});

describe("message, title, tags and click have the 4096-byte limit too", () => {
  const big = "a".repeat(4097);
  const fits = "a".repeat(4096);
  const auth = { Authorization: "Bearer tk_test" };

  it.each([
    ["?m=", `/prod?m=${big}`, {}],
    ["?t=", `/prod?t=${big}`, {}],
    ["?ta=", `/prod?ta=${big}`, {}],
    ["X-Title", "/prod", { "X-Title": big }],
    ["X-Tags", "/prod", { "X-Tags": big }],
    ["X-Click", "/prod", { "X-Click": `https://x.example/${big}` }],
  ])("answers 413 for %s over 4096 bytes", async (_name, path, headers) => {
    const { app, db } = setup();
    const response = await app.request(path, { method: "POST", headers: { ...auth, ...headers }, body: "down" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(TOO_LARGE);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
  });

  it("accepts each of them at exactly 4096 bytes", async () => {
    const { app } = setup();
    expect((await app.request(`/prod?m=${fits}`, { method: "POST", headers: auth })).status).toBe(200);
    expect((await app.request("/prod", { method: "POST", headers: { ...auth, "X-Title": fits, "X-Tags": fits, "X-Click": fits }, body: "down" })).status).toBe(200);
  });

  it("counts the title on /v1/topics/{name}/send", async () => {
    const { app } = setup();
    const response = await app.request("/v1/topics/prod/send", { method: "POST", headers: { Authorization: "Bearer dv_1", "content-type": "application/json" }, body: JSON.stringify({ message: "down", title: big }) });
    expect(response.status).toBe(413);
  });
});

// Every other route that reads a JSON body. Over the limit is the same 400
// {"error":"invalid request"} as a body that is not JSON, the answer these
// routes and the relay routes already give.
describe("the other JSON routes read at most 16 KiB", () => {
  const dv = { Authorization: "Bearer dv_1", "content-type": "application/json" };
  const routes: [string, string, string, Record<string, string>][] = [
    ["register a device, no auth", "POST", "/relay/v1/devices", { "content-type": "application/json" }],
    ["update a device", "PATCH", "/relay/v1/devices/dev_1", dv],
    ["subscribe", "POST", "/relay/v1/devices/dev_1/subscriptions", dv],
    ["add a token", "POST", "/relay/v1/devices/dev_1/tokens", dv],
    ["switch the check", "PUT", "/relay/v1/devices/dev_1/check", dv],
    ["create a topic", "POST", "/v1/topics", dv],
    ["patch a topic", "PATCH", "/v1/topics/prod", dv],
    ["add a topic token", "POST", "/v1/topics/prod/tokens", dv],
    ["rename a topic token", "PATCH", "/v1/topics/prod/tokens/tok_1", dv],
    ["link", "POST", "/v1/account/link", dv],
    ["merge", "POST", "/v1/account/merge", dv],
    ["switch", "POST", "/v1/account/switch", dv],
    ["delete the account", "DELETE", "/v1/account", dv],
    ["RevenueCat webhook", "POST", "/webhooks/revenuecat", { Authorization: "Bearer rc-secret", "content-type": "application/json" }],
  ];

  it.each(routes)("%s: answers 400 and stops reading", async (_name, method, path, headers) => {
    const { app } = setup();
    const { init, pulled } = streamed(method, headers);
    const response = await app.request(path, init);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request" });
    // The webhook allows 256 KiB, the rest 16 KiB.
    expect(pulled()).toBeLessThanOrEqual(path === "/webhooks/revenuecat" ? 65 : 5);
  });

  it.each(routes)("%s: refuses a Content-Length over the limit without reading", async (_name, method, path, headers) => {
    const { app } = setup();
    const { init, pulled } = streamed(method, { ...headers, "content-length": String(EIGHT_MIB * 4096) });
    expect((await app.request(path, init)).status).toBe(400);
    expect(pulled()).toBe(0);
  });

  it("reads an oversized check receipt as no notes and stops reading", async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at, closed_at, attempts, result) VALUES ('rnd_1', 'dev_1', 'h', 900, 90000, NULL, 1, NULL)").run();
    const { init, pulled } = streamed("POST", { Authorization: "Bearer dv_1", "content-type": "application/json" });
    const response = await app.request("/relay/v1/devices/dev_1/checks/rnd_1/receipt", init);
    expect(response.status).not.toBe(500);
    expect(pulled()).toBeLessThanOrEqual(5);
  });
});
