import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { DeliveryEvent } from "../domain-events.js";
import { createApp } from "../index.js";
import { relayKeyHash } from "../relay/client.js";
import { topicHash } from "../relay/hash.js";
import { createRelayRouter } from "../relay/router.js";
import { Counters } from "../stats/counters.js";
import { openDatabase } from "../store/database.js";
import { migrate } from "../store/migrations.js";

// api.md §4.2: caps.p4_daily is counted across the whole account. A free
// account is capped at 50 priority-4 messages a day.
const NOW = 1_760_000_000;
const DAY_START = Math.floor(NOW / 86_400) * 86_400;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function server(mode: NonNullable<Config["mode"]>, tier: "free" | "hosted" = "free") {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = { now: () => NOW };
  const dispatch = vi.fn(async (_events: readonly DeliveryEvent[]) => ({ delivered: 1 }));
  let id = 0;
  const config: Config = { mode, baseUrl: "https://alerts.example.com", relayUrl: "https://relay.example.com", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false };
  const app = createApp({ config, db, clock, ids: { message: () => `m_${++id}`, incident: () => `inc_${++id}`, timer: () => `tm_${++id}` }, dispatch });
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', ?, 1)").run(tier);
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_1', 'acc_1', ?, 'ios', 'ab', 1)").run(sha("dv_1"));
  for (const [topic, token] of [["prod", "tk_prod"], ["staging", "tk_staging"]] as const) {
    db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES (?, 'acc_1', ?, 'https://alerts.example.com', ?, 1, 10, 60, 30, 'none', 1)").run(`top_${topic}`, topic, `hash_${topic}`);
    db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES (?, ?, ?, 1)").run(`tok_${topic}`, `top_${topic}`, sha(token));
  }
  // A new client address per call, so the publish rate limit (30 a minute per
  // client) is not what answers.
  let client = 0;
  const from = () => ({ incoming: { socket: { remoteAddress: `10.0.${Math.floor(++client / 200)}.${client % 200}` } } }) as never;
  const p4 = (topic: "prod" | "staging" = "prod") => app.request(`/${topic}`, { method: "POST", headers: { Authorization: `Bearer tk_${topic}`, Priority: "4" }, body: "disk at 90%" }, from());
  const usage = () => db.prepare("SELECT count FROM relay_p4_usage WHERE account_id = 'acc_1' AND day_start = ?").get(DAY_START);
  const messages = () => (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count;
  return { app, db, dispatch, p4, usage, messages, from };
}

describe("p4_daily on a direct publish", () => {
  it.each(["hosted", "relay"] as const)("%s mode: the 51st priority-4 publish of the day answers 429 and is neither stored nor sent", async (mode) => {
    const { app, dispatch, p4, usage, messages, from } = server(mode);
    for (let n = 0; n < 50; n += 1) expect((await p4(n % 2 === 0 ? "prod" : "staging")).status).toBe(200);
    expect(usage()).toEqual({ count: 50 });
    const over = await p4();
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "cap", cap: "p4_daily" });
    expect(messages()).toBe(50);
    expect(dispatch).toHaveBeenCalledTimes(50);
    expect(usage()).toEqual({ count: 50 });

    const json = await app.request("/", { method: "POST", headers: { Authorization: "Bearer tk_prod", "content-type": "application/json" }, body: JSON.stringify({ topic: "prod", message: "x", priority: 4 }) }, from());
    expect(json.status).toBe(429);
    const send = await app.request("/v1/topics/prod/send", { method: "POST", headers: { Authorization: "Bearer dv_1", "content-type": "application/json" }, body: JSON.stringify({ message: "x", priority: 4 }) });
    expect(send.status).toBe(429);
    expect(await send.json()).toEqual({ error: "cap", cap: "p4_daily" });
    expect(messages()).toBe(50);
  });

  it("never caps priority 5, and lower priorities are not counted", async () => {
    const { app, db, usage } = server("hosted");
    db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES ('acc_1', ?, 50)").run(DAY_START);
    expect((await app.request("/prod", { method: "POST", headers: { Authorization: "Bearer tk_prod", Priority: "5" }, body: "down" })).status).toBe(200);
    expect((await app.request("/prod", { method: "POST", headers: { Authorization: "Bearer tk_prod", Priority: "3" }, body: "fyi" })).status).toBe(200);
    expect(usage()).toEqual({ count: 50 });
  });

  it("uses the tier's own cap", async () => {
    const { db, p4 } = server("hosted", "hosted");
    db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES ('acc_1', ?, 999)").run(DAY_START);
    expect((await p4()).status).toBe(200);
    expect((await p4()).status).toBe(429);
  });

  it("counts nothing and caps nothing on a self-hosted server", async () => {
    const { p4, usage } = server("selfhosted");
    for (let n = 0; n < 51; n += 1) expect((await p4()).status).toBe(200);
    expect(usage()).toBeUndefined();
  });
});

describe("p4_daily on a relayed push", () => {
  function relay() {
    const db = openDatabase(":memory:");
    migrate(db);
    const base = "https://alerts.example.com";
    const hash = topicHash(base, "prod");
    db.prepare("INSERT INTO relay_servers (id, base_url, version, relay_key_hash, created_at, legacy) VALUES ('r', ?, '1', ?, 1, 0)").run(base, relayKeyHash("rk_test"));
    for (const account of ["acc_capped", "acc_open"]) {
      db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(account);
      db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, ?, ?, 'ios', 'ab', 1)").run(`dev_${account}`, account, sha(account));
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?, ?)").run(`dev_${account}`, hash);
    }
    db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES ('acc_capped', ?, 50)").run(DAY_START);
    const rung: string[] = [];
    const app = createRelayRouter(db, async (event) => { rung.push(event.accountId ?? ""); return { delivered: 1 }; }, new Counters(db, { now: () => NOW }), { clock: { now: () => NOW } });
    const push = () => app.request("/relay/v1/push", { method: "POST", headers: { Authorization: "Bearer rk_test" }, body: JSON.stringify({ topic_hash: hash, topic: "prod", incident_id: null, message_id: "m_1", priority: 4, kind: "p4" }) });
    const usage = (account: string) => db.prepare("SELECT count FROM relay_p4_usage WHERE account_id = ?").get(account);
    return { db, push, rung, usage };
  }

  it("rings only the accounts still under their cap and charges only those", async () => {
    const { push, rung, usage } = relay();
    for (let n = 0; n < 3; n += 1) expect((await push()).status).toBe(202);
    expect(rung).toEqual(["acc_open", "acc_open", "acc_open"]);
    expect(usage("acc_capped")).toEqual({ count: 50 });
    expect(usage("acc_open")).toEqual({ count: 3 });
  });

  it("answers 429 and rings nobody once every subscribed account is at its cap", async () => {
    const { db, push, rung } = relay();
    db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES ('acc_open', ?, 50)").run(DAY_START);
    const response = await push();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "cap", cap: "p4_daily" });
    expect(rung).toEqual([]);
  });
});
