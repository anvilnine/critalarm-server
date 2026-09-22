import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { CapError, registerDevice } from "../devices.js";
import { createTierRouter } from "../router.js";
import type { TierDependencies } from "../types.js";

class FakeClock {
  constructor(public value = 1_000) {}
  now(): number { return this.value; }
}

class FixedIds {
  private accountNumber = 0;
  private tokenNumber = 0;
  private joinNumber = 0;
  account(): string { this.accountNumber += 1; return `acc_${this.accountNumber}`; }
  deviceToken(): string { this.tokenNumber += 1; return `dv_test_${this.tokenNumber}`; }
  accountJoinToken(): string { this.joinNumber += 1; return `aj_test_${this.joinNumber}`; }
}

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock();
  const ids = new FixedIds();
  const deps: TierDependencies = { db, clock, ids, revenueCat: { sharedSecret: "revenuecat-secret", entitlements: { relay: "relay", hosted: "hosted" } } };
  return { app: createTierRouter(deps), db, clock, deps };
}

const device = { device_id: "dev_123e4567-e89b-12d3-a456-426614174000", platform: "ios", push_token: "apns-token", app_version: "1.0.0" } as const;

describe("device registry", () => {
  it("creates an account and device for an unknown device id without storing the plaintext token", async () => {
    const { app, db } = setup();

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(device) });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ device_token: "dv_test_1", account_join_token: "aj_test_1", account_id: "acc_1", tier: "free", caps: { devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 } });
    expect(db.prepare("SELECT id, tier, created_at FROM accounts").all()).toEqual([{ id: "acc_1", tier: "free", created_at: 1_000 }]);
    expect(db.prepare("SELECT join_token_hash FROM accounts").get()).toEqual({ join_token_hash: createHash("sha256").update("aj_test_1").digest("hex") });
    expect(JSON.stringify(db.prepare("SELECT * FROM accounts").all())).not.toContain("aj_test_1");
    expect(db.prepare("SELECT id, account_id, device_token_hash, platform, push_token, last_seen FROM devices").all()).toEqual([{
      id: device.device_id,
      account_id: "acc_1",
      device_token_hash: createHash("sha256").update("dv_test_1").digest("hex"),
      platform: "ios",
      push_token: "apns-token",
      last_seen: 1_000,
    }]);
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain("dv_test_1");
  });

  it("rejects a known device id without a valid device token and creates nothing", async () => {
    const { app, db } = setup();
    await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(device) });

    const response = await app.request(`/relay/v1/devices/${device.device_id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ push_token: "new-token", app_version: "1.0.1" }) });

    expect(response.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT push_token FROM devices").get()).toEqual({ push_token: "apns-token" });
  });

  it("updates a known authenticated device without minting a second token", async () => {
    const { app, db, clock } = setup();
    const registration = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(device) });
    const { device_token: deviceToken } = await registration.json() as { device_token: string };
    clock.value = 1_100;

    const response = await app.request(`/relay/v1/devices/${device.device_id}`, { method: "PATCH", headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ push_token: "new-token", app_version: "1.0.1" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "acc_1", tier: "free", caps: { devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 } });
    expect(db.prepare("SELECT push_token, last_seen, device_token_hash FROM devices").all()).toEqual([{ push_token: "new-token", last_seen: 1_100, device_token_hash: createHash("sha256").update(deviceToken).digest("hex") }]);
  });

  it("hides another device path from a device token", async () => {
    const { app, db } = setup();
    const registration = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(device) });
    const { device_token: deviceToken } = await registration.json() as { device_token: string };
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'free', 1)").run();
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_other', 'acc_2', ?, 'android', 'fcm-token', 1)").run(createHash("sha256").update("dv_other").digest("hex"));

    const response = await app.request("/relay/v1/devices/dev_other", { method: "PATCH", headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ push_token: "attacker-token", app_version: "1.0.1" }) });

    expect(response.status).toBe(404);
    expect(db.prepare("SELECT push_token FROM devices WHERE id = 'dev_other'").get()).toEqual({ push_token: "fcm-token" });
  });

  it("rejects an unknown device token as unauthorized", async () => {
    const { app } = setup();
    await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(device) });

    const response = await app.request(`/relay/v1/devices/${device.device_id}`, { method: "PATCH", headers: { Authorization: "Bearer dv_unknown", "content-type": "application/json" }, body: JSON.stringify({ push_token: "new-token", app_version: "1.0.1" }) });

    expect(response.status).toBe(401);
  });

  it("rejects a non-UUID device id without creating rows", async () => {
    const { app, db } = setup();

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...device, device_id: "dev_not-a-uuid" }) });

    expect(response.status).toBe(400);
    expect(db.prepare("SELECT * FROM accounts").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM devices").all()).toEqual([]);
  });

  it("does not mint a device or token when an authenticated account is at its device cap", () => {
    const { db, deps } = setup();
    const existingId = "dev_123e4567-e89b-12d3-a456-426614174001";
    const existingIds = [existingId, ...[2, 3, 4, 5].map(n => `dev_123e4567-e89b-12d3-a456-42661417400${n}`)];
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_cap', 'free', 1)").run();
    for (const id of existingIds) {
      db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_cap', ?, 'ios', 'existing-token', 1)").run(id, createHash("sha256").update(`dv_existing_${id}`).digest("hex"));
    }

    expect(() => registerDevice(deps, device, undefined, { accountId: "acc_cap", deviceId: existingId })).toThrow(CapError);
    expect(db.prepare("SELECT id, tier FROM accounts").all()).toEqual([{ id: "acc_cap", tier: "free" }]);
    expect(db.prepare("SELECT id, account_id FROM devices").all()).toEqual(existingIds.map(id => ({ id, account_id: "acc_cap" })));
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain("dv_test_1");
  });

  it("enforces the device cap for an authenticated new-device POST", async () => {
    const { app, db } = setup();
    const registration = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(device) });
    const { device_token: deviceToken } = await registration.json() as { device_token: string };
    for (let i = 1; i <= 4; i++) {
      const filling = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...device, device_id: `dev_123e4567-e89b-12d3-a456-42661417400${i}` }) });
      expect(filling.status).toBe(201);
    }
    const beforeAccounts = db.prepare("SELECT id, tier FROM accounts").all();
    const beforeDevices = db.prepare("SELECT id, account_id, device_token_hash FROM devices").all();

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...device, device_id: "dev_123e4567-e89b-12d3-a456-426614174005" }) });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "cap", cap: "devices" });
    expect(db.prepare("SELECT id, tier FROM accounts").all()).toEqual(beforeAccounts);
    expect(db.prepare("SELECT id, account_id, device_token_hash FROM devices").all()).toEqual(beforeDevices);
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain("dv_test_6");
  });
});

describe("known-device POST", () => {
  it.each(["POST", "PATCH"])("%s updates push token and app version without returning a credential", async method => {
    const { app, db } = setup();
    await app.request("/relay/v1/devices", { method: "POST", body: JSON.stringify(device) });
    const before = db.prepare("SELECT device_token_hash FROM devices").get();
    const response = await app.request(method === "POST" ? "/relay/v1/devices" : `/relay/v1/devices/${device.device_id}`, {
      method, headers: { Authorization: "Bearer dv_test_1" }, body: JSON.stringify({ ...device, push_token: "updated", app_version: "2.0.0" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("device_token");
    expect(body).toEqual({ account_id: "acc_1", tier: "free", caps: { devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 } });
    expect(db.prepare("SELECT push_token, app_version FROM devices").get()).toEqual({ push_token: "updated", app_version: "2.0.0" });
    expect(db.prepare("SELECT device_token_hash FROM devices").get()).toEqual(before);
    expect(db.prepare("SELECT token FROM device_tokens").get()).toEqual({ token: "updated" });
  });

  it.each([undefined, "dv_wrong", "dv_test_2"])("rejects re-registration with %s without changing identity", async token => {
    const { app, db } = setup();
    for (const id of [device.device_id, "dev_123e4567-e89b-12d3-a456-426614174001"]) {
      await app.request("/relay/v1/devices", { method: "POST", body: JSON.stringify({ ...device, device_id: id }) });
    }
    const before = db.prepare("SELECT * FROM devices").all();
    const response = await app.request("/relay/v1/devices", { method: "POST", headers: token === undefined ? {} : { Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...device, push_token: "changed" }) });
    expect(response.status).toBe(401);
    expect(db.prepare("SELECT * FROM devices").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 2 });
  });

  it.each(["free", "relay", "hosted"])("allows five devices on %s and rejects a sixth", async tier => {
    const { app, db } = setup();
    await app.request("/relay/v1/devices", { method: "POST", body: JSON.stringify(device) });
    db.prepare("UPDATE accounts SET tier = ?").run(tier);
    for (let i = 1; i <= 5; i++) {
      const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: "Bearer dv_test_1" }, body: JSON.stringify({ ...device, device_id: `dev_123e4567-e89b-12d3-a456-42661417400${i}` }) });
      expect(response.status).toBe(i < 5 ? 201 : 429);
    }
  });
});

const secondDeviceId = "dev_123e4567-e89b-12d3-a456-426614174009";
const freeCaps = { devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 };

function insertTopic(db: Database.Database, accountId: string, topicHash: string, name = "prod"): void {
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES (?, ?, ?, 'https://alerts.example.com', ?, 1, 30, 300, 60, 'none', 1)").run(`top_${name}`, accountId, name, topicHash);
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES (?, ?, ?, 1)").run(`tok_${name}`, `top_${name}`, createHash("sha256").update(`tk_${name}`).digest("hex"));
}

async function registerFirst(app: Hono): Promise<{ deviceToken: string; joinToken: string }> {
  const response = await app.request("/relay/v1/devices", { method: "POST", body: JSON.stringify(device) });
  const body = await response.json() as { device_token: string; account_join_token: string };
  return { deviceToken: body.device_token, joinToken: body.account_join_token };
}

describe("account join token", () => {
  it("attaches an unknown device to the aj_'s account and mints it its own device token", async () => {
    const { app, db } = setup();
    const { joinToken } = await registerFirst(app);

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${joinToken}` }, body: JSON.stringify({ ...device, device_id: secondDeviceId, platform: "android", push_token: "fcm-token" }) });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ device_token: "dv_test_2", account_id: "acc_1", tier: "free", caps: freeCaps });
    expect(body).not.toHaveProperty("account_join_token");
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT account_id, device_token_hash FROM devices WHERE id = ?").get(secondDeviceId)).toEqual({ account_id: "acc_1", device_token_hash: createHash("sha256").update("dv_test_2").digest("hex") });
  });

  it("returns no join token when an existing device's dv_ adds a second handset", async () => {
    const { app } = setup();
    const { deviceToken } = await registerFirst(app);

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${deviceToken}` }, body: JSON.stringify({ ...device, device_id: secondDeviceId }) });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ device_token: "dv_test_2", account_id: "acc_1", tier: "free", caps: freeCaps });
  });

  it("still creates a new anonymous account when no bearer is sent", async () => {
    const { app, db } = setup();
    await registerFirst(app);

    const response = await app.request("/relay/v1/devices", { method: "POST", body: JSON.stringify({ ...device, device_id: secondDeviceId }) });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ device_token: "dv_test_2", account_join_token: "aj_test_2", account_id: "acc_2", tier: "free", caps: freeCaps });
    expect(db.prepare("SELECT id FROM accounts ORDER BY id").all()).toEqual([{ id: "acc_1" }, { id: "acc_2" }]);
    expect(db.prepare("SELECT account_id FROM devices WHERE id = ?").get(secondDeviceId)).toEqual({ account_id: "acc_2" });
  });

  it("rejects an aj_ that matches no account and mints nothing", async () => {
    const { app, db } = setup();
    await registerFirst(app);
    const before = db.prepare("SELECT * FROM devices").all();

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: "Bearer aj_nobody" }, body: JSON.stringify({ ...device, device_id: secondDeviceId }) });

    expect(response.status).toBe(401);
    expect(db.prepare("SELECT * FROM devices").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 1 });
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain("dv_test_2");
  });

  it("answers 429 and mints nothing when a join would pass caps.devices", async () => {
    const { app, db } = setup();
    const { joinToken } = await registerFirst(app);
    for (let i = 1; i <= 4; i++) {
      const filling = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${joinToken}` }, body: JSON.stringify({ ...device, device_id: `dev_123e4567-e89b-12d3-a456-42661417400${i}` }) });
      expect(filling.status).toBe(201);
    }
    const before = db.prepare("SELECT id, device_token_hash FROM devices ORDER BY id").all();

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${joinToken}` }, body: JSON.stringify({ ...device, device_id: secondDeviceId }) });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "cap", cap: "devices" });
    expect(db.prepare("SELECT id, device_token_hash FROM devices ORDER BY id").all()).toEqual(before);
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain("dv_test_6");
  });

  it("gives a joined device a subscription row for a topic the account already had", async () => {
    const { app, db } = setup();
    const { joinToken } = await registerFirst(app);
    const topicHash = "a".repeat(64);
    insertTopic(db, "acc_1", topicHash);

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${joinToken}` }, body: JSON.stringify({ ...device, device_id: secondDeviceId }) });

    expect(response.status).toBe(201);
    expect(db.prepare("SELECT device_id, topic_hash FROM subscriptions WHERE device_id = ?").all(secondDeviceId)).toEqual([{ device_id: secondDeviceId, topic_hash: topicHash }]);
  });
});

