import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roundAfter } from "../schedule.js";
import { DAY, HOUR, T0, WEEK, addAccount, addDevice, enrolled, grantPack, lastCheckId, setTier, setup, type Harness } from "./fakes.js";

// api.md §4.5, "When the tier changes". One test per sentence of the
// paragraph, in its order, and then the cases around it: the relay tier, a
// pack on a free account, and a round a 1.18.0 relay wrote.

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const N1 = roundAfter("dev_a", T0);

const stateRow = (harness: Harness) => harness.db.prepare("SELECT * FROM device_checks WHERE device_id = 'dev_a'").get();
const attemptsSent = (harness: Harness) => harness.sender.sent.map((sent) => sent.push.attempt);

describe("the tier is read each time a push of a round comes due", () => {
  it("a round that opened on hosted sends no second push once the account is not hosted", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    expect(attemptsSent(harness)).toEqual([1]);
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    await harness.scanAt(T0 + DAY);
    expect(attemptsSent(harness)).toEqual([1]);
  });

  it("nothing about the tier is kept in the round: off and on again between two pushes, and the next push goes", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + HOUR;
    setTier(harness.db, "acc_1", "free");
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "off", reason: "tier" });
    harness.clock.value = T0 + 2 * HOUR;
    setTier(harness.db, "acc_1", "hosted");
    await harness.scanAt(T0 + 6 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);
    // And off again before the third.
    setTier(harness.db, "acc_1", "relay");
    await harness.scanAt(T0 + 18 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 2, result: "skipped", reason: "tier", closed_at: T0 + 18 * HOUR }]);
  });

  it("a scan between two pushes reads nothing and closes nothing", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    setTier(harness.db, "acc_1", "free");
    for (let time = T0 + 60; time < T0 + 6 * HOUR; time += 20 * 60) await harness.scanAt(time);
    harness.clock.value = T0 + 6 * HOUR - 1;
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: null, closed_at: null }]);
  });
});

describe("the device stays enrolled", () => {
  it("GET answers enabled true, state off, reason tier, and keeps misses, last_sent_at and last_received_at", async () => {
    const harness = await enrolled();
    // One answered round, then one missed, so every kept value is set.
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    await harness.scanAt(N1);
    await harness.scanAt(N1 + 6 * HOUR);
    await harness.scanAt(N1 + 18 * HOUR);
    await harness.scanAt(N1 + DAY);
    const before = await harness.api.check("dev_a");
    expect(before).toMatchObject({ enabled: true, state: "missed_once", reason: null, misses: 1, last_sent_at: N1 + 18 * HOUR, last_received_at: T0 });
    const row = stateRow(harness);

    setTier(harness.db, "acc_1", "free");

    expect(await harness.api.check("dev_a")).toEqual({ enabled: true, state: "off", reason: "tier", misses: 1, last_sent_at: N1 + 18 * HOUR, last_received_at: T0, next_due_at: null, notice_after: null });
    // The change of tier wrote nothing to the device's check state.
    expect(stateRow(harness)).toEqual(row);

    // Hosted again: the same state it had, with its times back.
    setTier(harness.db, "acc_1", "hosted");
    expect(await harness.api.check("dev_a")).toEqual(before);
  });

  it("enabled true from an already enrolled device answers 403 and changes nothing", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    setTier(harness.db, "acc_1", "free");
    const row = stateRow(harness);
    const rounds = await harness.api.rounds("dev_a");

    const response = await harness.api.enable("dev_a");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "tier", tier: "hosted" });
    expect(stateRow(harness)).toEqual(row);
    expect(await harness.api.rounds("dev_a")).toEqual(rounds);
    expect((await harness.api.check("dev_a")).enabled).toBe(true);
  });

  it("enabled false still answers 200 and closes the open round as disabled, not as tier", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    setTier(harness.db, "acc_1", "free");
    harness.clock.value = T0 + HOUR;
    const response = await harness.api.disable("dev_a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, state: "off", reason: "disabled" });
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: "skipped", reason: "disabled", closed_at: T0 + HOUR }]);
  });
});

