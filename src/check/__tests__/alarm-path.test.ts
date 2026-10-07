import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryEvent } from "../../domain-events.js";
import { ApnsSender, type ApnsTransport } from "../../push/apns.js";
import type { CheckAnswer } from "../../push/check.js";
import { PushDispatcher } from "../../push/dispatcher.js";
import type { PushDevice, PushResult, PushSender } from "../../push/types.js";
import { AlarmNotes, notingAlarmPushes } from "../device-hooks.js";
import { roundAfter } from "../schedule.js";
import { T0, addAccount, addDevice, setup, type Harness } from "./fakes.js";

// api.md §4.5, checks and alarms. The relay never delays, reorders or alters
// an alarm push because of a check, and it starts no check for a device within
// 30 minutes after an open, a repeat or a reopen to it.

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const MINUTE = 60;

function event(kind: DeliveryEvent["kind"], messageId = "m_1"): DeliveryEvent {
  return { kind, topicHash: "hash_prod", topic: "prod", incidentId: "inc_1", messageId, priority: 5, maxRingS: 1_800, ringUntil: T0 + 1_800, server: "https://alerts.example.com", title: "Database", body: "db01 is down", critical: true, relayContent: "full", accountId: "acc_1" };
}

type Wire = { path: string; headers: Record<string, string>; body: string };

// A harness with one iOS and one Android device subscribed to a topic, and a
// real alarm dispatcher over real alarm senders whose transport is a fake.
function alarmSetup(options: { noting: boolean; enrol: boolean }) {
  const harness = setup();
  addAccount(harness.db, "acc_1");
  addDevice(harness.db, "dev_a", "acc_1", "ios");
  addDevice(harness.db, "dev_b", "acc_1", "android");
  for (const id of ["dev_a", "dev_b"]) harness.db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?, 'hash_prod')").run(id);
  const wire: Wire[] = [];
  const transport: ApnsTransport = {
    send: async (path, headers, body) => {
      const { authorization: _token, ...rest } = headers;
      wire.push({ path, headers: rest, body });
      return { status: 200, headers: {}, body: "" };
    },
    close: () => {},
  };
  const apns: PushSender = new ApnsSender({ teamId: "team_1", keyId: "key_1", privateKey, bundleId: "app.critalarm", environment: "production", clock: harness.clock, transport: () => transport });
  const android: { device: PushDevice; event: DeliveryEvent }[] = [];
  const fcm: PushSender = { send: async (device, delivery) => { android.push({ device, event: delivery }); return { status: 200, stale: false }; } };
  const wrap = (sender: PushSender) => (options.noting ? notingAlarmPushes(sender, harness.notes, harness.clock) : sender);
  const dispatcher = new PushDispatcher(harness.db, { apns: wrap(apns), fcm: wrap(fcm) }, harness.clock);
  return { ...harness, wire, android, dispatcher };
}

async function enrolBoth(harness: Harness) {
  await harness.api.enable("dev_a");
  await harness.api.enable("dev_b");
}