describe("releasing a device", () => {
  it("drops the device row, its push tokens and its subscriptions and leaves the account, its topics and its tk_ tokens", async () => {
    const { app, db } = setup();
    const { deviceToken } = await registerFirst(app);
    const topicHash = "b".repeat(64);
    insertTopic(db, "acc_1", topicHash);
    db.prepare("INSERT OR IGNORE INTO subscriptions (device_id, topic_hash) VALUES (?, ?)").run(device.device_id, topicHash);
    db.prepare("INSERT INTO device_tokens (device_id, kind, activity_id, incident_id, token, updated_at) VALUES (?, 'la_update', 'act_1', 'inc_1', 'la-token', 1)").run(device.device_id);

    const response = await app.request(`/relay/v1/devices/${device.device_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${deviceToken}` } });

    expect(response.status).toBe(204);
    expect(db.prepare("SELECT * FROM devices").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM device_tokens").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM subscriptions").all()).toEqual([]);
    expect(db.prepare("SELECT id, tier FROM accounts").all()).toEqual([{ id: "acc_1", tier: "free" }]);
    expect(db.prepare("SELECT id, topic_hash FROM topics").all()).toEqual([{ id: "top_prod", topic_hash: topicHash }]);
    expect(db.prepare("SELECT id, topic_id FROM topic_tokens").all()).toEqual([{ id: "tok_prod", topic_id: "top_prod" }]);
  });

  it("leaves the account joinable after its last device is released", async () => {
    const { app, db } = setup();
    const { deviceToken, joinToken } = await registerFirst(app);
    const release = await app.request(`/relay/v1/devices/${device.device_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${deviceToken}` } });
    expect(release.status).toBe(204);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 0 });

    const rejoin = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${joinToken}` }, body: JSON.stringify({ ...device, device_id: secondDeviceId }) });

    expect(rejoin.status).toBe(201);
    expect(await rejoin.json()).toEqual({ device_token: "dv_test_2", account_id: "acc_1", tier: "free", caps: freeCaps });
  });

  it("answers 401 for another device's token on the same account and keeps the row", async () => {
    const { app, db } = setup();
    const { joinToken } = await registerFirst(app);
    const join = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${joinToken}` }, body: JSON.stringify({ ...device, device_id: secondDeviceId }) });
    const { device_token: otherToken } = await join.json() as { device_token: string };

    const response = await app.request(`/relay/v1/devices/${device.device_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${otherToken}` } });

    expect(response.status).toBe(401);
    expect(db.prepare("SELECT id FROM devices ORDER BY id").all()).toEqual([{ id: device.device_id }, { id: secondDeviceId }]);
  });

  it.each([undefined, "dv_wrong"])("answers 401 for %s and keeps the row", async token => {
    const { app, db } = setup();
    await registerFirst(app);

    const response = await app.request(`/relay/v1/devices/${device.device_id}`, { method: "DELETE", headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });

    expect(response.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 1 });
  });

  it("answers 404 for a device_id the server has never issued", async () => {
    const { app, db } = setup();
    const { deviceToken } = await registerFirst(app);

    const response = await app.request(`/relay/v1/devices/${secondDeviceId}`, { method: "DELETE", headers: { Authorization: `Bearer ${deviceToken}` } });

    expect(response.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 1 });
  });
});
