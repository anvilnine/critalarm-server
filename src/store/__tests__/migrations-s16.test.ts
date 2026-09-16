import { describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";
import { authenticateAccountJoin, credentialHash } from "../../tier/auth.js";

const BEFORE_S16 = 8;
const joinTokenHash = credentialHash("aj_kept");
const topicHash = "a".repeat(64);

// A database at the version before S16, holding one of everything the rebuild
// could destroy: two accounts, devices, topics, subscriptions written with the
// old account_id column, a relay quota row, and a join token hash.
function filledAtVersion8() {
  const db = openDatabase(":memory:");
  migrate(db, BEFORE_S16);
  db.prepare("INSERT INTO accounts (id, tier, rc_app_user_id, created_at, join_token_hash) VALUES ('acc_1', 'relay', 'rc_1', 10, ?)").run(joinTokenHash);
  db.prepare("INSERT INTO accounts (id, tier, rc_app_user_id, created_at) VALUES ('acc_2', 'free', NULL, 20)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_1', 'acc_1', 'h1', 'ios', 't1', 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_2', 'acc_2', 'h2', 'android', 't2', 1)").run();
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', ?, 1, 30, 1800, 600, 'none', 1)").run(topicHash);
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', 'tk_hash', 1)").run();
  db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES ('acc_1', 'dev_1', ?)").run(topicHash);
  db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES ('acc_1', 86400, 3)").run();
  return db;
}

function referencingAccounts(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all() as { name: string; sql: string }[];
  return rows.filter((row) => /REFERENCES\s+"?accounts"?\s*\(/.test(row.sql)).map((row) => row.name).sort();
}

function columnsOf(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name).sort();
}

function planFor(db: ReturnType<typeof openDatabase>, sql: string, ...parameters: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[];
  return rows.map((row) => row.detail).join(" | ");
}

describe("S16 migrations on a database that already holds data", () => {
  it("keeps every row and every foreign key through the accounts rebuild", () => {
    const db = filledAtVersion8();
    try {
      const before = referencingAccounts(db);

      migrate(db);

      expect(db.prepare("SELECT id, tier, created_at, join_token_hash, merged_into FROM accounts ORDER BY id").all()).toEqual([
        { id: "acc_1", tier: "relay", created_at: 10, join_token_hash: joinTokenHash, merged_into: null },
        { id: "acc_2", tier: "free", created_at: 20, join_token_hash: null, merged_into: null },
      ]);
      expect(db.prepare("SELECT id, account_id FROM devices ORDER BY id").all()).toEqual([
        { id: "dev_1", account_id: "acc_1" },
        { id: "dev_2", account_id: "acc_2" },
      ]);
      expect(db.prepare("SELECT id, account_id FROM topics").all()).toEqual([{ id: "top_1", account_id: "acc_1" }]);
      expect(db.prepare("SELECT id FROM topic_tokens").all()).toEqual([{ id: "tok_1" }]);
      expect(db.prepare("SELECT device_id, topic_hash FROM subscriptions").all()).toEqual([{ device_id: "dev_1", topic_hash: topicHash }]);
      expect(db.prepare("SELECT account_id, count FROM relay_p4_usage").all()).toEqual([{ account_id: "acc_1", count: 3 }]);

      // Every table that pointed at accounts still points at accounts, not at
      // the temporary name the rebuild used. subscriptions is the one that drops
      // out, because S16 removed the column that pointed there.
      expect(before).toContain("subscriptions");
      expect(referencingAccounts(db)).toEqual(expect.arrayContaining(before.filter((name) => name !== "subscriptions")));
      expect(referencingAccounts(db)).not.toContain("subscriptions");
      expect(referencingAccounts(db)).toEqual(expect.arrayContaining(["accounts", "account_billing_ids", "billing_events", "devices", "relay_p4_usage", "tier_changes", "topics"]));
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { db.close(); }
  });

  it("drops both columns and leaves the join token working", () => {
    const db = filledAtVersion8();
    try {
      migrate(db);

      expect(columnsOf(db, "accounts")).toEqual(["created_at", "id", "join_token_hash", "merged_into", "tier"]);
      expect(columnsOf(db, "subscriptions")).toEqual(["device_id", "topic_hash"]);
      expect(authenticateAccountJoin(db, "aj_kept")).toEqual({ accountId: "acc_1", tier: "relay" });
      // The unique index on join_token_hash is recreated by hand in the rebuild,
      // because it went with the old table.
      expect(() => db.prepare("INSERT INTO accounts (id, tier, created_at, join_token_hash) VALUES ('acc_3', 'free', 30, ?)").run(joinTokenHash)).toThrow(/UNIQUE/);
    } finally { db.close(); }
  });

  it("moves the old rc_app_user_id onto account_billing_ids without changing anyone's tier", () => {
    const db = filledAtVersion8();
    try {
      migrate(db);

      expect(db.prepare("SELECT app_user_id, account_id, linked_at, last_event_at, entitled_tier FROM account_billing_ids").all()).toEqual([
        { app_user_id: "rc_1", account_id: "acc_1", linked_at: 10, last_event_at: null, entitled_tier: "relay" },
      ]);
      expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "relay" });
    } finally { db.close(); }
  });

  it("still cascades a deleted account through every child", () => {
    const db = filledAtVersion8();
    try {
      migrate(db);

      db.prepare("DELETE FROM accounts WHERE id = 'acc_1'").run();

      expect(db.prepare("SELECT id FROM devices").all()).toEqual([{ id: "dev_2" }]);
      expect(db.prepare("SELECT id FROM topics").all()).toEqual([]);
      expect(db.prepare("SELECT id FROM topic_tokens").all()).toEqual([]);
      expect(db.prepare("SELECT device_id FROM subscriptions").all()).toEqual([]);
      expect(db.prepare("SELECT account_id FROM relay_p4_usage").all()).toEqual([]);
      expect(db.prepare("SELECT app_user_id FROM account_billing_ids").all()).toEqual([]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });

  it("refuses a tombstone pointing at an account that does not exist", () => {
    const db = filledAtVersion8();
    try {
      migrate(db);

      expect(() => db.prepare("UPDATE accounts SET merged_into = 'acc_missing' WHERE id = 'acc_2'").run()).toThrow(/FOREIGN KEY/);
      db.prepare("UPDATE accounts SET merged_into = 'acc_1' WHERE id = 'acc_2'").run();
      expect(db.prepare("SELECT merged_into FROM accounts WHERE id = 'acc_2'").get()).toEqual({ merged_into: "acc_1" });
    } finally { db.close(); }
  });

  it("runs the whole list on an empty database and counts every version applied", () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db);

      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: migrationCount });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      migrate(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: migrationCount });
    } finally { db.close(); }
  });
});

