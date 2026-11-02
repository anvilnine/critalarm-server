import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import { credentialHash } from "../../tier/auth.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { ProxyTrust } from "../../rate-limit.js";

// api.md §1.8: POST /{topic}, POST /v1/topics/{name}/send and POST /v1/test
// are one publish window, 30 calls per rolling 60 s per client address.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } }) as never;
const OVER = { code: 42901, http: 429, error: "rate limited" };

function setup(behindProxy: ProxyTrust = false) {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  db.prepare("INSERT INTO accounts(id,tier,created_at) VALUES ('a','free',1)").run();
  db.prepare("INSERT INTO devices(id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','push',1)").run(credentialHash("dv_a"));
  const clock = { value: 1_000, now() { return this.value; } };
  let id = 0;
  const app = createApp({ db, config: { mode: "hosted", baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "full", listen: ":8080", port: 8080, dataDir: "/data", behindProxy }, clock, ids: { message: () => `m_${++id}`, incident: () => `inc_${++id}`, timer: () => `tm_${++id}` }, dispatch: async () => {} });
  const headers = { Authorization: "Bearer dv_a" };
  return { app, clock, headers, ready: (async () => ((await app.request("/v1/topics", { method: "POST", headers, body: JSON.stringify({ name: "prod", critical: true }) }, peer("192.0.2.200"))).json() as Promise<{ token: string }>).then((t) => t.token))() };
}

describe("publish window shared by publish, send and test", () => {
  it("counts the three routes in one bucket and answers 42901 over 30", async () => {
    const { app, headers, ready } = setup();
    const token = await ready;
    const publish = () => app.request("/prod", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "x" }, peer("192.0.2.1"));
    const send = () => app.request("/v1/topics/prod/send", { method: "POST", headers, body: JSON.stringify({ message: "x", priority: 3 }) }, peer("192.0.2.1"));
    const test = () => app.request("/v1/test?topic=prod", { method: "POST", headers }, peer("192.0.2.1"));
    for (let i = 0; i < 10; i += 1) {
      expect((await publish()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect((await test()).status).toBe(200);
    }
    for (const route of [publish, send, test]) {
      const over = await route();
      expect(over.status).toBe(429);
      expect(await over.json()).toEqual(OVER);
    }
    // Another client address has a bucket of its own.
    expect((await app.request("/v1/topics/prod/send", { method: "POST", headers, body: JSON.stringify({ message: "x", priority: 3 }) }, peer("192.0.2.2"))).status).toBe(200);
  });

  it("send alone trips at 30 and the window rolls on the clock", async () => {
    const { app, clock, headers, ready } = setup();
    await ready;
    const send = () => app.request("/v1/topics/prod/send", { method: "POST", headers, body: JSON.stringify({ message: "x", priority: 3 }) }, peer("192.0.2.1"));
    for (let i = 0; i < 30; i += 1) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    clock.value += 59;
    expect((await send()).status).toBe(429);
    clock.value += 1;
    expect((await send()).status).toBe(200);
  });

  it("test alone trips at 30 and answers 42901", async () => {
    const { app, headers, ready } = setup();
    await ready;
    const test = () => app.request("/v1/test?topic=prod", { method: "POST", headers }, peer("192.0.2.1"));
    for (let i = 0; i < 30; i += 1) expect((await test()).status).toBe(200);
    const over = await test();
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual(OVER);
  });

  it("counts the client address behind-proxy names, so a typed X-Forwarded-For does not move the bucket", async () => {
    const { app, headers, ready } = setup(1);
    await ready;
    const send = (forwarded: string) => app.request("/v1/topics/prod/send", { method: "POST", headers: { ...headers, "x-forwarded-for": forwarded }, body: JSON.stringify({ message: "x", priority: 3 }) }, peer("10.0.0.1"));
    for (let i = 0; i < 30; i += 1) expect((await send(`198.51.100.${i}, 203.0.113.7`)).status).toBe(200);
    expect((await send("198.51.100.99, 203.0.113.7")).status).toBe(429);
    expect((await send("203.0.113.8")).status).toBe(200);
  });
});
