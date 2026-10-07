import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReads } from "../billing-reads.js";
import { FakeClock, NOW, addAccount, api, billingRow, database, entitlement, linkBillingId, listing, logged, manualFetch, queue, quietLog, scriptedFetch, settle, storedPacks, tierOf, type TestDatabase } from "./store-fakes.js";

// api.md §4.3, "Reads for one customer never cross". Every test here drives a
// fake clock and a fake fetch that answers only when the test says so.

let log: ReturnType<typeof quietLog>;
beforeEach(() => { log = quietLog(); });
afterEach(() => { vi.restoreAllMocks(); });

function runner(db: TestDatabase, clock: FakeClock, fetch: typeof globalThis.fetch) {
  return new BillingReads({ db, clock, fetch, api, requestGapMs: 0 });
}

function start(tier: "free" | "hosted" = "free") {
  const db = database();
  addAccount(db, "acc_1", tier);
  linkBillingId(db, "acc_1", "acc_1", tier);
  return db;
}

describe("the fence on store reads", () => {
  it("a slow read that finishes after a newer one writes nothing", async () => {
    const db = start();
    const clock = new FakeClock();
    const slow = manualFetch();
    const fast = manualFetch();
    // Two runners over one database: the first is a read that outlived the
    // process that started it, which is the case one read in flight cannot
    // cover and the numbers have to.
    const before = runner(db, clock, slow.fetch);
    const after = runner(db, clock, fast.fetch);

    const first = before.read("acc_1", "webhook");
    await settle();
    const second = after.read("acc_1", "webhook");
    await settle();
    fast.pending[0]?.answer(listing(entitlement("ent_hosted"), entitlement("ent_pack")));
    expect(await second).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);

    slow.pending[0]?.answer(listing());
    await first;

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", read_seq: 2, applied_seq: 2 });
    expect(logged(log).filter((line) => line.event === "billing_read_stale")).toEqual([{ event: "billing_read_stale", app_user_id: "acc_1", trigger: "webhook", seq: 1, applied_seq: 2 }]);
  });

  it("a retry after a newer success does not roll it back", async () => {
    const db = start();
    const clock = new FakeClock();
    let answer = { status: 503 } as ReturnType<typeof listing>;
    const store = scriptedFetch(() => answer);
    const reads = runner(db, clock, store.fetch);

    expect(await reads.read("acc_1", "webhook")).toEqual({ ok: false });
    expect(queue(db)).toEqual([{ app_user_id: "acc_1", due_at: NOW + 60, attempts: 1, dirty: 0 }]);

    // A new event arrives before the retry is due, and its read works.
    answer = listing(entitlement("ent_pack"));
    reads.enqueue("acc_1");
    await reads.scan();
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
    expect(billingRow(db, "acc_1")).toMatchObject({ read_seq: 2, applied_seq: 2 });

    // The row the failure queued is gone, so the retry time passing runs nothing.
    expect(queue(db)).toEqual([]);
    clock.value += 60;
    await reads.scan();
    expect(store.customers).toHaveLength(2);

    // And a retry that ran anyway takes a higher number and writes what the
    // store says now. It does not put back what the failed read was after.
    expect(await reads.read("acc_1", "retry")).toEqual({ ok: true });
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
    expect(billingRow(db, "acc_1")).toMatchObject({ read_seq: 3, applied_seq: 3 });
  });

  it("the sweep in the middle of a refresh starts no second read and causes one more", async () => {
    const db = start();
    const clock = new FakeClock();
    const store = manualFetch();
    const reads = runner(db, clock, store.fetch);

    const refresh = reads.read("acc_1", "refresh");
    await settle();
    expect(store.pending).toHaveLength(1);

    const sweep = reads.read("acc_1", "sweep");
    await settle();
    expect(store.pending).toHaveLength(1);
    expect(queue(db)).toMatchObject([{ app_user_id: "acc_1", dirty: 1 }]);

    store.pending[0]?.answer(listing(entitlement("ent_relay")));
    await refresh;
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "relay", applied_seq: 1 });
    await settle();
    expect(store.pending).toHaveLength(2);

    clock.value += 5;
    store.pending[1]?.answer(listing(entitlement("ent_hosted")));
    expect(await sweep).toEqual({ ok: true });
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", read_seq: 2, applied_seq: 2, checked_at: NOW + 5 });
    expect(tierOf(db, "acc_1")).toBe("hosted");

    await settle();
    expect(store.pending).toHaveLength(2);
    expect(queue(db)).toEqual([]);
  });

  it("a trigger during a read runs exactly one more", async () => {
    const db = start();
    const clock = new FakeClock();
    const store = manualFetch();
    const reads = runner(db, clock, store.fetch);

    reads.enqueue("acc_1");
    void reads.scan();
    await settle();
    expect(store.pending).toHaveLength(1);

    // Three more events while that read is out.
    reads.enqueue("acc_1");
    reads.enqueue("acc_1");
    reads.enqueue("acc_1");
    void reads.scan();
    await settle();
    expect(store.pending).toHaveLength(1);

    store.pending[0]?.answer(listing());
    await settle();
    expect(store.pending).toHaveLength(2);

    store.pending[1]?.answer(listing(entitlement("ent_pack")));
    await settle();
    await reads.scan();
    expect(store.pending).toHaveLength(2);
    expect(queue(db)).toEqual([]);
    expect(billingRow(db, "acc_1")).toMatchObject({ read_seq: 2, applied_seq: 2 });
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
  });

  it("a failed read does not move the fence", async () => {
    const db = start();
    const clock = new FakeClock();
    const slow = manualFetch();
    const fast = manualFetch();
    const before = runner(db, clock, slow.fetch);
    const after = runner(db, clock, fast.fetch);

    const first = before.read("acc_1", "sweep");
    await settle();
    const second = after.read("acc_1", "webhook");
    await settle();
    fast.pending[0]?.answer(listing(entitlement("ent_hosted")));
    await second;
    const applied = billingRow(db, "acc_1");
    expect(applied).toMatchObject({ entitled_tier: "hosted", read_seq: 2, applied_seq: 2, checked_at: NOW });

    // The older read fails after the newer one was written.
    clock.value += 30;
    slow.pending[0]?.fail(new Error("socket hang up"));
    expect(await first).toEqual({ ok: false });
    expect(billingRow(db, "acc_1")).toEqual(applied);
    expect(tierOf(db, "acc_1")).toBe("hosted");

    // The next read is still accepted.
    const third = after.read("acc_1", "retry");
    await settle();
    fast.pending[1]?.answer(listing(entitlement("ent_relay")));
    expect(await third).toEqual({ ok: true });
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "relay", read_seq: 3, applied_seq: 3, checked_at: NOW + 30 });
  });

  it("ten triggers through read() during one read all wait for the same one more", async () => {
    const db = start();
    const store = manualFetch();
    const reads = runner(db, new FakeClock(), store.fetch);

    const first = reads.read("acc_1", "refresh");
    await settle();
    const waiting = Array.from({ length: 10 }, () => reads.read("acc_1", "refresh"));
    await settle();
    expect(store.pending).toHaveLength(1);

    store.pending[0]?.answer(listing());
    await first;
    await settle();
    expect(store.pending).toHaveLength(2);
    store.pending[1]?.answer(listing());
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 10 }, () => ({ ok: true })));
    await settle();
    expect(store.pending).toHaveLength(2);
  });

  it("a trigger left dirty by a process that died is run once by the next scan", async () => {
    const db = start();
    db.prepare("INSERT INTO billing_reads (app_user_id, due_at, attempts, dirty) VALUES ('acc_1', ?, 0, 1)").run(NOW + 3_600);
    const store = scriptedFetch(() => listing(entitlement("ent_relay")));
    const reads = runner(db, new FakeClock(), store.fetch);

    await reads.scan();
    await reads.scan();

    expect(store.customers).toEqual(["acc_1"]);
    expect(tierOf(db, "acc_1")).toBe("relay");
    expect(queue(db)).toEqual([]);
  });
});