describe("a round that was open when the account left hosted", () => {
  it("is not closed at that moment", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + HOUR;
    setTier(harness.db, "acc_1", "free");
    // Read through both routes, which settle whatever is due to close.
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "off", reason: "tier" });
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ opened_at: T0, closes_at: T0 + DAY, attempts: 1, result: null, reason: null, closed_at: null }]);
    await harness.scanAt(T0 + 2 * HOUR);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: null, closed_at: null }]);
  });

  it("with a push left, closes as skipped with reason tier when that push comes due", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + HOUR;
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0 + 6 * HOUR - 1);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: null }]);

    await harness.scanAt(T0 + 6 * HOUR);

    expect(attemptsSent(harness)).toEqual([1]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ opened_at: T0, attempts: 1, result: "skipped", reason: "tier", closed_at: T0 + 6 * HOUR }]);
    // Skipped is not a miss, although a push of the round went out.
    expect((await harness.api.check("dev_a")).misses).toBe(0);
    // No attempt was put on record for the push that did not go.
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_attempts").get()).toEqual({ n: 1 });
  });

  it("with a push left that comes due late, closes when the scan gets to it", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    setTier(harness.db, "acc_1", "free");
    // The relay was busy or down past the second push's time.
    await harness.scanAt(T0 + 9 * HOUR);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: "skipped", reason: "tier", closed_at: T0 + 9 * HOUR }]);
  });

  it("with no push left, closes as it would have anyway: missed at its own close time", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2, 3]);
    harness.clock.value = T0 + 19 * HOUR;
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0 + 20 * HOUR);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: null, closed_at: null }]);

    await harness.scanAt(T0 + DAY);

    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 3, result: "missed", reason: null, closed_at: T0 + DAY }]);
    // The miss is counted and kept, and shown again once the tier is back.
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "tier", misses: 1 });
    setTier(harness.db, "acc_1", "hosted");
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "missed_once", reason: null, misses: 1 });
  });

  it("with no push left, a read that comes before the scan closes it the same way", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    setTier(harness.db, "acc_1", "free");
    harness.clock.value = T0 + DAY + 5;
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: "missed", reason: null, closed_at: T0 + DAY }]);
  });

  it("with no push left and no push accepted, closes as skipped with reason unsent, not tier", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "failed", status: 503 });
    await harness.scanAt(T0);
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0 + DAY);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 3, result: "skipped", reason: "unsent", closed_at: T0 + DAY }]);
  });
});

describe("a receipt for a round that was open when the account left hosted", () => {
  it("still counts while a push is left, and ends the round as received", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + HOUR;
    setTier(harness.db, "acc_1", "free");
    harness.clock.value = T0 + 2 * HOUR;

    const response = await harness.api.receipt("dev_a", lastCheckId(harness.sender), { attempt: 1, received_at: T0 + 3 });

    expect(response.status).toBe(200);
    // The two times are null because state is off.
    expect(await response.json()).toEqual({ counted: true, next_due_at: null, notice_after: null });
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: "received", reason: null, closed_at: T0 + 2 * HOUR, receipt_at: T0 + 2 * HOUR, attempt_received: 1 }]);
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "tier", misses: 0, last_received_at: T0 + 2 * HOUR });
    // The round is over, so the push that was left closes nothing.
    await harness.scanAt(T0 + 6 * HOUR);
    expect(await harness.api.rounds("dev_a")).toHaveLength(1);
    expect(attemptsSent(harness)).toEqual([1]);
  });

  it("still counts when no push is left, and clears a run of misses", async () => {
    const harness = await enrolled();
    // A missed first round, so there is a count to clear.
    for (const at of [T0, T0 + 6 * HOUR, T0 + 18 * HOUR, T0 + DAY]) await harness.scanAt(at);
    for (const at of [N1, N1 + 6 * HOUR, N1 + 18 * HOUR]) await harness.scanAt(at);
    setTier(harness.db, "acc_1", "free");
    harness.clock.value = N1 + 23 * HOUR;

    expect(await (await harness.api.receipt("dev_a", lastCheckId(harness.sender))).json()).toMatchObject({ counted: true });

    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "received", attempts: 3 });
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "off", reason: "tier", misses: 0, last_received_at: N1 + 23 * HOUR });
  });

  it("does not count after the round closed as skipped for the tier, and reopens nothing", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0 + 6 * HOUR);
    harness.clock.value = T0 + 7 * HOUR;
    expect(await (await harness.api.receipt("dev_a", lastCheckId(harness.sender))).json()).toMatchObject({ counted: false });
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: "skipped", reason: "tier", closed_at: T0 + 6 * HOUR, late_receipt_at: T0 + 7 * HOUR }]);
  });
});

