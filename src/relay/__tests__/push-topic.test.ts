import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayRouter } from "../router.js";
import { relayKeyHash } from "../client.js";
import { topicHash } from "../hash.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate, migrationCount } from "../../store/migrations.js";
import { PushDispatcher } from "../../push/dispatcher.js";
import type { PushSender } from "../../push/types.js";

const A = "https://a.example.com";
const B = "https://b.example.com";
const CHALLENGE = "z".repeat(40);

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

// Servers A and B register through the real route with a confirmer that says
// yes, and the real PushDispatcher sits behind the push route. Each of the
// three accounts has one device, subscribed to the hash its own topic has.
async function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const sent: string[] = [];
  const sender: PushSender = { send: async (device) => { sent.push(device.id); return { status: 200, stale: false }; } };
  const dispatcher = new PushDispatcher(db, { apns: sender, fcm: sender });
  let clock = 1_800_000_000;
  const app = createRelayRouter(db, async (event) => dispatcher.dispatch([event]), new Counters(db, { now: () => 1 }), { behindProxy: true, confirmChallenge: async () => true, clock: { now: () => clock } });
  async function register(baseUrl: string): Promise<string> {
    clock += 61;
    const response = await app.request("/relay/v1/servers", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.114.1" }, body: JSON.stringify({ base_url: baseUrl, version: "1", challenge: CHALLENGE }) });
    return (await response.json() as { relay_key: string }).relay_key;
  }
  for (const [account, device] of [["acc_a", "dev_a"], ["acc_b", "dev_b"], ["acc_h", "dev_h"]] as const) {
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES (?,'hosted',1)").run(account);
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES (?,?,?,'ios',?,1)").run(device, account, `h_${device}`, `t_${device}`);
  }
  const subscribe = (device: string, hash: string) => db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?,?)").run(device, hash);
  const push = (key: string, fields: Record<string, unknown>) => app.request("/relay/v1/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ incident_id: "inc_1", message_id: "m_1", priority: 5, kind: "open", ...fields }),
  });
  return { db, app, sent, register, subscribe, push };
}

describe("a relay key pushes only its own server's topics", () => {
  it("refuses server A pushing the hash of B's topic, and B's device receives nothing", async () => {
    const { db, sent, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      await register(B);
      const hashB = topicHash(B, "prod");
      subscribe("dev_b", hashB);

      const response = await push(keyA, { topic_hash: hashB, topic: "prod" });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "topic mismatch" });
      expect(sent).toEqual([]);
    } finally { db.close(); }
  });

  it("refuses A when it names a topic that resembles B's host and name", async () => {
    const { db, sent, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      const hashB = topicHash(B, "prod");
      subscribe("dev_b", hashB);
      expect((await push(keyA, { topic_hash: hashB, topic: "b_example_com_prod" })).status).toBe(403);
      expect(sent).toEqual([]);
    } finally { db.close(); }
  });

  it("keeps A's and B's topics named prod apart, and never reaches a hosted account's topic of that name", async () => {
    const { db, sent, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      const keyB = await register(B);
      subscribe("dev_a", topicHash(A, "prod"));
      subscribe("dev_b", topicHash(B, "prod"));
      const hostedHash = topicHash("https://relay.critalarm.app", "prod");
      db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_h','acc_h','prod','https://relay.critalarm.app',?,1,30,60,30,'none',1)").run(hostedHash);
      subscribe("dev_h", hostedHash);

      expect((await push(keyA, { topic_hash: topicHash(A, "prod"), topic: "prod" })).status).toBe(202);
      expect(sent).toEqual(["dev_a"]);
      expect((await push(keyB, { topic_hash: topicHash(B, "prod"), topic: "prod" })).status).toBe(202);
      expect(sent).toEqual(["dev_a", "dev_b"]);
      // The hosted account's hash is not any registered server's hash.
      expect((await push(keyA, { topic_hash: hostedHash, topic: "prod" })).status).toBe(403);
      expect((await push(keyB, { topic_hash: hostedHash, topic: "prod" })).status).toBe(403);
      expect(sent).toEqual(["dev_a", "dev_b"]);
    } finally { db.close(); }
  });

  it("answers 400 to a new key that sends no topic", async () => {
    const { db, sent, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      subscribe("dev_a", topicHash(A, "prod"));
      const response = await push(keyA, { topic_hash: topicHash(A, "prod") });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
      expect(sent).toEqual([]);
    } finally { db.close(); }
  });

  it.each([["a slash", "prod/x"], ["a dot", "prod.x"], ["a space", "a b"], ["65 characters", "a".repeat(65)], ["an empty name", ""], ["a number", 7]])("answers 400 to a topic with %s", async (_name, topic) => {
    const { db, sent, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      subscribe("dev_a", topicHash(A, "prod"));
      expect((await push(keyA, { topic_hash: topicHash(A, "prod"), topic })).status).toBe(400);
      expect(sent).toEqual([]);
    } finally { db.close(); }
  });

  it("accepts a topic of 64 characters from the allowed set", async () => {
    const { db, sent, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      const name = `${"A_-".repeat(21)}z`;
      expect(name).toHaveLength(64);
      subscribe("dev_a", topicHash(A, name));
      expect((await push(keyA, { topic_hash: topicHash(A, name), topic: name })).status).toBe(202);
      expect(sent).toEqual(["dev_a"]);
    } finally { db.close(); }
  });

  it("answers 401 to a key that was replaced and to a key nobody issued", async () => {
    const { db, register, push } = await setup();
    try {
      const first = await register(A);
      const second = await register(A);
      const body = { topic_hash: topicHash(A, "prod"), topic: "prod" };
      expect((await push(first, body)).status).toBe(401);
      expect((await push("rk_nobody", body)).status).toBe(401);
      expect((await push(second, body)).status).toBe(202);
    } finally { db.close(); }
  });

  it("checks topic before the p4 cap counts anything", async () => {
    const { db, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      subscribe("dev_b", topicHash(B, "prod"));
      const response = await push(keyA, { topic_hash: topicHash(B, "prod"), topic: "prod", kind: "p4", priority: 4, incident_id: null });
      expect(response.status).toBe(403);
      expect(db.prepare("SELECT count(*) AS rows FROM relay_p4_usage").get()).toEqual({ rows: 0 });
    } finally { db.close(); }
  });

  it("does not log or store the topic name", async () => {
    const { db, register, subscribe, push } = await setup();
    try {
      const keyA = await register(A);
      subscribe("dev_a", topicHash(A, "very-private-name"));
      await push(keyA, { topic_hash: topicHash(A, "very-private-name"), topic: "very-private-name" });
      await push(keyA, { topic_hash: topicHash(B, "very-private-name"), topic: "very-private-name" });
      expect((log.mock.calls as unknown[][]).map((call) => String(call[0])).join("\n")).not.toContain("very-private-name");
      const dump = JSON.stringify(db.prepare("SELECT * FROM relay_servers").all()) + JSON.stringify(db.prepare("SELECT * FROM subscriptions").all());
      expect(dump).not.toContain("very-private-name");
    } finally { db.close(); }
  });

  it("puts no topic on the event handed to dispatch", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc_a','hosted',1)").run();
      db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_a','acc_a','h','ios','t',1)").run();
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_a',?)").run(topicHash(A, "prod"));
      db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at,legacy) VALUES ('r',?,'1',?,1,0)").run(A, relayKeyHash("rk_new"));
      const events: { topic: string }[] = [];
      const app = createRelayRouter(db, async (event) => { events.push(event); }, new Counters(db, { now: () => 1 }));
      await app.request("/relay/v1/push", { method: "POST", headers: { Authorization: "Bearer rk_new" }, body: JSON.stringify({ topic_hash: topicHash(A, "prod"), topic: "prod", incident_id: "i", message_id: "m", priority: 5, kind: "open" }) });
      expect(events).toHaveLength(1);
      expect(events[0]?.topic).toBe("");
    } finally { db.close(); }
  });
});

