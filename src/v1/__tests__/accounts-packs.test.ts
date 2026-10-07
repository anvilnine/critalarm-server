import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { packsFor } from "../../tier/packs.js";
import { deleteAccount, mergeAccounts } from "../accounts.js";

// api.md §3.7 and §4.3. A merged account holds the union of both sides' packs,
// and an erased account takes its packs with it.

const NOW = 1_760_000_000;
const clock = { now: () => NOW };
const identities = { resolve: (token: string) => (token === "sess_b" ? { userId: "usr_b" } : null) };

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  for (const id of ["a", "b"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
  db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_b', 'b', 1)").run();
  return db;
}

function link(db: ReturnType<typeof openDatabase>, appUserId: string, accountId: string) {
  db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES (?, ?, 1, NULL, 'free')").run(appUserId, accountId);
}

function billingPack(db: ReturnType<typeof openDatabase>, appUserId: string, expiresAt: number | null) {
  db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES (?, 'pro', ?)").run(appUserId, expiresAt);
}

function grant(db: ReturnType<typeof openDatabase>, accountId: string, expiresAt: number | null) {
  db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES (?, 'pro', ?, 'test', 1)").run(accountId, expiresAt);
}

const merge = (db: ReturnType<typeof openDatabase>) => mergeAccounts(db, clock, identities, "a", "sess_b", "b");

describe("packs across an account merge", () => {
  it("carries a pack the merged account's billing id holds", () => {
    const db = setup();
    link(db, "rc_a", "a");
    billingPack(db, "rc_a", null);

    expect(merge(db).status).toBe(200);

    expect(packsFor(db, clock, "b")).toEqual([{ id: "pro", expires_at: null }]);
    expect(packsFor(db, clock, "a")).toEqual([]);
    expect(db.prepare("SELECT app_user_id, pack FROM billing_packs").all()).toEqual([{ app_user_id: "rc_a", pack: "pro" }]);
  });

  it("keeps a pack the surviving account already held when the other side has none", () => {
    const db = setup();
    link(db, "rc_b", "b");
    billingPack(db, "rc_b", NOW + 500);

    expect(merge(db).status).toBe(200);

    expect(packsFor(db, clock, "b")).toEqual([{ id: "pro", expires_at: NOW + 500 }]);
  });

  it("carries an operator grant across", () => {
    const db = setup();
    grant(db, "a", NOW + 900);

    expect(merge(db).status).toBe(200);

    expect(packsFor(db, clock, "b")).toEqual([{ id: "pro", expires_at: NOW + 900 }]);
    expect(db.prepare("SELECT account_id, pack, expires_at FROM account_pack_grants").all()).toEqual([{ account_id: "b", pack: "pro", expires_at: NOW + 900 }]);
  });

  it("keeps the later end when both sides hold a grant, and no end date when either has none", () => {
    const later = setup();
    grant(later, "a", NOW + 900);
    grant(later, "b", NOW + 100);
    expect(merge(later).status).toBe(200);
    expect(later.prepare("SELECT account_id, expires_at FROM account_pack_grants").all()).toEqual([{ account_id: "b", expires_at: NOW + 900 }]);

    const earlier = setup();
    grant(earlier, "a", NOW + 100);
    grant(earlier, "b", NOW + 900);
    expect(merge(earlier).status).toBe(200);
    expect(earlier.prepare("SELECT account_id, expires_at FROM account_pack_grants").all()).toEqual([{ account_id: "b", expires_at: NOW + 900 }]);

    for (const [fromA, fromB] of [[null, NOW + 100], [NOW + 100, null]] as [number | null, number | null][]) {
      const db = setup();
      grant(db, "a", fromA);
      grant(db, "b", fromB);
      expect(merge(db).status).toBe(200);
      expect(db.prepare("SELECT account_id, expires_at FROM account_pack_grants").all()).toEqual([{ account_id: "b", expires_at: null }]);
    }
  });

  it("does not let a merge take a pack away from either side", () => {
    const db = setup();
    link(db, "rc_a", "a");
    link(db, "rc_b", "b");
    billingPack(db, "rc_a", NOW + 10);
    billingPack(db, "rc_b", NOW + 20);
    grant(db, "a", NOW + 30);

    expect(merge(db).status).toBe(200);

    expect(packsFor(db, clock, "b")).toEqual([{ id: "pro", expires_at: NOW + 30 }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM billing_packs").get()).toEqual({ count: 2 });
  });
});

describe("packs across an account delete", () => {
  it("erases billing packs, grants and queued reads, and leaves another account's alone", () => {
    const db = setup();
    link(db, "rc_a", "a");
    link(db, "rc_b", "b");
    billingPack(db, "rc_a", null);
    billingPack(db, "rc_b", null);
    grant(db, "a", null);
    grant(db, "b", null);
    for (const id of ["rc_a", "a", "rc_b", "b"]) db.prepare("INSERT INTO billing_reads (app_user_id, due_at, attempts, dirty) VALUES (?, 1, 0, 0)").run(id);

    deleteAccount(db, "a");

    expect(db.prepare("SELECT app_user_id FROM billing_packs").all()).toEqual([{ app_user_id: "rc_b" }]);
    expect(db.prepare("SELECT account_id FROM account_pack_grants").all()).toEqual([{ account_id: "b" }]);
    expect(db.prepare("SELECT app_user_id FROM billing_reads ORDER BY app_user_id").all()).toEqual([{ app_user_id: "b" }, { app_user_id: "rc_b" }]);
    expect(packsFor(db, clock, "a")).toEqual([]);
    expect(packsFor(db, clock, "b")).toEqual([{ id: "pro", expires_at: null }]);
  });

  it("erases the packs of the accounts that were merged into it", () => {
    const db = setup();
    link(db, "rc_a", "a");
    billingPack(db, "rc_a", null);
    grant(db, "a", null);
    expect(merge(db).status).toBe(200);
    db.prepare("INSERT INTO billing_reads (app_user_id, due_at, attempts, dirty) VALUES ('a', 1, 0, 0)").run();

    deleteAccount(db, "b");

    for (const table of ["billing_packs", "account_pack_grants", "billing_reads", "account_billing_ids"]) {
      expect([table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()]).toEqual([table, { count: 0 }]);
    }
  });
});
