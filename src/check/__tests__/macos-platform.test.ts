import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import type { ApnsTransport } from "../../push/apns.js";
import { Counters } from "../../stats/counters.js";
import { AlarmNotes, alarmNoteWriter } from "../device-hooks.js";
import { CheckScheduler } from "../scheduler.js";
import { createChecks } from "../startup.js";
import { CheckStore } from "../store.js";
import { FakeCheckSender, FakeClock, T0, addAccount, addDevice, config, database, setup } from "./fakes.js";

// api.md §4.5 and §5.4, contract 1.25.0, rule 7 of the task. A Mac can enrol
// in the weekly check and is sent the APNs check, to the token its alarm uses.

afterEach(() => { vi.restoreAllMocks(); });

// Two senders that can be told apart, so a check that goes to the wrong
// provider shows.
function harness() {
  const base = setup();
  const apns = new FakeCheckSender();
  const fcm = new FakeCheckSender();
  const store = new CheckStore(base.db, base.clock, new Counters(base.db, base.clock));
  const scheduler = new CheckScheduler(store, { ios: apns, android: fcm }, { notes: new AlarmNotes(alarmNoteWriter(base.db)) });
  return { ...base, apns, fcm, scanAt: async (time: number) => { base.clock.value = time; return scheduler.scan(); } };
}

describe("rule 7: a Mac enrols in the weekly check and gets the APNs check", () => {
  it("enrolling a Mac on a hosted account answers 200", async () => {
    const { db, api } = harness();
    addAccount(db, "acc_1");
    addDevice(db, "dev_m", "acc_1", "macos");
    const response = await api.enable("dev_m");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, state: "waiting" });
  });

  it("the scan sends a Mac's check to the APNs sender, to the apns token in its token list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, api, apns, fcm, scanAt } = harness();
    addAccount(db, "acc_1");
    addDevice(db, "dev_m", "acc_1", "macos", "mac-legacy");
    db.prepare("INSERT INTO device_tokens (device_id, kind, activity_id, incident_id, token, updated_at) VALUES ('dev_m', 'apns', '', NULL, 'mac-token', 1)").run();
    db.prepare("UPDATE devices SET apns_environment = 'sandbox' WHERE id = 'dev_m'").run();
    await api.enable("dev_m");

    expect(await scanAt(T0 + 60)).toBe(1);

    expect(fcm.sent).toEqual([]);
    expect(apns.sent).toHaveLength(1);
    expect(apns.sent[0]?.target).toEqual({ platform: "macos", pushToken: "mac-token", apnsEnvironment: "sandbox" });
    expect(apns.sent[0]?.push.attempt).toBe(1);
  });

  it("an iPhone's check still goes to the APNs sender and an Android phone's to FCM", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, api, apns, fcm, scanAt } = harness();
    addAccount(db, "acc_1");
    addDevice(db, "dev_i", "acc_1", "ios", "ios-token");
    addDevice(db, "dev_a", "acc_1", "android", "android-token");
    await api.enable("dev_i");
    await api.enable("dev_a");

    expect(await scanAt(T0 + 60)).toBe(2);

    expect(apns.sent.map((sent) => sent.target)).toEqual([{ platform: "ios", pushToken: "ios-token" }]);
    expect(fcm.sent.map((sent) => sent.target)).toEqual([{ platform: "android", pushToken: "android-token" }]);
  });

  it("as wired at startup, a Mac's check leaves with the §5.4 APNs headers and payload", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const withApns: Config = { ...config, apns: { teamId: "team_1", keyId: "key_1", privateKey: pem, bundleId: "app.critalarm", environment: "production" } };
    const db = database();
    const clock = new FakeClock();
    const sent: { path: string; headers: Record<string, string>; body: string }[] = [];
    const transport = (): ApnsTransport => ({ send: async (path, headers, body) => { sent.push({ path, headers, body }); return { status: 200, headers: {}, body: "" }; }, close: () => {} });
    const checks = createChecks(withApns, { db, clock, fetch: async () => { throw new Error("no request may be made"); }, apnsTransport: transport });
    addAccount(db, "acc_1");
    addDevice(db, "dev_m", "acc_1", "macos", "aaaa0001");
    db.prepare("INSERT INTO device_checks (device_id, enabled, enrolled_at, next_attempt_at, next_due_at) VALUES ('dev_m', 1, ?, ?, ?)").run(T0, T0, T0);

    expect(await checks.scheduler?.scan()).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe("/3/device/aaaa0001");
    const { authorization, ...headers } = sent[0]!.headers;
    expect(authorization).toMatch(/^bearer /);
    expect(headers).toEqual({ "apns-topic": "app.critalarm", "apns-push-type": "background", "apns-priority": "5", "apns-expiration": "0", "content-type": "application/json" });
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["aps", "attempt", "check_id", "kind"]);
    expect(body).toMatchObject({ aps: { "content-available": 1 }, kind: "check", attempt: 1 });
    expect(db.prepare("SELECT outcome, status FROM check_attempts").all()).toEqual([{ outcome: "accepted", status: 200 }]);
  });
});