describe("a key issued before 1.20.0", () => {
  async function legacy() {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc_a','hosted',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_a','acc_a','h','ios','t',1)").run();
    db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_a',?)").run(topicHash(A, "prod"));
    // legacy = 1 is what the migration gives a row that existed before 1.20.0.
    db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at,legacy) VALUES ('r',?,'1',?,1,1)").run(A, relayKeyHash("rk_old"));
    const sent: string[] = [];
    const sender: PushSender = { send: async (device) => { sent.push(device.id); return { status: 200, stale: false }; } };
    const dispatcher = new PushDispatcher(db, { apns: sender, fcm: sender });
    const app = createRelayRouter(db, async (event) => dispatcher.dispatch([event]), new Counters(db, { now: () => 1 }));
    const push = (fields: Record<string, unknown>) => app.request("/relay/v1/push", { method: "POST", headers: { Authorization: "Bearer rk_old" }, body: JSON.stringify({ incident_id: "i", message_id: "m", priority: 5, kind: "open", ...fields }) });
    return { db, sent, push };
  }

  it("still pushes without topic", async () => {
    const { db, sent, push } = await legacy();
    try {
      expect((await push({ topic_hash: topicHash(A, "prod") })).status).toBe(202);
      expect(sent).toEqual(["dev_a"]);
    } finally { db.close(); }
  });

  it("checks topic when it is sent", async () => {
    const { db, sent, push } = await legacy();
    try {
      expect((await push({ topic_hash: topicHash(B, "prod"), topic: "prod" })).status).toBe(403);
      expect((await push({ topic_hash: topicHash(A, "prod"), topic: "pro.d" })).status).toBe(400);
      expect((await push({ topic_hash: topicHash(A, "prod"), topic: "prod" })).status).toBe(202);
      expect(sent).toEqual(["dev_a"]);
    } finally { db.close(); }
  });

  it("is what the migration makes of every row that existed before it, even rows sharing a base_url", () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db, migrationCount - 1);
      const insert = db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at) VALUES (?,?,'1',?,1)");
      insert.run("r1", A, "k1");
      insert.run("r2", A, "k2");
      migrate(db);
      expect(db.prepare("SELECT id, legacy FROM relay_servers ORDER BY id").all()).toEqual([{ id: "r1", legacy: 1 }, { id: "r2", legacy: 1 }]);
      const fresh = db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at) VALUES (?,?,'1',?,1)");
      fresh.run("r3", A, "k3");
      expect(db.prepare("SELECT legacy FROM relay_servers WHERE id = 'r3'").get()).toEqual({ legacy: 0 });
      expect(() => fresh.run("r4", A, "k4")).toThrow();
    } finally { db.close(); }
  });
});
