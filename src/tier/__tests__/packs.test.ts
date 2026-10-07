import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { PACK_IDS, holdsPack, packRequired, packsCheckedAt, packsFor, type PackIncludes } from "../packs.js";
import type { Tier } from "../types.js";

const NOW = 1_700_000_000;
const clock = { now: () => NOW };
const TIERS: Tier[] = ["free", "relay", "hosted"];

function setup(tier: Tier = "free") {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', ?, 1)").run(tier);
  return db;
}

function link(db: ReturnType<typeof openDatabase>, appUserId: string, accountId = "acc_1", checkedAt: number | null = null) {
  db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier, checked_at) VALUES (?, ?, 1, NULL, 'free', ?)").run(appUserId, accountId, checkedAt);
}

function billingPack(db: ReturnType<typeof openDatabase>, appUserId: string, expiresAt: number | null) {
  db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES (?, 'pro', ?)").run(appUserId, expiresAt);
}

function grant(db: ReturnType<typeof openDatabase>, accountId: string, expiresAt: number | null) {
  db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES (?, 'pro', ?, 'test', 1)").run(accountId, expiresAt);
}

describe("packsFor", () => {
  it("is empty for an account that holds nothing", () => {
    const db = setup();
    expect(packsFor(db, clock, "acc_1")).toEqual([]);
  });

  it("is empty for an account id that does not exist", () => {
    const db = setup();
    expect(packsFor(db, clock, "acc_missing")).toEqual([]);
  });

  it("reports a pack one of the account's billing ids holds with no end date", () => {
    const db = setup();
    link(db, "rc_1");
    billingPack(db, "rc_1", null);
    expect(packsFor(db, clock, "acc_1")).toEqual([{ id: "pro", expires_at: null }]);
  });

  it("reports a pack whose end is in the future, and drops it once the clock reaches the end", () => {
    const db = setup();
    link(db, "rc_1");
    billingPack(db, "rc_1", NOW + 10);
    expect(packsFor(db, clock, "acc_1")).toEqual([{ id: "pro", expires_at: NOW + 10 }]);
    expect(packsFor(db, { now: () => NOW + 10 }, "acc_1")).toEqual([]);
    expect(packsFor(db, { now: () => NOW + 11 }, "acc_1")).toEqual([]);
  });

  it("does not report a pack another account's billing id holds", () => {
    const db = setup();
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'free', 1)").run();
    link(db, "rc_2", "acc_2");
    billingPack(db, "rc_2", null);
    expect(packsFor(db, clock, "acc_1")).toEqual([]);
    expect(packsFor(db, clock, "acc_2")).toEqual([{ id: "pro", expires_at: null }]);
  });

  it("reports a pack held by an operator grant, with no billing id at all", () => {
    const db = setup();
    grant(db, "acc_1", null);
    expect(packsFor(db, clock, "acc_1")).toEqual([{ id: "pro", expires_at: null }]);
  });

  it("drops a grant whose end has passed", () => {
    const db = setup();
    grant(db, "acc_1", NOW - 1);
    expect(packsFor(db, clock, "acc_1")).toEqual([]);
  });

  it("reports one entry per pack when several sources hold it, with the latest end", () => {
    const db = setup();
    link(db, "rc_1");
    link(db, "rc_2");
    billingPack(db, "rc_1", NOW + 10);
    billingPack(db, "rc_2", NOW + 500);
    grant(db, "acc_1", NOW + 50);
    expect(packsFor(db, clock, "acc_1")).toEqual([{ id: "pro", expires_at: NOW + 500 }]);
  });

  it("reports no end date when any live source has none", () => {
    const db = setup();
    link(db, "rc_1");
    billingPack(db, "rc_1", NOW + 10);
    grant(db, "acc_1", null);
    expect(packsFor(db, clock, "acc_1")).toEqual([{ id: "pro", expires_at: null }]);
  });

  it("ignores a stored pack name this server does not know", () => {
    const db = setup();
    link(db, "rc_1");
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('rc_1', 'unheard_of', NULL)").run();
    expect(packsFor(db, clock, "acc_1")).toEqual([]);
  });
});