describe("S16 indexes", () => {
  it("indexes the device cap count and both topic_hash lookups", () => {
    const db = filledAtVersion8();
    try {
      migrate(db);

      expect(planFor(db, "SELECT COUNT(*) AS count FROM devices WHERE account_id = ?", "acc_1")).toContain("devices_by_account");

      // push/dispatcher.ts, the subscribed devices for a delivery. It drives off
      // the new devices index and reaches subscriptions on its primary key, so
      // nothing here is a table scan.
      const dispatcher = planFor(
        db,
        "SELECT d.id FROM devices d JOIN subscriptions s ON s.device_id = d.id WHERE s.topic_hash = ? AND d.account_id = ?",
        topicHash,
        "acc_1",
      );
      expect(dispatcher).toContain("devices_by_account");
      expect(dispatcher).not.toMatch(/\bSCAN\b/);

      // relay/router.ts, the accounts a relayed push is for. No device id in the
      // filter, so this is the query that needs the topic_hash index.
      const relay = planFor(
        db,
        "SELECT DISTINCT d.account_id, a.tier FROM subscriptions s JOIN devices d ON d.id = s.device_id JOIN accounts a ON a.id = d.account_id WHERE s.topic_hash = ? AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.account_id = d.account_id AND t.topic_hash = s.topic_hash)",
        topicHash,
      );
      expect(relay).toContain("subscriptions_by_topic_hash");
      expect(relay).not.toMatch(/\bSCAN\b/);
    } finally { db.close(); }
  });
});