describe("while the account stays off hosted", () => {
  it("each round that comes due is written as skipped with reason tier, weekly, and nothing is sent", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    setTier(harness.db, "acc_1", "free");

    for (let week = 0; week < 4; week += 1) {
      // A scan every six hours, as the relay would run across the week.
      for (let time = N1 + week * WEEK; time < N1 + (week + 1) * WEEK; time += 6 * HOUR) await harness.scanAt(time);
    }

    expect(attemptsSent(harness)).toEqual([1]);
    const rounds = await harness.api.rounds("dev_a");
    expect(rounds.map((round) => ({ opened_at: round.opened_at, closed_at: round.closed_at, attempts: round.attempts, result: round.result, reason: round.reason }))).toEqual([
      { opened_at: N1 + 3 * WEEK, closed_at: N1 + 3 * WEEK, attempts: 0, result: "skipped", reason: "tier" },
      { opened_at: N1 + 2 * WEEK, closed_at: N1 + 2 * WEEK, attempts: 0, result: "skipped", reason: "tier" },
      { opened_at: N1 + WEEK, closed_at: N1 + WEEK, attempts: 0, result: "skipped", reason: "tier" },
      { opened_at: N1, closed_at: N1, attempts: 0, result: "skipped", reason: "tier" },
      { opened_at: T0, closed_at: T0, attempts: 1, result: "received", reason: null },
    ]);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_attempts").get()).toEqual({ n: 1 });
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "tier", misses: 0, last_sent_at: T0, last_received_at: T0 });
  });

  it("a skipped round changes neither misses nor the last result", async () => {
    const harness = await enrolled();
    for (const at of [T0, T0 + 6 * HOUR, T0 + 18 * HOUR, T0 + DAY]) await harness.scanAt(at);
    setTier(harness.db, "acc_1", "relay");
    await harness.scanAt(N1);
    await harness.scanAt(N1 + WEEK);
    setTier(harness.db, "acc_1", "hosted");
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "missed_once", misses: 1 });
  });
});

describe("when the account is hosted again", () => {
  it("rounds go on from the next one due with no new PUT, on the schedule the device already had", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(N1);
    await harness.scanAt(N1 + WEEK);
    const enrolledAt = (stateRow(harness) as { enrolled_at: number }).enrolled_at;

    harness.clock.value = N1 + WEEK + 2 * DAY;
    setTier(harness.db, "acc_1", "hosted");

    // Nothing is made up for the weeks off: the next round is the next slot.
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "received", reason: null, next_due_at: N1 + 2 * WEEK });
    await harness.scanAt(N1 + WEEK + 3 * DAY);
    expect(attemptsSent(harness)).toEqual([1]);

    await harness.scanAt(N1 + 2 * WEEK);

    expect(attemptsSent(harness)).toEqual([1, 1]);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ opened_at: N1 + 2 * WEEK, closes_at: N1 + 2 * WEEK + DAY, attempts: 1, result: null });
    expect((stateRow(harness) as { enrolled_at: number }).enrolled_at).toBe(enrolledAt);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "received", next_due_at: N1 + 3 * WEEK });
  });

  it("back before the push that was left comes due: the round is still open and that push goes", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + HOUR;
    setTier(harness.db, "acc_1", "free");
    harness.clock.value = T0 + 5 * HOUR;
    setTier(harness.db, "acc_1", "hosted");
    await harness.scanAt(T0 + 6 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 2, result: null, reason: null }]);
  });

  it("back after the open round closed for the tier: that round stays skipped and the next one is sent", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0 + 6 * HOUR);
    setTier(harness.db, "acc_1", "hosted");
    await harness.scanAt(T0 + 18 * HOUR);
    await harness.scanAt(T0 + DAY);
    expect(attemptsSent(harness)).toEqual([1]);
    await harness.scanAt(N1);
    expect(attemptsSent(harness)).toEqual([1, 1]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ opened_at: N1, result: null }, { opened_at: T0, result: "skipped", reason: "tier" }]);
  });
});

