import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roundAfter } from "../schedule.js";
import { DAY, HOUR, T0, WEEK, enrolled, lastCheckId } from "./fakes.js";

// api.md §4.5, what a restart and a moved clock may and may not do. A restart
// here is a new store and a new scheduler over the same database: everything
// that was only in memory is gone.

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("after a restart", () => {
  it("an attempt on record counts as sent and is not sent again", async () => {
    const harness = await enrolled();
    // The process stops after the attempt is written and before the push goes.
    harness.clock.value = T0;
    const planned = harness.store.plan("dev_a");
    expect(planned).toMatchObject({ attempt: 1 });
    expect(harness.db.prepare("SELECT attempt, outcome FROM check_attempts").all()).toEqual([{ attempt: 1, outcome: null }]);

    const after = harness.restart();
    for (const time of [T0, T0 + 60, T0 + HOUR, T0 + 6 * HOUR - 1]) {
      harness.clock.value = time;
      await after.scheduler.scan();
    }
    expect(after.sender.sent).toEqual([]);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 1, result: null });
  });

  it("the next attempt goes at its normal time, with the same check_id", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    const first = lastCheckId(harness.sender);

    const after = harness.restart();
    harness.clock.value = T0 + 6 * HOUR;
    await after.scheduler.scan();
    expect(after.sender.sent.map((sent) => sent.push)).toEqual([{ checkId: first, attempt: 2 }]);

    const again = harness.restart();
    harness.clock.value = T0 + 18 * HOUR;
    await again.scheduler.scan();
    expect(again.sender.sent.map((sent) => sent.push)).toEqual([{ checkId: first, attempt: 3 }]);
    // One receipt answers all three.
    expect(await (await harness.api.receipt("dev_a", first)).json()).toMatchObject({ counted: true });
  });

  it("a round can have fewer than three pushes reach the provider, and never gets a repeat", async () => {
    const harness = await enrolled();
    harness.clock.value = T0;
    harness.store.plan("dev_a");
    // Restarted over and over through the whole round.
    const sent: number[] = [];
    for (let time = T0; time <= T0 + DAY + HOUR; time += 20 * 60) {
      const after = harness.restart();
      harness.clock.value = time;
      await after.scheduler.scan();
      await after.scheduler.scan();
      sent.push(...after.sender.sent.map((record) => record.push.attempt));
    }
    expect(sent).toEqual([2, 3]);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 3, result: "missed" });
  });

  it("a round open across a restart closes at its stored closes_at", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0 + 77);
    const after = harness.restart();
    // Down for two days. The round closes at the time written when it opened,
    // not at the time the relay came back.
    harness.clock.value = T0 + 77 + 2 * DAY;
    await after.scheduler.scan();
    expect((await harness.api.rounds("dev_a")).at(-1)).toMatchObject({ opened_at: T0 + 77, closes_at: T0 + 77 + DAY, closed_at: T0 + 77 + DAY, result: "missed", attempts: 1 });
    expect(after.sender.sent).toEqual([]);
  });

  it("a receipt for a round opened before the restart still counts", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    const checkId = lastCheckId(harness.sender);
    harness.restart();
    harness.clock.value = T0 + HOUR;
    expect(await (await harness.api.receipt("dev_a", checkId)).json()).toMatchObject({ counted: true });
  });

  it("two schedulers over one database never record the same attempt twice", async () => {
    const harness = await enrolled();
    const other = harness.restart();
    harness.clock.value = T0;
    await Promise.all([harness.scheduler.scan(), other.scheduler.scan()]);
    expect(harness.sender.sent.length + other.sender.sent.length).toBe(1);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_attempts").get()).toEqual({ n: 1 });
  });

  it("a scan that is still sending makes the next one do nothing", async () => {
    const harness = await enrolled();
    let release: () => void = () => {};
    harness.sender.reply = () => new Promise((resolve) => { release = () => resolve({ outcome: "accepted", status: 200 }); });
    harness.clock.value = T0;
    const first = harness.scheduler.scan();
    expect(await harness.scheduler.scan()).toBe(0);
    release();
    expect(await first).toBe(1);
  });
});

describe("a clock that moves", () => {
  it("forward: an open round closes at once, and nothing closed is reopened", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    const next = roundAfter("dev_a", T0);
    await harness.scanAt(next);
    const before = await harness.api.rounds("dev_a");

    // A month ahead. The open round closes as missed at its own close time.
    await harness.scanAt(next + 30 * DAY);
    const rounds = await harness.api.rounds("dev_a");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ id: before[0]?.id, result: "missed", closed_at: next + DAY });
    expect(rounds[1]).toEqual(before[1]);
    // The next scan opens one new round, late. It does not make up the others.
    await harness.scanAt(next + 30 * DAY + 60);
    expect(await harness.api.rounds("dev_a")).toHaveLength(3);
    expect((await harness.api.check("dev_a")).misses).toBe(1);
  });

  it("back: a closed round stays closed, and no round opens before its time", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    await harness.scanAt(T0 + DAY);
    const closed = await harness.api.rounds("dev_a");
    expect(closed[0]?.result).toBe("missed");

    for (const time of [T0 + 12 * HOUR, T0, T0 - WEEK, T0 - 400 * DAY]) {
      await harness.scanAt(time);
      expect(await harness.api.rounds("dev_a")).toEqual(closed);
    }
    expect(harness.sender.sent).toHaveLength(3);
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, state: "missed_once" });
  });

  it("back while a round is open: it stays open, keeps its closes_at and sends no attempt twice", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 - 5 * DAY);
    await harness.scanAt(T0 + HOUR);
    expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1, 2]);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ closes_at: T0 + DAY, result: null, attempts: 2 });
    // A receipt in that stretch counts: the round is open by the relay's clock.
    expect(await (await harness.api.receipt("dev_a", lastCheckId(harness.sender))).json()).toMatchObject({ counted: true });
  });
});
