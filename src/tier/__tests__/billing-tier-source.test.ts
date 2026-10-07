import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReads } from "../billing-reads.js";
import { packsFor } from "../packs.js";
import { FakeClock, NOW, addAccount, api, billingRow, database, entitlement, linkBillingId, listing, quietLog, scriptedFetch, storedPacks, tierOf, type Answer } from "./store-fakes.js";

// api.md §4.3. A read of one customer id may lower the account's tier only when
// that id's own row held the tier being removed. An account can be on a paid
// tier that none of its billing rows carries: a merge only ever raises, so it
// can leave that behind, and so can a tier set by hand.

beforeEach(() => { quietLog(); });
afterEach(() => { vi.restoreAllMocks(); });

const FUTURE_MS = (NOW + 86_400) * 1_000;

function setup(accountTier: "free" | "relay" | "hosted", rows: Record<string, "free" | "relay" | "hosted">) {
  const db = database();
  addAccount(db, "acc_1", accountTier);
  for (const [appUserId, tier] of Object.entries(rows)) linkBillingId(db, appUserId, "acc_1", tier);
  const clock = new FakeClock();
  const listed = new Map<string, Answer | Error>();
  const store = scriptedFetch((appUserId) => listed.get(appUserId) ?? { status: 404 });
  const reads = new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 });
  const changes = () => db.prepare("SELECT from_tier, to_tier FROM tier_changes").all();
  return { db, clock, listed, reads, changes };
}

const triggers = ["webhook", "retry", "refresh", "sweep"] as const;

describe("a read of an id that was not the source of the account's tier", () => {
  it("does not lower a paid account when the store does not know the id", async () => {
    const { db, reads, changes } = setup("hosted", { rc_x: "free" });
    for (const trigger of triggers) {
      expect(await reads.read("rc_x", trigger)).toEqual({ ok: true });
      expect(tierOf(db, "acc_1")).toBe("hosted");
    }
    expect(changes()).toEqual([]);
  });

  it("does not lower a paid account when the store lists nothing for the id", async () => {
    const { db, listed, reads, changes } = setup("hosted", { rc_x: "free" });
    listed.set("rc_x", listing());
    expect(await reads.read("rc_x", "sweep")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "rc_x")).toMatchObject({ entitled_tier: "free", applied_seq: 1 });
    expect(changes()).toEqual([]);
  });

  it("does not lower a paid account when the list holds only a pack entitlement, and still gives the pack", async () => {
    const { db, listed, reads, changes } = setup("hosted", { rc_x: "free" });
    listed.set("rc_x", listing(entitlement("ent_pack")));
    expect(await reads.read("rc_x", "webhook")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "rc_x", pack: "pro", expires_at: null }]);
    expect(changes()).toEqual([]);
  });

  it("does not lower a paid account when a pack entitlement on that id expires", async () => {
    const { db, listed, reads } = setup("hosted", { rc_x: "free" });
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('rc_x', 'pro', NULL)").run();
    listed.set("rc_x", listing());
    expect(await reads.read("rc_x", "webhook")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([]);
  });

  it("does not lower a paid account when the list holds only an entitlement the configuration does not name", async () => {
    const { db, listed, reads, changes } = setup("hosted", { rc_x: "free" });
    listed.set("rc_x", listing(entitlement("ent_mystery", FUTURE_MS)));
    expect(await reads.read("rc_x", "sweep")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(changes()).toEqual([]);
  });

  it("does not lower an account for an id that had no billing row before the read", async () => {
    const { db, listed, reads } = setup("hosted", {});
    listed.set("acc_1", listing(entitlement("ent_pack")));
    expect(await reads.read("acc_1", "refresh")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "free" });

    listed.set("acc_1", listing(entitlement("ent_relay", FUTURE_MS)));
    expect(await reads.read("acc_1", "refresh")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
  });

  it("does not lower an account when the id lapses from a tier below the one the account is on", async () => {
    const { db, listed, reads, changes } = setup("hosted", { rc_x: "relay" });
    listed.set("rc_x", listing());
    expect(await reads.read("rc_x", "webhook")).toEqual({ ok: true });
    expect(billingRow(db, "rc_x")).toMatchObject({ entitled_tier: "free" });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(changes()).toEqual([]);
  });

  it("leaves a merged account's tier alone through a whole daily read of ids that pay for nothing", async () => {
    const { db, listed, reads } = setup("hosted", { rc_a: "free", rc_b: "free" });
    listed.set("rc_a", listing());
    listed.set("rc_b", listing(entitlement("ent_pack")));
    for (const id of ["rc_a", "rc_b", "rc_a", "rc_b"]) await reads.read(id, "sweep");
    expect(tierOf(db, "acc_1")).toBe("hosted");
  });

  it("can still raise the account", async () => {
    const { db, listed, reads, changes } = setup("relay", { rc_x: "free" });
    listed.set("rc_x", listing(entitlement("ent_hosted", FUTURE_MS)));
    expect(await reads.read("rc_x", "webhook")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(changes()).toEqual([{ from_tier: "relay", to_tier: "hosted" }]);
  });
});

describe("a read of the id that was the source of the account's tier", () => {
  it("lowers the account to free when that id no longer lists the tier", async () => {
    const { db, listed, reads, changes } = setup("hosted", { rc_x: "hosted" });
    listed.set("rc_x", listing());
    expect(await reads.read("rc_x", "webhook")).toEqual({ ok: true });
    expect(tierOf(db, "acc_1")).toBe("free");
    expect(changes()).toEqual([{ from_tier: "hosted", to_tier: "free" }]);
  });

  it("lowers the account only as far as its other ids still pay for", async () => {
    const { db, listed, reads } = setup("hosted", { rc_x: "hosted", rc_y: "relay" });
    listed.set("rc_x", listing());
    await reads.read("rc_x", "webhook");
    expect(tierOf(db, "acc_1")).toBe("relay");
  });

  it("lowers the account when the id drops from hosted to relay", async () => {
    const { db, listed, reads } = setup("hosted", { rc_x: "hosted" });
    listed.set("rc_x", listing(entitlement("ent_relay", FUTURE_MS)));
    await reads.read("rc_x", "webhook");
    expect(tierOf(db, "acc_1")).toBe("relay");
  });

  it("does not lower the account while another id still pays for the same tier", async () => {
    const { db, listed, reads, changes } = setup("hosted", { rc_x: "hosted", rc_y: "hosted" });
    listed.set("rc_x", listing());
    await reads.read("rc_x", "webhook");
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(changes()).toEqual([]);
  });

  it("still counts as failed, and lowers nothing, when the store does not know an id that holds a paid tier", async () => {
    const { db, reads } = setup("hosted", { rc_x: "hosted" });
    expect(await reads.read("rc_x", "sweep")).toEqual({ ok: false });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "rc_x")).toMatchObject({ entitled_tier: "hosted", applied_seq: 0 });
  });
});