describe("which tier gets the check", () => {
  it("relay does not, although its caps are the same as hosted", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    setTier(harness.db, "acc_1", "relay");
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(N1);
    expect(attemptsSent(harness)).toEqual([1]);
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "tier" });
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ opened_at: N1, result: "skipped", reason: "tier" }, { opened_at: T0, result: "skipped", reason: "tier" }]);
  });

  it("a free account that holds pro gets no check, enrolled or not", async () => {
    const harness = await enrolled();
    addAccount(harness.db, "acc_2", { tier: "free", pack: true });
    addDevice(harness.db, "dev_b", "acc_2");
    setTier(harness.db, "acc_1", "free");
    grantPack(harness.db, "acc_1");

    expect((await harness.api.enable("dev_b")).status).toBe(403);
    for (let time = T0; time <= N1 + WEEK; time += 6 * HOUR) await harness.scanAt(time);

    expect(harness.sender.sent).toEqual([]);
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "tier" });
    expect(await harness.api.check("dev_b")).toMatchObject({ enabled: false, state: "off", reason: "disabled" });
    expect((await harness.api.rounds("dev_a")).every((round) => round.result === "skipped" && round.reason === "tier")).toBe(true);
    expect(await harness.api.rounds("dev_b")).toEqual([]);
  });

  it("a hosted account needs no pack", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1", { tier: "hosted" });
    addDevice(harness.db, "dev_a", "acc_1");
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM account_pack_grants").get()).toEqual({ n: 0 });
    expect((await harness.api.enable("dev_a")).status).toBe(200);
    await harness.scanAt(T0);
    expect(attemptsSent(harness)).toEqual([1]);
  });

  it("one account's tier decides for every device on it and for no device on another", async () => {
    const harness = await enrolled();
    addDevice(harness.db, "dev_b", "acc_1", "android");
    addAccount(harness.db, "acc_2");
    addDevice(harness.db, "dev_c", "acc_2");
    await harness.api.enable("dev_b");
    await harness.api.enable("dev_c");
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0);
    expect(harness.sender.sent.map((sent) => sent.target.pushToken)).toEqual(["push-dev_c"]);
  });
});

describe("a round a relay closed before 1.19.0", () => {
  it("still reads back with reason pack, beside rounds written with reason tier", async () => {
    const harness = await enrolled();
    harness.db
      .prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at, closed_at, attempts, result, reason) VALUES ('rnd_old', 'dev_a', 'hash_old', ?, ?, ?, 1, 'skipped', 'pack')")
      .run(T0 - WEEK, T0 - WEEK + DAY, T0 - WEEK + 6 * HOUR);
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0);

    const response = await harness.api.call("GET", "/relay/v1/devices/dev_a/checks", "dv_a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([
      { opened_at: T0, result: "skipped", reason: "tier" },
      { id: "rnd_old", opened_at: T0 - WEEK, closed_at: T0 - WEEK + 6 * HOUR, attempts: 1, result: "skipped", reason: "pack" },
    ]);
    // Reading it, scanning past it and a change of tier leave the row as it was.
    setTier(harness.db, "acc_1", "hosted");
    await harness.scanAt(N1);
    await harness.api.check("dev_a");
    expect(harness.db.prepare("SELECT result, reason, closed_at FROM check_rounds WHERE id = 'rnd_old'").get()).toEqual({ result: "skipped", reason: "pack", closed_at: T0 - WEEK + 6 * HOUR });
  });

  it("the relay writes pack on no round now, whatever closes it", async () => {
    const harness = await enrolled();
    grantPack(harness.db, "acc_1");
    await harness.scanAt(T0);
    harness.db.prepare("DELETE FROM account_pack_grants").run();
    await harness.scanAt(T0 + 6 * HOUR);
    setTier(harness.db, "acc_1", "free");
    await harness.scanAt(T0 + 18 * HOUR);
    await harness.scanAt(N1);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_rounds WHERE reason = 'pack'").get()).toEqual({ n: 0 });
    // Losing the pack stopped nothing: the second push went.
    expect(attemptsSent(harness)).toEqual([1, 2]);
  });
});
