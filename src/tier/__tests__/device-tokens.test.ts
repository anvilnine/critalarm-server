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

    await register(app, deviceId, "ios", "apns-token");

    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "apns", activity_id: "", incident_id: null, token: "apns-token", updated_at: 1_000 },
    ]);
  });

  it("replaces the token of the same kind and activity instead of adding a second row", async () => {
    const { app, db, clock } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "apns-token");

    expect((await post(app, bearer!, { kind: "la_update", token: "update-1", activity_id: "act_1", incident_id: "inc_1" })).status).toBe(204);
    clock.value = 1_001;
    expect((await post(app, bearer!, { kind: "la_update", token: "update-2", activity_id: "act_1", incident_id: "inc_2" })).status).toBe(204);
    expect((await post(app, bearer!, { kind: "la_update", token: "update-3", activity_id: "act_2", incident_id: "inc_1" })).status).toBe(204);
    expect((await post(app, bearer!, { kind: "la_start", token: "start-1" })).status).toBe(204);
    expect((await post(app, bearer!, { kind: "la_start", token: "start-2" })).status).toBe(204);

    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "apns", activity_id: "", incident_id: null, token: "apns-token", updated_at: 1_000 },
      { device_id: deviceId, kind: "la_start", activity_id: "", incident_id: null, token: "start-2", updated_at: 1_001 },
      { device_id: deviceId, kind: "la_update", activity_id: "act_1", incident_id: "inc_2", token: "update-2", updated_at: 1_001 },
      { device_id: deviceId, kind: "la_update", activity_id: "act_2", incident_id: "inc_1", token: "update-3", updated_at: 1_001 },
    ]);
  });

  it("rejects an activity id on a kind that has none and a missing one on la_update", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "apns-token");

    expect((await post(app, bearer!, { kind: "la_update", token: "t" })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "la_start", token: "t", activity_id: "act_1" })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "apns", token: "t", incident_id: "inc_1" })).status).toBe(400);
    expect((await post(app, bearer!, { kind: "nope", token: "t" })).status).toBe(400);
    expect(tokenRows(db)).toHaveLength(1);
  });

  it("refuses a token write without the device's own bearer token", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "apns-token");

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens`, { method: "POST", headers: json, body: JSON.stringify({ kind: "la_start", token: "t" }) })).status).toBe(401);
    expect((await post(app, bearer!, { kind: "la_start", token: "t" }, otherDeviceId)).status).toBe(404);
    expect(tokenRows(db)).toHaveLength(1);
  });

  it("deletes one activity's token by kind and activity, and every token of a kind without one", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "apns-token");
    await post(app, bearer!, { kind: "la_start", token: "start-1" });
    await post(app, bearer!, { kind: "la_update", token: "update-1", activity_id: "act_1" });
    await post(app, bearer!, { kind: "la_update", token: "update-2", activity_id: "act_2" });
    const headers = { authorization: `Bearer ${bearer!}` };

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/la_update/act_1`, { method: "DELETE", headers })).status).toBe(204);
    expect(tokenRows(db).map((row) => (row as { token: string }).token)).toEqual(["apns-token", "start-1", "update-2"]);

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/la_update`, { method: "DELETE", headers })).status).toBe(204);
    expect(tokenRows(db).map((row) => (row as { token: string }).token)).toEqual(["apns-token", "start-1"]);

    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/bogus`, { method: "DELETE", headers })).status).toBe(400);
    expect((await app.request(`/relay/v1/devices/${deviceId}/tokens/la_start`, { method: "DELETE" })).status).toBe(401);
  });

  it("moves the alarm token to the new kind when a device re-registers on the other platform", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "apns-token");

    await register(app, deviceId, "android", "fcm-token", bearer);

    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "fcm", activity_id: "", incident_id: null, token: "fcm-token", updated_at: 1_000 },
    ]);
  });

  it("replaces the alarm token on PATCH without touching Live Activity tokens", async () => {
    const { app, db } = setup();
    const { device_token: bearer } = await register(app, deviceId, "ios", "apns-token");
    await post(app, bearer!, { kind: "la_start", token: "start-1" });

    const response = await app.request(`/relay/v1/devices/${deviceId}`, {
      method: "PATCH",
      headers: { ...json, authorization: `Bearer ${bearer!}` },
      body: JSON.stringify({ push_token: "apns-token-2", app_version: "1.0.1" }),
    });

    expect(response.status).toBe(200);
    expect(tokenRows(db)).toEqual([
      { device_id: deviceId, kind: "apns", activity_id: "", incident_id: null, token: "apns-token-2", updated_at: 1_000 },
      { device_id: deviceId, kind: "la_start", activity_id: "", incident_id: null, token: "start-1", updated_at: 1_000 },
    ]);
  });
});