describe("the relay never delays, reorders or alters an alarm push because of a check", () => {
  it("an alarm dispatched while a check is being sent goes out at once, in order, before the check is answered", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await enrolBoth(harness);
    const answers: ((answer: CheckAnswer) => void)[] = [];
    harness.sender.reply = () => new Promise<CheckAnswer>((resolve) => { answers.push(resolve); });

    harness.clock.value = T0;
    const scan = harness.scheduler.scan();
    await Promise.resolve();
    // The first check has left and the provider has not answered it.
    expect(harness.sender.sent).toHaveLength(1);
    expect(answers).toHaveLength(1);

    const result = await harness.dispatcher.dispatch([event("open", "m_1"), event("repeat", "m_2"), event("reopen", "m_3")]);
    expect(result).toEqual({ delivered: 6 });
    expect(harness.wire.map((sent) => (JSON.parse(sent.body) as { kind: string }).kind)).toEqual(["open", "repeat", "reopen"]);
    expect(harness.android.map((sent) => sent.event.messageId)).toEqual(["m_1", "m_2", "m_3"]);
    // Still unanswered: the alarms did not wait for it.
    expect(harness.sender.sent).toHaveLength(1);

    answers[0]?.({ outcome: "accepted", status: 200 });
    await scan;
    // The other device's check had not started when the alarm went to it, so
    // it is now held back behind the alarm.
    expect(harness.sender.sent).toHaveLength(1);
  });

  it("the alarm push is byte for byte the same with a check due, with one in flight, and with none", async () => {
    const run = async (options: { noting: boolean; enrol: boolean; inFlight: boolean }) => {
      const harness = alarmSetup(options);
      if (options.enrol) await enrolBoth(harness);
      harness.clock.value = T0;
      let scan: Promise<number> | undefined;
      if (options.inFlight) {
        harness.sender.reply = () => new Promise<CheckAnswer>(() => {});
        scan = harness.scheduler.scan();
        await Promise.resolve();
      }
      const result = await harness.dispatcher.dispatch([event("open"), event("repeat", "m_2")]);
      void scan;
      return { result, wire: harness.wire, android: harness.android };
    };
    const plain = await run({ noting: false, enrol: false, inFlight: false });
    const due = await run({ noting: true, enrol: true, inFlight: false });
    const inFlight = await run({ noting: true, enrol: true, inFlight: true });

    expect(plain.wire).toHaveLength(2);
    expect(JSON.stringify(due.wire)).toBe(JSON.stringify(plain.wire));
    expect(JSON.stringify(inFlight.wire)).toBe(JSON.stringify(plain.wire));
    expect(JSON.stringify(due.android)).toBe(JSON.stringify(plain.android));
    expect(JSON.stringify(inFlight.android)).toBe(JSON.stringify(plain.android));
    expect(due.result).toEqual(plain.result);
    expect(inFlight.result).toEqual(plain.result);
    // And it is an alarm: nothing of the check leaked into it.
    expect(plain.wire[0]?.headers).toMatchObject({ "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "inc_1" });
    expect(plain.wire[0]?.body).not.toContain("check");
  });

  it("noting an alarm push hands the device, the event and the result through untouched", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    const device: PushDevice = { id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "push-dev_a" };
    const result: PushResult = { status: 200, stale: false, apnsEnvironment: "sandbox" };
    const seen: unknown[] = [];
    const inner: PushSender = { send: async (...args) => { seen.push(args); return result; } };
    const delivery = event("open");
    const returned = await notingAlarmPushes(inner, harness.notes, harness.clock).send(device, delivery);
    expect(returned).toBe(result);
    expect(seen).toEqual([[device, delivery]]);
    expect((seen[0] as unknown[])[0]).toBe(device);
    expect((seen[0] as unknown[])[1]).toBe(delivery);
  });

  it("an error from the alarm sender is thrown on as it was", async () => {
    const harness = setup();
    const failure = new Error("apns transport failed");
    const inner: PushSender = { send: async () => { throw failure; } };
    await expect(notingAlarmPushes(inner, harness.notes, harness.clock).send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, event("open"))).rejects.toBe(failure);
  });

  it("the note is never written on the alarm path: a write that blocks or throws cannot delay or change the next alarm send", async () => {
    const harness = setup();
    const order: string[] = [];
    // A write that must not run while alarms are going out. If the wrapper
    // called it, the order below would show it between the two sends.
    const notes = new AlarmNotes((deviceId) => {
      order.push(`write ${deviceId}`);
      throw new Error("database is locked");
    });
    const result: PushResult = { status: 200, stale: false };
    const inner: PushSender = { send: async (device) => { order.push(`send ${device.id}`); return result; } };
    const sender = notingAlarmPushes(inner, notes, harness.clock);
    const devices = ["dev_a", "dev_b", "dev_c"].map((id): PushDevice => ({ id, accountId: "acc_1", platform: "ios", pushToken: id }));
    // The dispatcher's loop: one send awaited after another.
    for (const device of devices) expect(await sender.send(device, event("open"))).toBe(result);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["send dev_a", "send dev_b", "send dev_c"]);
    // Only the check scan writes, later, and a failed write is swallowed.
    expect(() => notes.flush()).not.toThrow();
    expect(order.slice(3).sort()).toEqual(["write dev_a", "write dev_b", "write dev_c"]);
  });

  it("a note that cannot even be taken never reaches the alarm", async () => {
    const harness = setup();
    const result: PushResult = { status: 200, stale: false };
    const broken = { add: () => { throw new Error("out of memory"); } } as unknown as AlarmNotes;
    const sender = notingAlarmPushes({ send: async () => result }, broken, harness.clock);
    expect(await sender.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, event("open"))).toBe(result);
    const noClock = notingAlarmPushes({ send: async () => result }, harness.notes, { now: () => { throw new Error("no clock"); } });
    expect(await noClock.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, event("open"))).toBe(result);
  });

  it("a burst of repeats to one device is one write, with the newest time", async () => {
    const harness = setup();
    const writes: [string, number][] = [];
    const notes = new AlarmNotes((deviceId, at) => { writes.push([deviceId, at]); });
    const sender = notingAlarmPushes({ send: async () => ({ status: 200, stale: false }) }, notes, harness.clock);
    for (let n = 0; n < 50; n += 1) {
      harness.clock.value = T0 + n * 30;
      await sender.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, event("repeat"));
    }
    expect(writes).toEqual([]);
    notes.flush();
    notes.flush();
    expect(writes).toEqual([["dev_a", T0 + 49 * 30]]);
  });

  it("an alarm push the provider refused, or that failed, holds nothing", async () => {
    for (const result of [{ status: 410, stale: true }, { status: 400, stale: false }, { status: 500, stale: false }, { status: 501, stale: false }, { status: 200, stale: true }] as PushResult[]) {
      const harness = setup();
      addAccount(harness.db, "acc_1");
      addDevice(harness.db, "dev_a", "acc_1");
      await harness.api.enable("dev_a");
      const sender = notingAlarmPushes({ send: async () => result }, harness.notes, harness.clock);
      harness.clock.value = T0;
      await sender.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, event("open"));
      await harness.scanAt(T0 + MINUTE);
      expect(harness.sender.sent).toHaveLength(1);
      expect(harness.db.prepare("SELECT last_alarm_push_at FROM devices WHERE id = 'dev_a'").get()).toEqual({ last_alarm_push_at: null });
    }
  });

  it("an alarm push that throws holds nothing", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    await harness.api.enable("dev_a");
    const sender = notingAlarmPushes({ send: async () => { throw new Error("transport"); } }, harness.notes, harness.clock);
    await expect(sender.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, event("open"))).rejects.toThrow("transport");
    await harness.scanAt(T0 + MINUTE);
    expect(harness.sender.sent).toHaveLength(1);
  });

  it("an alarm push the provider accepted holds the check, once the scan has taken the note", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    await harness.api.enable("dev_a");
    const sender = notingAlarmPushes({ send: async () => ({ status: 200, stale: false }) }, harness.notes, harness.clock);
    harness.clock.value = T0;
    await sender.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, event("open"));
    expect(harness.db.prepare("SELECT last_alarm_push_at FROM devices WHERE id = 'dev_a'").get()).toEqual({ last_alarm_push_at: null });
    await harness.scanAt(T0 + MINUTE);
    expect(harness.sender.sent).toEqual([]);
    expect(harness.db.prepare("SELECT last_alarm_push_at FROM devices WHERE id = 'dev_a'").get()).toEqual({ last_alarm_push_at: T0 });
  });

  it("the alarm path reads nothing the check wrote: the dispatcher sends the same with every check table gone", async () => {
    const harness = alarmSetup({ noting: false, enrol: false });
    harness.db.exec("DROP TABLE check_attempts; DROP TABLE check_rounds; DROP TABLE device_checks; DROP TABLE check_secret;");
    expect(await harness.dispatcher.dispatch([event("open")])).toEqual({ delivered: 2 });
  });
});

