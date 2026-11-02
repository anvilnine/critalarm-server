import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { pushTokenSchemaFor, setAlarmToken } from "../device-tokens.js";
import { createTierRouter } from "../router.js";
import type { TierDependencies } from "../types.js";

// api.md §4.2, contract 1.25.0. A Mac registers like an iPhone: its alarm
// token is kind apns, it counts against caps.devices, and it holds no Live
// Activity token. One test per rule of the task, named for the rule.

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

const json = { "content-type": "application/json" };
const id = (n: number) => `dev_123e4567-e89b-12d3-a456-4266141740${String(n).padStart(2, "0")}`;
const mac = id(0);

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock();
  const deps: TierDependencies = { db, clock, ids: new FixedIds(), revenueCat: { sharedSecret: "s", entitlements: {} } };
  return { app: createTierRouter(deps), db, clock };
}

type App = ReturnType<typeof setup>["app"];

function register(app: App, deviceId: string, platform: string, pushToken: string, bearer?: string) {
  return app.request("/relay/v1/devices", {
    method: "POST",
    headers: bearer === undefined ? json : { ...json, authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ device_id: deviceId, platform, push_token: pushToken, app_version: "1.0.0" }),
  });
}

function patch(app: App, deviceId: string, bearer: string, pushToken: string) {
  return app.request(`/relay/v1/devices/${deviceId}`, { method: "PATCH", headers: { ...json, authorization: `Bearer ${bearer}` }, body: JSON.stringify({ push_token: pushToken, app_version: "1.0.1" }) });
}

function postToken(app: App, deviceId: string, bearer: string, body: unknown) {
  return app.request(`/relay/v1/devices/${deviceId}/tokens`, { method: "POST", headers: { ...json, authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
}

const tokenRows = (db: ReturnType<typeof setup>["db"], deviceId: string) =>
  db.prepare("SELECT kind, activity_id, incident_id, token FROM device_tokens WHERE device_id = ? ORDER BY kind, activity_id").all(deviceId);

describe("rule 2: the platform type, and apns as the alarm kind on macos", () => {
  it("pushTokenSchemaFor('macos') is the APNs shape", () => {
    expect(pushTokenSchemaFor("macos").safeParse("aaaa0001").success).toBe(true);
    expect(pushTokenSchemaFor("macos").safeParse("abc:def_ghi-jk").success).toBe(false);
    // The other two are untouched.
    expect(pushTokenSchemaFor("ios").safeParse("abc:def_ghi-jk").success).toBe(false);
    expect(pushTokenSchemaFor("android").safeParse("abc:def_ghi-jk").success).toBe(true);
  });

  it("setAlarmToken stores a Mac's token as kind apns, an iPhone's as apns and an Android phone's as fcm", () => {
    const { db, clock } = setup();
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_x', 'free', 1)").run();
    for (const [deviceId, platform] of [["dev_m", "macos"], ["dev_i", "ios"], ["dev_a", "android"]] as const) {
      db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_x', ?, ?, 'aa', 1)").run(deviceId, `hash_${deviceId}`, platform);
      setAlarmToken(db, clock, deviceId, platform, "aaaa0001");
    }
    expect(db.prepare("SELECT device_id, kind FROM device_tokens ORDER BY device_id").all()).toEqual([
      { device_id: "dev_a", kind: "fcm" },
      { device_id: "dev_i", kind: "apns" },
      { device_id: "dev_m", kind: "apns" },
    ]);
  });
});

describe("rule 3: registration and PATCH accept macos, and a Mac counts against caps.devices", () => {
  it("registers a Mac with platform macos and stores its push token as kind apns", async () => {
    const { app, db } = setup();
    const response = await register(app, mac, "macos", "aaaa0001");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ device_token: "dv_test_1", account_id: "acc_1", tier: "free", caps: { devices: 5 } });
    expect(db.prepare("SELECT platform, push_token FROM devices WHERE id = ?").get(mac)).toEqual({ platform: "macos", push_token: "aaaa0001" });
    expect(tokenRows(db, mac)).toEqual([{ kind: "apns", activity_id: "", incident_id: null, token: "aaaa0001" }]);
  });

  it("refuses an FCM-shaped token from a Mac, as it does from an iPhone", async () => {
    const { app, db } = setup();
    const response = await register(app, mac, "macos", "abc:def_ghi-jk");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM devices").get()).toEqual({ n: 0 });
  });

  it("still refuses a platform outside the three", async () => {
    const { app } = setup();
    for (const platform of ["web", "macOS", "darwin"]) {
      const response = await register(app, mac, platform, "aaaa0001");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
    }
  });

  it("PATCH on a Mac takes a new APNs token, keeps the platform macos and refuses an FCM-shaped one", async () => {
    const { app, db } = setup();
    const body = await (await register(app, mac, "macos", "aaaa0001")).json() as { device_token: string };

    const response = await patch(app, mac, body.device_token, "bbbb0002");
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT platform, push_token, app_version FROM devices WHERE id = ?").get(mac)).toEqual({ platform: "macos", push_token: "bbbb0002", app_version: "1.0.1" });
    expect(tokenRows(db, mac)).toEqual([{ kind: "apns", activity_id: "", incident_id: null, token: "bbbb0002" }]);

    const refused = await patch(app, mac, body.device_token, "abc:def_ghi-jk");
    expect(refused.status).toBe(400);
    expect(tokenRows(db, mac)).toEqual([{ kind: "apns", activity_id: "", incident_id: null, token: "bbbb0002" }]);
  });

  it("re-registering a known Mac with its dv_ keeps it a Mac with an apns token", async () => {
    const { app, db } = setup();
    const body = await (await register(app, mac, "macos", "aaaa0001")).json() as { device_token: string };
    const again = await register(app, mac, "macos", "cccc0003", body.device_token);
    expect(again.status).toBe(200);
    expect(db.prepare("SELECT platform, push_token FROM devices WHERE id = ?").get(mac)).toEqual({ platform: "macos", push_token: "cccc0003" });
    expect(tokenRows(db, mac)).toEqual([{ kind: "apns", activity_id: "", incident_id: null, token: "cccc0003" }]);
  });

  it("a Mac counts against caps.devices: a Mac and four phones fill the account, and a sixth device of any platform answers 429", async () => {
    const { app, db } = setup();
    const first = await (await register(app, mac, "macos", "aaaa0001")).json() as { account_join_token: string };
    const join = first.account_join_token;
    expect((await register(app, id(1), "ios", "aaaa0011", join)).status).toBe(201);
    expect((await register(app, id(2), "android", "fcm-token-2", join)).status).toBe(201);
    expect((await register(app, id(3), "macos", "aaaa0013", join)).status).toBe(201);
    expect((await register(app, id(4), "ios", "aaaa0014", join)).status).toBe(201);
    for (const [deviceId, platform, token] of [[id(5), "macos", "aaaa0015"], [id(6), "ios", "aaaa0016"], [id(7), "android", "fcm-token-7"]] as const) {
      const response = await register(app, deviceId, platform, token, join);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "cap", cap: "devices" });
    }
    expect(db.prepare("SELECT platform, COUNT(*) AS n FROM devices GROUP BY platform ORDER BY platform").all()).toEqual([
      { platform: "android", n: 1 },
      { platform: "ios", n: 2 },
      { platform: "macos", n: 2 },
    ]);
  });
});

