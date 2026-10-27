import { describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";

// The table of api.md §3.9. The version is found, not named, so a migration
// that lands after it does not break this file.

function hasTable(db: ReturnType<typeof openDatabase>): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cancel_answers'").get() !== undefined;
}

function versionThatAddsTable(): number {
  for (let version = 1; version <= migrationCount; version += 1) {
    const db = openDatabase(":memory:");
    migrate(db, version);
    const found = hasTable(db);
    db.close();
    if (found) return version;
  }
  throw new Error("no migration adds cancel_answers");
}

const insert = (db: ReturnType<typeof openDatabase>, createdAt: number, reason: string, platform: string) =>
  db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, text, app_version, platform, updated_at) VALUES ('a', ?, ?, NULL, '1.0.0', ?, 1)").run(createdAt, reason, platform);

describe("cancel_answers", () => {
  it("is added by one migration and keeps the rows that were there", () => {
    const version = versionThatAddsTable();
    const db = openDatabase(":memory:");
    migrate(db, version - 1);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'free', 1)").run();
    db.prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES ('t', 'a', 'free', 'hosted', 'test', NULL, 1)").run();
    expect(hasTable(db)).toBe(false);
    migrate(db);
    expect(hasTable(db)).toBe(true);
    expect(db.prepare("SELECT id FROM accounts").all()).toEqual([{ id: "a" }]);
    expect(db.prepare("SELECT id FROM tier_changes").all()).toEqual([{ id: "t" }]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'cancel_answers_created'").get()).toBeDefined();
    // Running it again changes nothing.
    migrate(db);
    db.close();
  });

  it("refuses a reason outside the six, a platform outside the two, and two answers stored in the same second", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'free', 1)").run();
    expect(() => insert(db, 100, "price", "ios")).not.toThrow();
    expect(() => insert(db, 101, "expensive", "ios")).toThrow();
    expect(() => insert(db, 102, "price", "web")).toThrow();
    expect(() => insert(db, 100, "other", "android")).toThrow();
    db.close();
  });

  it("goes with the account", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'free', 1)").run();
    insert(db, 100, "other", "ios");
    db.prepare("DELETE FROM accounts WHERE id = 'a'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM cancel_answers").get()).toEqual({ count: 0 });
    db.close();
  });
});