// api.md §4.3, "When a read fails, nothing changes".
describe("a failed store read", () => {
  const failures: [string, () => ReturnType<typeof listing> | Error][] = [
    ["a network error", () => new Error("getaddrinfo ENOTFOUND")],
    ["a 500", () => ({ status: 500 })],
    ["a 401 from a bad key", () => ({ status: 401 })],
    ["a 429", () => ({ status: 429 })],
    ["a body that does not parse", () => ({ status: 200, body: { nothing: "useful" } })],
    ["a listing that never ends", () => ({ status: 200, body: { items: [], next_page: "/v2/projects/proj_fake/customers/acc_1/active_entitlements?starting_after=x" } })],
  ];

  for (const [name, answer] of failures) {
    it(`never lowers a hosted tier or removes a pack: ${name}`, async () => {
      const db = start("hosted");
      db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('acc_1', 'pro', NULL)").run();
      db.prepare("UPDATE account_billing_ids SET checked_at = 77, applied_seq = 4, read_seq = 4 WHERE app_user_id = 'acc_1'").run();
      const reads = runner(db, new FakeClock(), scriptedFetch(answer).fetch);

      for (const trigger of ["webhook", "retry", "refresh", "sweep"] as const) {
        expect(await reads.read("acc_1", trigger)).toEqual({ ok: false });
        expect(tierOf(db, "acc_1")).toBe("hosted");
        expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", checked_at: 77, applied_seq: 4 });
        expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM tier_changes").get()).toEqual({ count: 0 });
    });
  }

  it("is retried after 1, 5, 15 and 60 minutes, then left to the daily read", async () => {
    const db = start("hosted");
    const clock = new FakeClock();
    const store = scriptedFetch(() => ({ status: 503 }));
    const reads = runner(db, clock, store.fetch);

    reads.enqueue("acc_1");
    await reads.scan();
    expect(queue(db)).toEqual([{ app_user_id: "acc_1", due_at: NOW + 60, attempts: 1, dirty: 0 }]);

    const waits = [60, 300, 900, 3_600];
    for (const [index, wait] of waits.entries()) {
      // One second early runs nothing.
      clock.value += wait - 1;
      await reads.scan();
      expect(store.customers).toHaveLength(index + 1);
      clock.value += 1;
      await reads.scan();
      expect(store.customers).toHaveLength(index + 2);
      const next = waits[index + 1];
      expect(queue(db)).toEqual(next === undefined ? [] : [{ app_user_id: "acc_1", due_at: clock.value + next, attempts: index + 2, dirty: 0 }]);
    }

    clock.value += 86_400;
    await reads.scan();
    expect(store.customers).toHaveLength(5);
    expect(tierOf(db, "acc_1")).toBe("hosted");
  });

  it("is a failure, not an empty answer, when the store says 404 for a customer who holds something paid", async () => {
    const db = start("hosted");
    const reads = runner(db, new FakeClock(), scriptedFetch(() => ({ status: 404 })).fetch);

    expect(await reads.read("acc_1", "sweep")).toEqual({ ok: false });

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", checked_at: null, applied_seq: 0 });
    expect(logged(log)).toContainEqual({ event: "billing_read_failed", app_user_id: "acc_1", trigger: "sweep", reason: "not found for a customer who holds a paid tier or a pack", status: 404 });
  });
});
