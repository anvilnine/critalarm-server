import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { BillingReads } from "../billing-reads.js";
import { createTierRouter } from "../router.js";
import { createHash } from "node:crypto";
import { FakeClock, NOW, addAccount, api, billingRow, database, entitlement, linkBillingId, listing, manualFetch, queue, quietLog, scriptedFetch, settle, storedPacks, tierOf } from "./store-fakes.js";

let errors: ReturnType<typeof vi.spyOn>;
const folders: string[] = [];
beforeEach(() => { quietLog(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

// A database that refuses to store a pack, standing in for any error raised
// while a result is being written.
function breakPackWrites(db: ReturnType<typeof database>) {
  db.exec("CREATE TRIGGER refuse_pack BEFORE INSERT ON billing_packs BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
}

describe("an error after a read has taken its number", () => {
  it("is retried on the usual schedule for a customer id with no billing row, which the daily read would never find", async () => {
    const db = database();
    addAccount(db, "acc_1");
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_one', 'acc_1', ?, 'ios', 'x', 1)").run(createHash("sha256").update("dv_one").digest("hex"));
    breakPackWrites(db);
    const clock = new FakeClock();
    const store = scriptedFetch(() => listing(entitlement("ent_hosted"), entitlement("ent_pack")));
    const reads = new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 });
    const app = createTierRouter({ db, clock, ids: { account: () => "a", deviceToken: () => "d", accountJoinToken: () => "j" }, storeReads: { mode: "on", reads } });

    const response = await app.request("/relay/v1/packs/refresh", { method: "POST", headers: { Authorization: "Bearer dv_one" } });

    // Nothing was written, the call says so, and a retry is queued.
    expect(await response.json()).toMatchObject({ confirmed: false, tier: "free", packs: [] });
    expect(billingRow(db, "acc_1")).toBeUndefined();
    expect(tierOf(db, "acc_1")).toBe("free");
    expect(queue(db)).toEqual([{ app_user_id: "acc_1", due_at: NOW + 60, attempts: 1, dirty: 0 }]);
    expect(errors).toHaveBeenCalled();

    // Still broken a minute later: the next step of the schedule.
    clock.value = NOW + 60;
    await reads.scan();
    expect(queue(db)).toEqual([{ app_user_id: "acc_1", due_at: NOW + 60 + 300, attempts: 2, dirty: 0 }]);

    // Repaired. The queued retry links the purchase with nobody asking again.
    db.exec("DROP TRIGGER refuse_pack");
    clock.value = NOW + 60 + 300;
    await reads.scan();
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
    expect(queue(db)).toEqual([]);
  });

  it("changes nothing and is retried for a linked customer", async () => {
    const db = database();
    addAccount(db, "acc_1", "hosted");
    linkBillingId(db, "acc_1", "acc_1", "hosted");
    breakPackWrites(db);
    const reads = new BillingReads({ db, clock: new FakeClock(), fetch: scriptedFetch(() => listing(entitlement("ent_pack"))).fetch, api, requestGapMs: 0 });

    expect(await reads.read("acc_1", "sweep")).toEqual({ ok: false });

    // The write that lowered the tier was in the same transaction as the one
    // that threw, so it is gone with it.
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", applied_seq: 0, checked_at: null });
    expect(queue(db)).toEqual([{ app_user_id: "acc_1", due_at: NOW + 60, attempts: 1, dirty: 0 }]);
  });
});

describe("a restart in the middle of a read", () => {
  it("runs the read again from the queue with a higher number, and the read the dead process left can write nothing", async () => {
    const folder = mkdtempSync(join(tmpdir(), "billing-restart-"));
    folders.push(folder);
    const file = join(folder, "relay.sqlite");
    const clock = new FakeClock();

    // The first process: a read goes out and never comes back, and one more
    // event arrives while it is out.
    const first = openDatabase(file);
    migrate(first);
    addAccount(first, "acc_1");
    linkBillingId(first, "acc_1", "acc_1");
    const hung = manualFetch();
    const before = new BillingReads({ db: first, clock, fetch: hung.fetch, api, requestGapMs: 0 });
    before.enqueue("acc_1");
    void before.scan();
    await settle();
    expect(hung.pending).toHaveLength(1);
    before.enqueue("acc_1");
    expect(queue(first)).toMatchObject([{ app_user_id: "acc_1", dirty: 1 }]);
    expect(billingRow(first, "acc_1")).toMatchObject({ read_seq: 1, applied_seq: 0 });

    // The process dies with the read still out.
    first.close();

    // The second process opens the same file and knows nothing in memory.
    const second = openDatabase(file);
    migrate(second);
    const store = scriptedFetch(() => listing(entitlement("ent_hosted"), entitlement("ent_pack")));
    const after = new BillingReads({ db: second, clock, fetch: store.fetch, api, requestGapMs: 0 });
    await after.scan();
    await after.scan();

    expect(store.customers).toEqual(["acc_1"]);
    expect(tierOf(second, "acc_1")).toBe("hosted");
    expect(billingRow(second, "acc_1")).toMatchObject({ entitled_tier: "hosted", read_seq: 2, applied_seq: 2 });
    expect(queue(second)).toEqual([]);

    // The old read answers at last, with an empty list, into a closed handle.
    hung.pending[0]?.answer(listing());
    await settle();
    expect(tierOf(second, "acc_1")).toBe("hosted");
    expect(storedPacks(second)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
    expect(billingRow(second, "acc_1")).toMatchObject({ read_seq: 2, applied_seq: 2 });
    second.close();
  });

  it("refuses a result numbered before the restart even when it reaches the new database", async () => {
    const folder = mkdtempSync(join(tmpdir(), "billing-restart-"));
    folders.push(folder);
    const file = join(folder, "relay.sqlite");
    const clock = new FakeClock();
    const first = openDatabase(file);
    migrate(first);
    addAccount(first, "acc_1");
    linkBillingId(first, "acc_1", "acc_1");
    // A second handle on the same file, as a process that has not exited yet
    // while its replacement is already serving.
    const second = openDatabase(file);
    const hung = manualFetch();
    const before = new BillingReads({ db: first, clock, fetch: hung.fetch, api, requestGapMs: 0 });
    const old = before.read("acc_1", "sweep");
    await settle();

    const after = new BillingReads({ db: second, clock, fetch: scriptedFetch(() => listing(entitlement("ent_hosted"))).fetch, api, requestGapMs: 0 });
    expect(await after.read("acc_1", "webhook")).toEqual({ ok: true });

    hung.pending[0]?.answer(listing());
    await old;
    expect(tierOf(second, "acc_1")).toBe("hosted");
    expect(billingRow(second, "acc_1")).toMatchObject({ entitled_tier: "hosted", read_seq: 2, applied_seq: 2 });
    first.close();
    second.close();
  });
});