// The include map is a mechanism with nothing in it. These tests cover the
// mechanism for every tier and every pack alike, and say nothing about which
// entries a deployment might ever set.
describe("the include map", () => {
  it("gives nothing on any tier when it is empty, which is the default", () => {
    for (const tier of TIERS) {
      const db = setup(tier);
      expect(packsFor(db, clock, "acc_1")).toEqual([]);
      expect(packsFor(db, clock, "acc_1", {})).toEqual([]);
    }
  });

  it("adds the packs listed for the account's own tier, and only for that tier", () => {
    for (const listed of TIERS) {
      for (const pack of PACK_IDS) {
        const includes: PackIncludes = { [listed]: [pack] };
        for (const tier of TIERS) {
          const db = setup(tier);
          expect(packsFor(db, clock, "acc_1", includes)).toEqual(tier === listed ? [{ id: pack, expires_at: null }] : []);
        }
      }
    }
  });
});

describe("holdsPack", () => {
  it("answers from the same list as packsFor", () => {
    const db = setup();
    expect(holdsPack(db, clock, "acc_1", "pro")).toBe(false);
    grant(db, "acc_1", null);
    expect(holdsPack(db, clock, "acc_1", "pro")).toBe(true);
  });
});

describe("packsCheckedAt", () => {
  it("is null for an account with no billing id", () => {
    const db = setup();
    expect(packsCheckedAt(db, "acc_1")).toBeNull();
  });

  it("is null when no billing id has ever been read with success", () => {
    const db = setup();
    link(db, "rc_1");
    expect(packsCheckedAt(db, "acc_1")).toBeNull();
  });

  it("is the oldest successful read among the account's billing ids", () => {
    const db = setup();
    link(db, "rc_1", "acc_1", 500);
    link(db, "rc_2", "acc_1", 300);
    link(db, "rc_3", "acc_1", null);
    expect(packsCheckedAt(db, "acc_1")).toBe(300);
  });
});

// api.md §1.8: 403 {"error":"pack","pack":"..."}.
describe("packRequired", () => {
  it("is a 403 naming the pack", async () => {
    const response = packRequired("pro");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "pack", pack: "pro" });
  });
});

describe("pack storage", () => {
  it("removes a billing id's packs when the billing id goes", () => {
    const db = setup();
    link(db, "rc_1");
    billingPack(db, "rc_1", null);
    db.prepare("DELETE FROM account_billing_ids WHERE app_user_id = 'rc_1'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM billing_packs").get()).toEqual({ count: 0 });
  });

  it("removes packs and grants when the account goes", () => {
    const db = setup();
    link(db, "rc_1");
    billingPack(db, "rc_1", null);
    grant(db, "acc_1", null);
    db.prepare("DELETE FROM accounts WHERE id = 'acc_1'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM billing_packs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_pack_grants").get()).toEqual({ count: 0 });
  });

  it("starts every existing billing id with no read on record", () => {
    const db = openDatabase(":memory:");
    migrate(db, 18);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'hosted', 1)").run();
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('rc_1', 'acc_1', 1, 7, 'hosted')").run();
    migrate(db);
    expect(db.prepare("SELECT app_user_id, account_id, linked_at, last_event_at, entitled_tier, checked_at, read_seq, applied_seq FROM account_billing_ids").all())
      .toEqual([{ app_user_id: "rc_1", account_id: "acc_1", linked_at: 1, last_event_at: 7, entitled_tier: "hosted", checked_at: null, read_seq: 0, applied_seq: 0 }]);
    expect(db.prepare("SELECT tier FROM accounts").get()).toEqual({ tier: "hosted" });
  });
});
