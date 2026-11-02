import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
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

const deviceId = "dev_123e4567-e89b-12d3-a456-426614174000";
const otherDeviceId = "dev_123e4567-e89b-12d3-a456-426614174001";
const json = { "content-type": "application/json" };

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock();
  const deps: TierDependencies = { db, clock, ids: new FixedIds(), revenueCat: { sharedSecret: "s", entitlements: {} } };
  return { app: createTierRouter(deps), db, clock };
}

async function register(app: ReturnType<typeof setup>["app"], id: string, platform: "ios" | "android", pushToken: string, bearer?: string) {
  const response = await app.request("/relay/v1/devices", {
    method: "POST",
    headers: bearer === undefined ? json : { ...json, authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ device_id: id, platform, push_token: pushToken, app_version: "1.0.0" }),
  });
  return (await response.json()) as { device_token?: string };
}

function post(app: ReturnType<typeof setup>["app"], bearer: string, body: unknown, id = deviceId) {
  return app.request(`/relay/v1/devices/${id}/tokens`, { method: "POST", headers: { ...json, authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
}

function tokenRows(db: ReturnType<typeof setup>["db"]) {
  return db.prepare("SELECT device_id, kind, activity_id, incident_id, token, updated_at FROM device_tokens ORDER BY kind, activity_id").all();
}

describe("device push tokens", () => {
  it("stores the registration push token as the platform's alarm kind", async () => {
    const { app, db } = setup();

    await register(app, deviceId, "ios", "aaaa0001");

    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "apns", activity_id: "", incident_id: null, token: "aaaa0001", updated_at: 1_000 },
    ]);
  });

  it("replaces the token of the same kind and activity instead of adding a second row", async () => {
    const { app, db, clock } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "aaaa0001");

    expect((await post(app, bearer!, { kind: "la_update", token: "0d000001", activity_id: "act_1", incident_id: "inc_1" })).status).toBe(204);
    clock.value = 1_001;
    expect((await post(app, bearer!, { kind: "la_update", token: "0d000002", activity_id: "act_1", incident_id: "inc_2" })).status).toBe(204);
    expect((await post(app, bearer!, { kind: "la_update", token: "0d000003", activity_id: "act_2", incident_id: "inc_1" })).status).toBe(204);
    expect((await post(app, bearer!, { kind: "la_start", token: "5a000001" })).status).toBe(204);
    expect((await post(app, bearer!, { kind: "la_start", token: "5a000002" })).status).toBe(204);

    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "apns", activity_id: "", incident_id: null, token: "aaaa0001", updated_at: 1_000 },
      { device_id: deviceId, kind: "la_start", activity_id: "", incident_id: null, token: "5a000002", updated_at: 1_001 },
      { device_id: deviceId, kind: "la_update", activity_id: "act_1", incident_id: "inc_2", token: "0d000002", updated_at: 1_001 },
      { device_id: deviceId, kind: "la_update", activity_id: "act_2", incident_id: "inc_1", token: "0d000003", updated_at: 1_001 },
    ]);
  });

  it("rejects an activity id on a kind that has none and a missing one on la_update", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "aaaa0001");

    expect((await post(app, bearer!, { kind: "la_update", token: "ab" })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "la_start", token: "ab", activity_id: "act_1" })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "apns", token: "ab", incident_id: "inc_1" })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "nope", token: "ab" })).status).toBe(400);
    expect(tokenRows(db)).toHaveLength(1);
  });

  it("refuses a token write without the device's own bearer token", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "aaaa0001");

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens`, { method: "POST", headers: json, body: JSON.stringify({ kind: "la_start", token: "ab" }) })).status).toBe(401);
    expect((await post(app, bearer!, { kind: "la_start", token: "ab" }, otherDeviceId)).status).toBe(404);
    expect(tokenRows(db)).toHaveLength(1);
  });

  it("deletes one activity's token by kind and activity, and every token of a kind without one", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "aaaa0001");
    await post(app, bearer!, { kind: "la_start", token: "5a000001" });
    await post(app, bearer!, { kind: "la_update", token: "0d000001", activity_id: "act_1" });
    await post(app, bearer!, { kind: "la_update", token: "0d000002", activity_id: "act_2" });
    const headers = { authorization: `Bearer ${bearer!}` };

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/la_update/act_1`, { method: "DELETE", headers })).status).toBe(204);
    expect(tokenRows(db).map((row) => (row as { token: string }).token)).toEqual(["aaaa0001", "5a000001", "0d000002"]);

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/la_update`, { method: "DELETE", headers })).status).toBe(204);
    expect(tokenRows(db).map((row) => (row as { token: string }).token)).toEqual(["aaaa0001", "5a000001"]);

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/bogus`, { method: "DELETE", headers })).status).toBe(400);
    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/la_start`, { method: "DELETE" })).status).toBe(401);
  });

  it("moves the alarm token to the new kind when a device re-registers on the other platform", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "aaaa0001");

    await register(app, deviceId, "android", "fcm-token", bearer);

    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "fcm", activity_id: "", incident_id: null, token: "fcm-token", updated_at: 1_000 },
    ]);
  });

  it("replaces the alarm token on PATCH without touching Live Activity tokens", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "aaaa0001");
    await post(app, bearer!, { kind: "la_start", token: "5a000001" });

    const response = await app.request(`/relay/v1/devices/${deviceId}`, {
      method: "PATCH",
      headers: { ...json, authorization: `Bearer ${bearer!}` },
      body: JSON.stringify({ push_token: "aaaa0002", app_version: "1.0.1" }),
    });

    expect(response.status).toBe(200);
    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "apns", activity_id: "", incident_id: null, token: "aaaa0002", updated_at: 1_000 },
      { device_id: deviceId, kind: "la_start", activity_id: "", incident_id: null, token: "5a000001", updated_at: 1_000 },
    ]);
  });
});

// The relay puts a push token into the APNs request path or the FCM message.
// A 70000-character token made the APNs client throw before it sent anything,
// and that throw used to stop the timer scan's whole batch.
describe("push token shapes", () => {
  // What the app sends: Apple's bytes as lowercase hex, and Firebase's token as
  // it comes.
  const apnsDevice = "3f".repeat(32);
  const apnsActivity = "a1".repeat(80);
  const fcm = "dQw4w9WgXcQ:APA91bH8zR2-xV_c1q0kQe" + "Xy7_-".repeat(25);

  async function registerStatus(app: ReturnType<typeof setup>["app"], platform: "ios" | "android", pushToken: string, id = deviceId) {
    const response = await app.request("/relay/v1/devices", { method: "POST", headers: json, body: JSON.stringify({ device_id: id, platform, push_token: pushToken, app_version: "1.0.0" }) });
    return response.status;
  }

  it("accepts the tokens the app really sends", async () => {
    const { app, db } = setup();
    expect(await registerStatus(app, "ios", apnsDevice)).toBe(201);
    expect(await registerStatus(app, "android", fcm, otherDeviceId)).toBe(201);
    const { device_token: bearer } = await register(app, deviceId, "ios", apnsDevice, "dv_test_1");
    expect(bearer).toBeUndefined();
    expect((await post(app, "dv_test_1", { kind: "la_start", token: apnsActivity })).status).toBe(204);
    expect((await post(app, "dv_test_1", { kind: "la_update", token: apnsActivity, activity_id: "act_1", incident_id: "inc_1" })).status).toBe(204);
    expect(db.prepare("SELECT kind, length(token) AS length FROM device_tokens ORDER BY device_id, kind").all()).toEqual([
      { kind: "apns", length: 64 },
      { kind: "la_start", length: 160 },
      { kind: "la_update", length: 160 },
      { kind: "fcm", length: fcm.length },
    ]);
  });

  it("refuses an oversized token on registration and stores nothing", async () => {
    const { app, db } = setup();
    expect(await registerStatus(app, "ios", "a".repeat(70_000))).toBe(400);
    expect(await registerStatus(app, "android", "X".repeat(70_000))).toBe(400);
    expect(await registerStatus(app, "ios", "a".repeat(513))).toBe(400);
    expect(await registerStatus(app, "android", "X".repeat(4097))).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 0 });
  });

  it("refuses characters a token of that platform never has", async () => {
    const { app } = setup();
    expect(await registerStatus(app, "ios", "not-hex-token")).toBe(400);
    expect(await registerStatus(app, "ios", fcm)).toBe(400);
    expect(await registerStatus(app, "android", "abc/../def")).toBe(400);
    expect(await registerStatus(app, "android", "abc def")).toBe(400);
    expect(await registerStatus(app, "android", "abc%2Fdef")).toBe(400);
  });

  it("checks a PATCH against the device's own platform", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", apnsDevice);
    const patch = (pushToken: string) => app.request(`/relay/v1/devices/${deviceId}`, { method: "PATCH", headers: { ...json, authorization: `Bearer ${bearer}` }, body: JSON.stringify({ push_token: pushToken, app_version: "1.0.1" }) });
    expect((await patch(fcm)).status).toBe(400);
    expect((await patch("b".repeat(70_000))).status).toBe(400);
    expect(db.prepare("SELECT push_token FROM devices").get()).toEqual({ push_token: apnsDevice });
    expect((await patch("4e".repeat(32))).status).toBe(200);
  });

  it("refuses an oversized or wrongly shaped Live Activity or alarm token on /tokens", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", apnsDevice);
    expect((await post(app, bearer!, { kind: "la_start", token: "a".repeat(70_000) })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "la_update", token: "zz", activity_id: "act_1" })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "apns", token: "a".repeat(513) })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "fcm", token: "a b" })).status).toBe(400);
    expect(db.prepare("SELECT kind FROM device_tokens").all()).toEqual([{ kind: "apns" }]);
  });
});
