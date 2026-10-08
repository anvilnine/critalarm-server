import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReads } from "../../tier/billing-reads.js";
import { ShadowReads } from "../../tier/billing-shadow.js";
import { api, entitlement, linkBillingId, listing, queue, scriptedFetch, type Answer } from "../../tier/__tests__/store-fakes.js";
import { HOUR, T0, addAccount, addDevice, setup } from "./fakes.js";

// api.md §4.3 and §4.5 together. The weekly check asks for the pack at every
// attempt. A pack the store gave is still held while the store cannot be read,
// even past its saved end date, so the check must go on being sent. It stops
// when a read succeeds and the store no longer lists the pack.

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const END = T0 + 2 * HOUR;

// One enrolled device whose account holds the pack from the store only, until
// END, written by a read that worked. No operator grant. The relay reads the
// store, and the routes and the scan are told so.
async function enrolledByPurchase() {
  let answer: Answer | Error = listing(entitlement("ent_pack", END * 1_000));
  const store = scriptedFetch(() => answer);
  let made: BillingReads | undefined;
  const harness = setup({
    storeReads: (db, clock) => {
      made = new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 });
      return { mode: "on", reads: made };
    },
  });
  const reads = made;
  if (reads === undefined) throw new Error("the harness built no store reads");
  addAccount(harness.db, "acc_1", { pack: false });
  addDevice(harness.db, "dev_a", "acc_1");
  linkBillingId(harness.db, "acc_1", "acc_1");
  expect(await reads.read("acc_1", "webhook")).toEqual({ ok: true });
  expect((await harness.api.enable("dev_a")).status).toBe(200);
  return { harness, reads, storeAnswers: (next: Answer | Error) => { answer = next; } };
}

describe("the weekly check while a store pack is kept past its end date", () => {
  it("keeps the round open and goes on sending across the failed reads", async () => {
    const { harness, reads, storeAnswers } = await enrolledByPurchase();
    await harness.scanAt(T0);
    expect(harness.sender.sent).toHaveLength(1);

    // The store cannot be read from before the pack's end date onwards: the
    // read an event asks for, then the retries at 1, 5, 15 and 60 minutes.
    storeAnswers({ status: 503 });
    harness.clock.value = END + 1;
    reads.enqueue("acc_1");
    await reads.scan();
    for (const wait of [60, 300, 900, 3_600]) {
      harness.clock.value += wait;
      await reads.scan();
    }
    expect(queue(harness.db)).toEqual([]);
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "waiting", reason: null });

    // The second and third pushes of the round still go out.
    await harness.scanAt(T0 + 6 * HOUR);
    expect(harness.sender.sent).toHaveLength(2);
    expect(await reads.read("acc_1", "sweep")).toEqual({ ok: false });
    await harness.scanAt(T0 + 18 * HOUR);
    expect(harness.sender.sent).toHaveLength(3);

    expect(await harness.api.rounds("dev_a")).toMatchObject([{ opened_at: T0, attempts: 3, result: null, reason: null, closed_at: null }]);
    const view = await harness.api.check("dev_a");
    expect(view).toMatchObject({ enabled: true, reason: null });
    expect(view.state).not.toBe("off");
    expect(view.next_due_at).not.toBeNull();
  });

  it("enabling the check is not refused with 403 while the pack is kept", async () => {
    const { harness, reads, storeAnswers } = await enrolledByPurchase();
    await harness.api.disable("dev_a");
    storeAnswers(new Error("connect ETIMEDOUT"));
    harness.clock.value = END + 1;
    expect(await reads.read("acc_1", "refresh")).toEqual({ ok: false });

    expect((await harness.api.enable("dev_a")).status).toBe(200);
  });

  it("closes the round as skipped with reason pack once a read succeeds and the store no longer lists the pack", async () => {
    const { harness, reads, storeAnswers } = await enrolledByPurchase();
    await harness.scanAt(T0);
    storeAnswers({ status: 503 });
    harness.clock.value = END + 1;
    expect(await reads.read("acc_1", "webhook")).toEqual({ ok: false });
    await harness.scanAt(T0 + 6 * HOUR);
    expect(harness.sender.sent).toHaveLength(2);

    storeAnswers(listing());
    harness.clock.value = T0 + 7 * HOUR;
    expect(await reads.read("acc_1", "retry")).toEqual({ ok: true });
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "pack" });

    await harness.scanAt(T0 + 18 * HOUR);
    expect(harness.sender.sent).toHaveLength(2);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 2, result: "skipped", reason: "pack", closed_at: T0 + 18 * HOUR }]);
  });
});

// No read can remove the pack there and no read failed, so its date ends it.
describe("the weekly check on a relay that does not write what the store lists", () => {
  it("closes the round as skipped with reason pack once the store pack's saved end date has passed", async () => {
    for (const shadow of [false, true]) {
      const store = scriptedFetch(() => ({ status: 503 }));
      const harness = setup(shadow ? { storeReads: (db, clock) => ({ mode: "shadow", shadow: new ShadowReads({ db, clock, fetch: store.fetch, api }) }) } : {});
      addAccount(harness.db, "acc_1", { pack: false });
      addDevice(harness.db, "dev_a", "acc_1");
      linkBillingId(harness.db, "acc_1", "acc_1");
      // A row a relay with reading on left behind.
      harness.db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('acc_1', 'pro', ?)").run(END);
      expect((await harness.api.enable("dev_a")).status).toBe(200);

      await harness.scanAt(T0);
      expect(harness.sender.sent).toHaveLength(1);
      await harness.scanAt(T0 + 6 * HOUR);
      expect(harness.sender.sent).toHaveLength(1);
      expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: "skipped", reason: "pack", closed_at: T0 + 6 * HOUR }]);
      expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "pack" });
      await harness.api.disable("dev_a");
      expect((await harness.api.enable("dev_a")).status).toBe(403);
    }
  });
});
