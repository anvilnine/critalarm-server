import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSelfHostedIdentity } from "../admin/credentials.js";
import type { Config } from "../config.js";
import { createApp } from "../index.js";
import { PushDispatcher } from "../push/dispatcher.js";
import type { PushDevice, PushResult, PushSender } from "../push/types.js";
import { openDatabase } from "../store/database.js";
import { migrate } from "../store/migrations.js";
import { sweepDeviceIntoTopics, sweepTopicIntoDevices } from "../tier/subscriptions.js";

class RecordingSender implements PushSender {
  readonly tokens: string[] = [];
  async send(device: PushDevice): Promise<PushResult> {
    this.tokens.push(device.pushToken);
    return { status: 200, stale: false };
  }
}

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(mode?: Config["mode"]) {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  const apns = new RecordingSender();
  const fcm = new RecordingSender();
  const dispatcher = new PushDispatcher(db, { apns, fcm }, { now: () => 1_000 });
  let messages = 0; let incidents = 0; let timers = 0;
  const app = createApp({
    config: { mode, baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
    db,
    clock: { now: () => 1_000 },
    ids: { message: () => `m_${++messages}`, incident: () => `inc_${++incidents}`, timer: () => `tm_${++timers}` },
    dispatch: (events) => dispatcher.dispatch(events),
  });
  return { app, db, apns, fcm };
}

type App = ReturnType<typeof setup>["app"];
type Db = ReturnType<typeof openDatabase>;

const deviceOne = "dev_123e4567-e89b-12d3-a456-426614174001";
const deviceTwo = "dev_123e4567-e89b-12d3-a456-426614174002";

function hashOf(name: string): string {
  return createHash("sha256").update(`https://alerts.example.com/${name}`).digest("hex");
}

function register(app: App, deviceId: string, platform: "ios" | "android", pushToken: string, joinWith?: string) {
  return app.request("/relay/v1/devices", {
    method: "POST",
    headers: { "content-type": "application/json", ...(joinWith === undefined ? {} : { Authorization: `Bearer ${joinWith}` }) },
    body: JSON.stringify({ device_id: deviceId, platform, push_token: pushToken, app_version: "1.0.0" }),
  });
}

async function registerFirst(app: App): Promise<string> {
  const response = await register(app, deviceOne, "ios", "ios-one");
  expect(response.status).toBe(201);
  return (await response.json() as { device_token: string }).device_token;
}

async function makeTopic(app: App, deviceToken: string, name: string): Promise<string> {
  const response = await app.request("/v1/topics", {
    method: "POST",
    headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, critical: true }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { token: string }).token;
}

function subscribe(app: App, deviceId: string, deviceToken: string, topicHash: string) {
  return app.request(`/relay/v1/devices/${deviceId}/subscriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ topic_hash: topicHash }),
  });
}

function publish(app: App, name: string, topicToken: string) {
  return app.request(`/${name}`, { method: "POST", headers: { Authorization: `Bearer ${topicToken}`, Priority: "5" }, body: "db01 is down" });
}

function accountOf(db: Db): string {
  return (db.prepare("SELECT id FROM accounts").get() as { id: string }).id;
}

function rows(db: Db) {
  return db.prepare("SELECT account_id, device_id, topic_hash FROM subscriptions ORDER BY device_id, topic_hash").all();
}

function expectRows(db: Db, accountId: string, pairs: [string, string][]) {
  const expected = pairs
    .map(([device_id, topic_hash]) => ({ account_id: accountId, device_id, topic_hash }))
    .sort((a, b) => (a.device_id === b.device_id ? (a.topic_hash < b.topic_hash ? -1 : 1) : a.device_id < b.device_id ? -1 : 1));
  expect(rows(db)).toEqual(expected);
}

describe("subscription sweep", () => {
  it("gives a device joining an account a row for every topic it already has, and rings it", async () => {
    const { app, db, apns, fcm } = setup();
    const first = await registerFirst(app);
    db.prepare("UPDATE accounts SET tier = 'relay'").run();
    const prodToken = await makeTopic(app, first, "prod");
    await makeTopic(app, first, "staging");

    expect((await register(app, deviceTwo, "android", "android-two", first)).status).toBe(201);

    expectRows(db, accountOf(db), [
      [deviceOne, hashOf("prod")], [deviceOne, hashOf("staging")],
      [deviceTwo, hashOf("prod")], [deviceTwo, hashOf("staging")],
    ]);
    expect((await publish(app, "prod", prodToken)).status).toBe(200);
    expect(apns.tokens).toEqual(["ios-one"]);
    expect(fcm.tokens).toEqual(["android-two"]);
  });

  it("gives every device on the account a row when a topic is created, and rings them all", async () => {
    const { app, db, apns, fcm } = setup();
    const first = await registerFirst(app);
    db.prepare("UPDATE accounts SET tier = 'relay'").run();
    expect((await register(app, deviceTwo, "android", "android-two", first)).status).toBe(201);
    expect(rows(db)).toEqual([]);

    const prodToken = await makeTopic(app, first, "prod");

    expectRows(db, accountOf(db), [[deviceOne, hashOf("prod")], [deviceTwo, hashOf("prod")]]);
    expect((await publish(app, "prod", prodToken)).status).toBe(200);
    expect(apns.tokens).toEqual(["ios-one"]);
    expect(fcm.tokens).toEqual(["android-two"]);
  });

  it("changes nothing and raises nothing when either sweep runs twice", async () => {
    const { app, db } = setup();
    const first = await registerFirst(app);
    db.prepare("UPDATE accounts SET tier = 'relay'").run();
    await makeTopic(app, first, "prod");
    expect((await register(app, deviceTwo, "android", "android-two", first)).status).toBe(201);
    const before = rows(db);
    const accountId = accountOf(db);

    expect(() => {
      sweepDeviceIntoTopics(db, accountId, deviceOne);
      sweepDeviceIntoTopics(db, accountId, deviceTwo);
      sweepTopicIntoDevices(db, accountId, hashOf("prod"));
      sweepTopicIntoDevices(db, accountId, hashOf("prod"));
    }).not.toThrow();

    expect(rows(db)).toEqual(before);
  });

  it("keeps the app's own subscribe and the sweep out of each other's way", async () => {
    const { app, db } = setup();
    const first = await registerFirst(app);
    db.prepare("UPDATE accounts SET tier = 'relay'").run();
    await makeTopic(app, first, "prod");

    expect((await subscribe(app, deviceOne, first, hashOf("prod"))).status).toBe(204);
    expect((await register(app, deviceTwo, "android", "android-two", first)).status).toBe(201);
    await makeTopic(app, first, "staging");

    expectRows(db, accountOf(db), [
      [deviceOne, hashOf("prod")], [deviceOne, hashOf("staging")],
      [deviceTwo, hashOf("prod")], [deviceTwo, hashOf("staging")],
    ]);
  });

  it("clears every device's rows when a topic is deleted", async () => {
    const { app, db } = setup();
    const first = await registerFirst(app);
    db.prepare("UPDATE accounts SET tier = 'relay'").run();
    await makeTopic(app, first, "prod");
    await makeTopic(app, first, "staging");
    expect((await register(app, deviceTwo, "android", "android-two", first)).status).toBe(201);

    const deletion = await app.request("/v1/topics/prod", { method: "DELETE", headers: { Authorization: `Bearer ${first}` } });

    expect(deletion.status).toBe(204);
    expect(db.prepare("SELECT name FROM topics").all()).toEqual([{ name: "staging" }]);
    expectRows(db, accountOf(db), [[deviceOne, hashOf("staging")], [deviceTwo, hashOf("staging")]]);
  });

  it("raises nothing on a free account past its critical topic cap", () => {
    const { db } = setup();
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_free', 'free', 1)").run();
    for (const id of ["dev_one", "dev_two"]) {
      db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_free', ?, 'ios', 'ios-token', 1)").run(id, createHash("sha256").update(id).digest("hex"));
    }
    for (const name of ["one", "two", "three"]) {
      db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES (?, 'acc_free', ?, 'https://alerts.example.com', ?, 1, 30, 1800, 600, 'none', 1)").run(`top_${name}`, name, hashOf(name));
    }

    expect(() => {
      sweepDeviceIntoTopics(db, "acc_free", "dev_one");
      sweepDeviceIntoTopics(db, "acc_free", "dev_two");
      for (const name of ["one", "two", "three"]) sweepTopicIntoDevices(db, "acc_free", hashOf(name));
    }).not.toThrow();

    expect(db.prepare("SELECT COUNT(*) AS count FROM subscriptions").get()).toEqual({ count: 6 });
  });

  it("leaves a single-device account exactly as it was", async () => {
    const { app, db, apns, fcm } = setup();
    const first = await registerFirst(app);
    const prodToken = await makeTopic(app, first, "prod");

    expectRows(db, accountOf(db), [[deviceOne, hashOf("prod")]]);
    expect((await publish(app, "prod", prodToken)).status).toBe(200);
    expect(apns.tokens).toEqual(["ios-one"]);
    expect(fcm.tokens).toEqual([]);
  });

  it("touches nothing in self-hosted mode", async () => {
    const { app, db } = setup("selfhosted");
    const { token } = ensureSelfHostedIdentity(db);
    const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

    expect((await register(app, deviceOne, "ios", "ios-one")).status).toBe(404);
    expect((await app.request("/v1/topics", { method: "POST", headers, body: '{"name":"prod","critical":true}' })).status).toBe(201);
    expect(db.prepare("SELECT * FROM devices").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM subscriptions").all()).toEqual([]);

    expect((await app.request("/v1/topics/prod", { method: "DELETE", headers })).status).toBe(204);
    expect(db.prepare("SELECT * FROM subscriptions").all()).toEqual([]);
  });
});

// contract 1.8.0 took the critical_topics cap off subscribing. Nothing pinned
// that, so these pin it for every tier.
describe("subscribing is never capped", () => {
  it.each(["free", "relay", "hosted"])("answers 204 and never 429 for a %s account", async (tier) => {
    const { app, db } = setup();
    const first = await registerFirst(app);
    db.prepare("UPDATE accounts SET tier = ?").run(tier);

    for (let i = 0; i < 6; i++) {
      const response = await subscribe(app, deviceOne, first, i.toString(16).repeat(64));
      expect(response.status).toBe(204);
    }

    expect(db.prepare("SELECT COUNT(*) AS count FROM subscriptions").get()).toEqual({ count: 6 });
  });
});
