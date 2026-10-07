import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FcmCheckSender } from "../../push/check.js";
import { Counters } from "../../stats/counters.js";
import { AlarmNotes, alarmNoteWriter, notingAlarmPushes } from "../device-hooks.js";
import { roundAfter } from "../schedule.js";
import { CheckScheduler } from "../scheduler.js";
import { CheckStore } from "../store.js";
import { DAY, HOUR, T0, addAccount, addDevice, enrolled, grantPack, lastCheckId, removePack, setup, type Harness } from "./fakes.js";

// What happens between the moment an attempt is put on record and the moment
// its bytes leave, and what a round that closes with no receipt is called.

beforeEach(() => { for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const MINUTE = 60;

async function throughRound(harness: Harness, opensAt: number) {
  for (const offset of [0, 6 * HOUR, 18 * HOUR, DAY]) await harness.scanAt(opensAt + offset);
}

describe("what a round that closes with no receipt is called", () => {
  it("missed: a provider accepted at least one push", async () => {
    const harness = await enrolled();
    harness.sender.reply = (sent) => (sent.push.attempt === 2 ? { outcome: "accepted", status: 200 } : { outcome: "failed", status: 503 });
    await throughRound(harness, T0);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 3, result: "missed", reason: null });
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, state: "missed_once" });
  });

  it("skipped with reason unsent: the provider answered 5xx to all three pushes", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "failed", status: 503 });
    await throughRound(harness, T0);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 3, result: "skipped", reason: "unsent", closed_at: T0 + DAY });
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 0, state: "waiting", last_sent_at: null });
  });

  it("skipped with reason unsent: every send timed out or threw", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => { throw new Error("no answer"); };
    await throughRound(harness, T0);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 3, result: "skipped", reason: "unsent" });
    expect((await harness.api.check("dev_a")).misses).toBe(0);
  });

  it("skipped with reason unsent: the relay stopped between recording the attempt and sending it", async () => {
    const harness = await enrolled();
    harness.clock.value = T0;
    expect(harness.store.plan("dev_a")).toMatchObject({ attempt: 1 });
    // Down until after the round's close time.
    const after = harness.restart();
    harness.clock.value = T0 + DAY + HOUR;
    await after.scheduler.scan();
    expect(after.sender.sent).toEqual([]);
    expect((await harness.api.rounds("dev_a")).at(-1)).toMatchObject({ attempts: 1, result: "skipped", reason: "unsent", closed_at: T0 + DAY });
    expect((await harness.api.check("dev_a")).misses).toBe(0);
  });

  it("skipped with reason unsent, not held: the relay was down past the close after a held first push", async () => {
    const harness = await enrolled();
    const alarm = notingAlarmPushes({ send: async () => ({ status: 200, stale: false }) }, harness.notes, harness.clock);
    harness.clock.value = T0;
    await alarm.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, { kind: "open", topicHash: "h", topic: "t", incidentId: "inc_1", messageId: "m_1", priority: 5, maxRingS: 60, ringUntil: null, server: "", title: "", body: "", critical: true });
    await harness.scanAt(T0 + MINUTE);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 0, result: null }]);
    // The hold ended 29 minutes later. Nothing ran again until after the close.
    const after = harness.restart();
    harness.clock.value = T0 + DAY + 2 * HOUR;
    await after.scheduler.scan();
    expect((await harness.api.rounds("dev_a")).at(-1)).toMatchObject({ attempts: 0, result: "skipped", reason: "unsent" });
  });

  it("skipped with reason unsent: one push failed and the rest were held", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "failed", status: 500 });
    await harness.scanAt(T0);
    const alarm = notingAlarmPushes({ send: async () => ({ status: 200, stale: false }) }, harness.notes, harness.clock);
    for (let time = T0 + 5 * HOUR; time <= T0 + DAY + HOUR; time += 20 * MINUTE) {
      harness.clock.value = time;
      await alarm.send({ id: "dev_a", accountId: "acc_1", platform: "ios", pushToken: "t" }, { kind: "repeat", topicHash: "h", topic: "t", incidentId: "inc_1", messageId: "m_1", priority: 5, maxRingS: 60, ringUntil: null, server: "", title: "", body: "", critical: true });
      await harness.scheduler.scan();
    }
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 1, result: "skipped", reason: "unsent" });
  });

  it("a refused token stays refused", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(T0);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 1, result: "refused" });
    expect((await harness.api.check("dev_a")).misses).toBe(1);
  });

  it("an attempt on record is still never sent again, accepted or not", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "failed", status: 503 });
    await harness.scanAt(T0);
    for (let time = T0 + MINUTE; time < T0 + 6 * HOUR; time += 30 * MINUTE) await harness.scanAt(time);
    expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1]);
  });

  it("a receipt still counts when the provider's answer was not an acceptance", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "failed", status: 503 });
    await harness.scanAt(T0);
    expect(await (await harness.api.receipt("dev_a", lastCheckId(harness.sender))).json()).toMatchObject({ counted: true });
  });
});