describe("no check is started within 30 minutes after an open, a repeat or a reopen to that device", () => {
  for (const kind of ["open", "repeat", "reopen"] as const) {
    it(`holds the first push of a round for 30 minutes after a ${kind}`, async () => {
      const harness = alarmSetup({ noting: true, enrol: true });
      await harness.api.enable("dev_a");
      harness.clock.value = T0;
      await harness.dispatcher.dispatch([event(kind)]);

      for (const time of [T0, T0 + MINUTE, T0 + 29 * MINUTE, T0 + 30 * MINUTE - 1]) {
        await harness.scanAt(time);
        expect(harness.sender.sent).toEqual([]);
      }
      // The round opened when the relay reached the device. Its push is held.
      expect(await harness.api.rounds("dev_a")).toMatchObject([{ opened_at: T0, closes_at: T0 + 86_400, attempts: 0, result: null }]);
      await harness.scanAt(T0 + 30 * MINUTE);
      expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1]);
      expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ opened_at: T0, closes_at: T0 + 86_400, attempts: 1 });
    });
  }

  it("holds a later push of an open round too, and the one after it still goes at its normal time", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    await harness.scanAt(T0);
    expect(harness.sender.sent).toHaveLength(1);
    harness.clock.value = T0 + 6 * 3_600 - 10 * MINUTE;
    await harness.dispatcher.dispatch([event("repeat")]);
    await harness.scanAt(T0 + 6 * 3_600);
    await harness.scanAt(T0 + 6 * 3_600 + 19 * MINUTE);
    expect(harness.sender.sent).toHaveLength(1);
    await harness.scanAt(T0 + 6 * 3_600 + 20 * MINUTE);
    expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1, 2]);
    await harness.scanAt(T0 + 18 * 3_600);
    expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1, 2, 3]);
    expect((await harness.api.rounds("dev_a"))[0]?.closes_at).toBe(T0 + 86_400);
  });

  it("an alarm that keeps repeating holds the check back each time", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    for (let minute = 0; minute <= 120; minute += 5) {
      harness.clock.value = T0 + minute * MINUTE;
      await harness.dispatcher.dispatch([event("repeat")]);
      await harness.scheduler.scan();
    }
    expect(harness.sender.sent).toEqual([]);
    await harness.scanAt(T0 + 150 * MINUTE);
    expect(harness.sender.sent).toHaveLength(1);
  });

  // An alarm that repeats through a whole round. Every push of the round is
  // held, none is sent, and the round is not a miss.
  const repeatThrough = async (harness: ReturnType<typeof alarmSetup>, from: number, to: number) => {
    for (let time = from; time <= to; time += 20 * MINUTE) {
      harness.clock.value = time;
      await harness.dispatcher.dispatch([event("repeat")]);
      await harness.scheduler.scan();
    }
  };

  it("a round in which every push was held ends as skipped with reason held, and misses does not change", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    await repeatThrough(harness, T0, T0 + 86_400 + 3_600);
    expect(harness.sender.sent).toEqual([]);
    expect(await harness.api.rounds("dev_a")).toEqual([{ id: expect.stringMatching(/^rnd_/), opened_at: T0, closes_at: T0 + 86_400, closed_at: T0 + 86_400, attempts: 0, result: "skipped", reason: "held", attempt_received: null, receipt_at: null, device_received_at: null, late_receipt_at: null }]);
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 0, state: "waiting" });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_attempts").get()).toEqual({ n: 0 });
  });

  it("a held round after a miss leaves misses at 1, and it is closed as held by a read with no scan", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    for (const offset of [0, 6 * 3_600, 18 * 3_600, 86_400]) await harness.scanAt(T0 + offset);
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, state: "missed_once" });
    const next = roundAfter("dev_a", T0);
    await repeatThrough(harness, next, next + 86_400 - 20 * MINUTE);
    // No scan runs past the close. Reading the state is enough.
    harness.clock.value = next + 86_400;
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, state: "missed_once" });
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "skipped", reason: "held", attempts: 0, closed_at: next + 86_400 });
  });

  it("a round whose first push went out, with the later ones held and no receipt, ends as missed", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    await harness.scanAt(T0);
    expect(harness.sender.sent).toHaveLength(1);
    await repeatThrough(harness, T0 + 5 * 3_600, T0 + 86_400 + 3_600);
    expect(harness.sender.sent).toHaveLength(1);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 1, result: "missed", reason: null, closed_at: T0 + 86_400 });
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, state: "missed_once" });
  });

  it("a round whose first pushes were held and whose last went out, with no receipt, ends as missed", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    await repeatThrough(harness, T0, T0 + 10 * 3_600);
    expect(harness.sender.sent).toEqual([]);
    // The hold lifts between the second push's time and the third's. One push
    // goes then, not two, and the third goes at its normal time.
    await harness.scanAt(T0 + 10 * 3_600 + 30 * MINUTE);
    await harness.scanAt(T0 + 10 * 3_600 + 31 * MINUTE);
    expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1]);
    await harness.scanAt(T0 + 18 * 3_600);
    expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1, 2]);
    await harness.scanAt(T0 + 86_400);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 2, result: "missed", reason: null });
  });

  it("state and notice_after after a held round are what they are after any skipped round", async () => {
    const outcome = async (how: "held" | "pack") => {
      const harness = alarmSetup({ noting: true, enrol: true });
      await harness.api.enable("dev_a");
      // One answered round first, so there is a state to keep.
      await harness.scanAt(T0);
      await harness.api.receipt("dev_a", harness.sender.sent[0]?.push.checkId ?? "");
      const next = roundAfter("dev_a", T0);
      if (how === "held") {
        await repeatThrough(harness, next, next + 86_400);
      } else {
        harness.db.prepare("DELETE FROM account_pack_grants").run();
        await harness.scanAt(next);
        harness.db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', NULL, 'test', 1)").run();
      }
      harness.clock.value = next + 86_400 + 60;
      const round = (await harness.api.rounds("dev_a"))[0];
      return { round, check: await harness.api.check("dev_a"), next };
    };
    const held = await outcome("held");
    const pack = await outcome("pack");
    expect(held.round).toMatchObject({ result: "skipped", reason: "held" });
    expect(pack.round).toMatchObject({ result: "skipped", reason: "pack" });
    expect(held.check).toEqual(pack.check);
    expect(held.check).toMatchObject({ state: "received", misses: 0, next_due_at: held.next + 7 * 86_400, notice_after: held.next + 14 * 86_400 + 86_400 });
  });

  it("a late receipt cannot arrive for a held round, because no push carried its check_id", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    await repeatThrough(harness, T0, T0 + 86_400 + 3_600);
    expect(harness.sender.sent).toEqual([]);
    expect(harness.counters.read().totals).toMatchObject({ checks_sent: 0, checks_received: 0 });
  });

  it("holds only the device the alarm went to", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    addDevice(harness.db, "dev_c", "acc_1", "ios");
    await harness.api.enable("dev_a");
    await harness.api.enable("dev_c");
    harness.clock.value = T0;
    // dev_c is not subscribed to the topic, so the alarm does not go to it.
    await harness.dispatcher.dispatch([event("open")]);
    await harness.scanAt(T0 + MINUTE);
    expect(harness.sender.sent.map((sent) => sent.target.pushToken)).toEqual(["push-dev_c"]);
  });

  it("p4, p5, ack, close and expire hold nothing", async () => {
    for (const kind of ["p4", "p5", "ack", "close", "expire"] as const) {
      const harness = alarmSetup({ noting: true, enrol: true });
      await enrolBoth(harness);
      harness.clock.value = T0;
      await harness.dispatcher.dispatch([event(kind)]);
      await harness.scanAt(T0 + MINUTE);
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM devices WHERE last_alarm_push_at IS NOT NULL").get()).toEqual({ n: 0 });
      expect(harness.sender.sent).toHaveLength(2);
    }
  });

  it("an alarm that arrives while a check is held, or just after one left, still goes out at once", async () => {
    const harness = alarmSetup({ noting: true, enrol: true });
    await harness.api.enable("dev_a");
    harness.clock.value = T0;
    await harness.dispatcher.dispatch([event("open")]);
    await harness.scanAt(T0 + MINUTE);
    expect(await harness.dispatcher.dispatch([event("repeat", "m_2")])).toEqual({ delivered: 2 });
    await harness.scanAt(T0 + 31 * MINUTE + 1);
    expect(harness.sender.sent).toHaveLength(1);
    expect(await harness.dispatcher.dispatch([event("repeat", "m_3")])).toEqual({ delivered: 2 });
    expect(harness.wire).toHaveLength(3);
  });
});