describe("rule 4: the tokens route refuses Live Activity tokens from a Mac", () => {
  for (const body of [{ kind: "la_start", token: "5a000001" }, { kind: "la_update", token: "0d000001", activity_id: "act_1", incident_id: "inc_1" }]) {
    it(`answers 400 to ${body.kind} for a macos device and stores nothing`, async () => {
      const { app, db } = setup();
      const registered = await (await register(app, mac, "macos", "aaaa0001")).json() as { device_token: string };
      const before = tokenRows(db, mac);

      const response = await postToken(app, mac, registered.device_token, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
      expect(tokenRows(db, mac)).toEqual(before);
    });
  }

  it("accepts apns for a macos device, as a replace of its alarm token", async () => {
    const { app, db } = setup();
    const registered = await (await register(app, mac, "macos", "aaaa0001")).json() as { device_token: string };
    const response = await postToken(app, mac, registered.device_token, { kind: "apns", token: "dddd0004" });
    expect(response.status).toBe(204);
    expect(tokenRows(db, mac)).toEqual([{ kind: "apns", activity_id: "", incident_id: null, token: "dddd0004" }]);
  });

  it("still takes both Live Activity kinds from an iPhone", async () => {
    const { app, db } = setup();
    const iphone = id(9);
    const registered = await (await register(app, iphone, "ios", "aaaa0001")).json() as { device_token: string };
    expect((await postToken(app, iphone, registered.device_token, { kind: "la_start", token: "5a000001" })).status).toBe(204);
    expect((await postToken(app, iphone, registered.device_token, { kind: "la_update", token: "0d000001", activity_id: "act_1", incident_id: "inc_1" })).status).toBe(204);
    expect(tokenRows(db, iphone).map((row) => (row as { kind: string }).kind)).toEqual(["apns", "la_start", "la_update"]);
  });
});