describe("a device must still qualify when the bytes leave", () => {
  // A real FCM check sender over a fake fetch. `during` runs while the access
  // token is being fetched, which is the await between planning and sending.
  function fcmHarness(during: (harness: Harness) => void | Promise<void>) {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1", "android");
    const messages: string[] = [];
    let tokenRequests = 0;
    const sender = new FcmCheckSender({
      projectId: "p", clientEmail: "push@p.iam.gserviceaccount.com", privateKey: rsa.privateKey, tokenUrl: "https://oauth.example.test/token", clock: harness.clock,
      fetch: async (request) => {
        if (request.url === "https://oauth.example.test/token") {
          tokenRequests += 1;
          await during(harness);
          return Response.json({ access_token: "access_1", expires_in: 3_600 });
        }
        messages.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    const scheduler = new CheckScheduler(new CheckStore(harness.db, harness.clock, new Counters(harness.db, harness.clock)), { android: sender }, { notes: new AlarmNotes(alarmNoteWriter(harness.db)) });
    return { harness, scheduler, messages, tokenRequests: () => tokenRequests };
  }

  it("sends when nothing changed during token acquisition", async () => {
    const { harness, scheduler, messages } = fcmHarness(() => {});
    await harness.api.enable("dev_a");
    await scheduler.scan();
    expect(messages).toHaveLength(1);
    expect(harness.db.prepare("SELECT outcome FROM check_attempts").all()).toEqual([{ outcome: "accepted" }]);
  });

  it("pack removed during token acquisition: nothing is sent and the round ends as skipped, reason pack", async () => {
    const { harness, scheduler, messages, tokenRequests } = fcmHarness((h) => removePack(h.db, "acc_1"));
    await harness.api.enable("dev_a");
    await scheduler.scan();
    expect(tokenRequests()).toBe(1);
    expect(messages).toEqual([]);
    grantPack(harness.db, "acc_1");
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: "skipped", reason: "pack", closed_at: T0 }]);
    expect(harness.db.prepare("SELECT outcome FROM check_attempts").all()).toEqual([{ outcome: "cancelled" }]);
    expect(harness.counters.read().totals.checks_sent).toBe(0);
  });

  it("checks disabled during token acquisition: nothing is sent and the round ends as skipped, reason disabled", async () => {
    const { harness, scheduler, messages } = fcmHarness(async (h) => { await h.api.disable("dev_a"); });
    await harness.api.enable("dev_a");
    await scheduler.scan();
    expect(messages).toEqual([]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: "skipped", reason: "disabled" }]);
    expect((await harness.api.check("dev_a")).misses).toBe(0);
  });

  it("device released during token acquisition: nothing is sent and nothing is left", async () => {
    const { harness, scheduler, messages } = fcmHarness(async (h) => { await h.api.call("DELETE", "/relay/v1/devices/dev_a", "dv_a"); });
    await harness.api.enable("dev_a");
    await scheduler.scan();
    expect(messages).toEqual([]);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_rounds").get()).toEqual({ n: 0 });
    expect(harness.counters.read().totals.checks_sent).toBe(0);
  });

  it("push token removed during token acquisition: nothing is sent and the round ends as skipped, reason no_token", async () => {
    const { harness, scheduler, messages } = fcmHarness((h) => { h.db.prepare("UPDATE devices SET push_token = '' WHERE id = 'dev_a'").run(); });
    await harness.api.enable("dev_a");
    await scheduler.scan();
    expect(messages).toEqual([]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: "skipped", reason: "no_token" }]);
  });

  it("the round's close time reached during token acquisition: nothing is sent", async () => {
    const { harness, scheduler, messages } = fcmHarness((h) => { h.clock.value = T0 + DAY; });
    await harness.api.enable("dev_a");
    await scheduler.scan();
    expect(messages).toEqual([]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: "skipped", reason: "unsent" }]);
  });

  it("the same holds for the fake sender every other test uses, so APNs gets the same check through the scheduler", async () => {
    const harness = await enrolled();
    harness.sender.before = () => removePack(harness.db, "acc_1");
    await harness.scanAt(T0);
    expect(harness.sender.sent).toEqual([]);
    grantPack(harness.db, "acc_1");
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: "skipped", reason: "pack" }]);
  });
});

describe("a pass has a budget", () => {
  it("stops when the budget is spent and leaves the rest for the next tick, oldest first", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    for (const id of ["dev_a", "dev_b", "dev_c", "dev_d", "dev_e"]) {
      addDevice(harness.db, id, "acc_1");
      await harness.api.enable(id);
    }
    let ms = 0;
    // Each send takes 20 seconds of wall time.
    harness.sender.reply = () => { ms += 20_000; return { outcome: "accepted", status: 200 }; };
    const scheduler = new CheckScheduler(harness.store, { ios: harness.sender }, { budgetMs: 50_000, nowMs: () => ms });
    const order = () => harness.sender.sent.map((sent) => sent.target.pushToken.replace("push-", ""));
    expect(await scheduler.scan()).toBe(3);
    expect(order()).toEqual(["dev_a", "dev_b", "dev_c"]);
    expect(await scheduler.scan()).toBe(2);
    expect(order()).toEqual(["dev_a", "dev_b", "dev_c", "dev_d", "dev_e"]);
  });

  it("a provider call that never settles does not stall the scan", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1", "android");
    addDevice(harness.db, "dev_b", "acc_1", "android");
    await harness.api.enable("dev_a");
    await harness.api.enable("dev_b");
    const sender = new FcmCheckSender({ projectId: "p", clientEmail: "e", privateKey: rsa.privateKey, tokenUrl: "https://oauth.example.test/token", clock: harness.clock, timeoutMs: 20, fetch: () => new Promise<Response>(() => {}) });
    const scheduler = new CheckScheduler(harness.store, { android: sender });
    expect(await scheduler.scan()).toBe(2);
    expect(harness.db.prepare("SELECT attempt, outcome FROM check_attempts ORDER BY round_id").all()).toEqual([{ attempt: 1, outcome: "failed" }, { attempt: 1, outcome: "failed" }]);
    // The next pass is free to run.
    expect(await scheduler.scan()).toBe(0);
    void roundAfter;
  });
});