describe("packs and the id being read", () => {
  it("removes only the packs that id's own row gave", async () => {
    const { db, clock, listed, reads } = setup("free", { rc_x: "free", rc_y: "free" });
    addAccount(db, "acc_2");
    linkBillingId(db, "rc_z", "acc_2");
    for (const id of ["rc_x", "rc_y", "rc_z"]) db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES (?, 'pro', ?)").run(id, NOW + 500);
    db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', ?, 'test', 1)").run(NOW + 100);
    listed.set("rc_x", listing());

    expect(await reads.read("rc_x", "webhook")).toEqual({ ok: true });

    expect(storedPacks(db)).toEqual([{ app_user_id: "rc_y", pack: "pro", expires_at: NOW + 500 }, { app_user_id: "rc_z", pack: "pro", expires_at: NOW + 500 }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_pack_grants").get()).toEqual({ count: 1 });
    expect(packsFor(db, clock, "acc_1")).toEqual([{ id: "pro", expires_at: NOW + 500 }]);
  });

  it("leaves a pack held by grant alone when the account's only id lists nothing", async () => {
    const { db, clock, listed, reads } = setup("free", { rc_x: "free" });
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('rc_x', 'pro', NULL)").run();
    db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', NULL, 'test', 1)").run();
    listed.set("rc_x", listing());
    await reads.read("rc_x", "sweep");
    expect(storedPacks(db)).toEqual([]);
    expect(packsFor(db, clock, "acc_1")).toEqual([{ id: "pro", expires_at: null }]);
  });
});
