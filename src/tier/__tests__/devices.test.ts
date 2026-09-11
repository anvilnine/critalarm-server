import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
  account(): string { this.accountNumber += 1; return `acc_${this.accountNumber}`; }
  deviceToken(): string { this.tokenNumber += 1; return `dv_test_${this.tokenNumber}`; }
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
    expect(await response.json()).toEqual({ device_token: "dv_test_1", account_id: "acc_1", tier: "free", caps: { devices: 1, critical_topics: 1, p4_daily: 50 } });
    expect(db.prepare("SELECT id, tier, created_at FROM accounts").all()).toEqual([{ id: "acc_1", tier: "free", created_at: 1_000 }]);
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
    expect(await response.json()).toEqual({ account_id: "acc_1", tier: "free", caps: { devices: 1, critical_topics: 1, p4_daily: 50 } });
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
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_cap', 'free', 1)").run();
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_cap', ?, 'ios', 'existing-token', 1)").run(existingId, createHash("sha256").update("dv_existing").digest("hex"));

    expect(() => registerDevice(deps, device, undefined, { accountId: "acc_cap", deviceId: existingId })).toThrow(CapError);
    expect(db.prepare("SELECT id, tier FROM accounts").all()).toEqual([{ id: "acc_cap", tier: "free" }]);
    expect(db.prepare("SELECT id, account_id FROM devices").all()).toEqual([{ id: existingId, account_id: "acc_cap" }]);
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain("dv_test_1");
  });

  it("enforces the device cap for an authenticated new-device POST", async () => {
    const { app, db } = setup();
    const registration = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(device) });
    const { device_token: deviceToken } = await registration.json() as { device_token: string };
    const beforeAccounts = db.prepare("SELECT id, tier FROM accounts").all();
    const beforeDevices = db.prepare("SELECT id, account_id, device_token_hash FROM devices").all();

    const response = await app.request("/relay/v1/devices", { method: "POST", headers: { Authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...device, device_id: "dev_123e4567-e89b-12d3-a456-426614174001" }) });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "cap", cap: "devices" });
    expect(db.prepare("SELECT id, tier FROM accounts").all()).toEqual(beforeAccounts);
    expect(db.prepare("SELECT id, account_id, device_token_hash FROM devices").all()).toEqual(beforeDevices);
    expect(JSON.stringify(db.prepare("SELECT * FROM devices").all())).not.toContain("dv_test_2");
  });
});
