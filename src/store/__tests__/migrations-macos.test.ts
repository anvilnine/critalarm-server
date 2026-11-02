import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";

// api.md §4.2 and §3.9, contract 1.25.0. `macos` joins `ios` and `android` as a
// device platform, in devices and in cancel_answers. Both tables carry a CHECK
// on platform, SQLite cannot change one in place, so one migration rebuilds
// both. The version is found, not named, so a migration that lands after it
// does not break this file.

type Db = ReturnType<typeof openDatabase>;

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function open(): Db {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

function macosDeviceInserts(db: Db): boolean {
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_probe', 'free', 1)").run();
      db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_probe', 'acc_probe', 'hash_probe', 'macos', 'aa', 1)").run();
      throw new Error("roll back");
    })();
  } catch (error: unknown) {
    return error instanceof Error && error.message === "roll back";
  }
  return false;
}

function versionThatAllowsMacos(): number {
  for (let version = 1; version <= migrationCount; version += 1) {
    const db = openDatabase(":memory:");
    migrate(db, version);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('devices', 'accounts')").all();
    const found = tables.length === 2 && macosDeviceInserts(db);
    db.close();
    if (found) return version;
  }
  throw new Error("no migration lets a macos device in");
}

// A database built by every migration before the rebuild, holding what a
// 1.24.0 relay writes for both old platforms: two accounts, an iPhone and an
// Android phone with every device column set, their subscriptions and tokens,
// a weekly check with a round and its attempts, and a cancel answer from each.
function beforeRebuild(): { db: Db; version: number } {
  const version = versionThatAllowsMacos();
  const db = open();
  migrate(db, version - 1);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'hosted', 1)").run();
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'free', 1)").run();
  const device = db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen, app_version, apns_environment, last_alarm_push_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  device.run("dev_ios", "acc_1", "hash_ios", "ios", "aaaa0001", 10, "1.0.0+1", "sandbox", 50);
  device.run("dev_android", "acc_1", "hash_android", "android", "fcm-token", 11, "1.0.0+2", null, null);
  device.run("dev_other", "acc_2", "hash_other", "ios", "", 12, null, null, null);
  db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_ios', 'h1'), ('dev_android', 'h1'), ('dev_other', 'h2')").run();
  const token = db.prepare("INSERT INTO device_tokens (device_id, kind, activity_id, incident_id, token, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  token.run("dev_ios", "apns", "", null, "aaaa0001", 10);
  token.run("dev_ios", "la_start", "", null, "5a01", 10);
  token.run("dev_ios", "la_update", "act_1", "inc_1", "0d01", 10);
  token.run("dev_android", "fcm", "", null, "fcm-token", 11);
  db.prepare("INSERT INTO device_checks (device_id, enabled, enrolled_at, next_attempt_at, next_due_at, round_id, misses, last_result) VALUES ('dev_ios', 1, 100, 900, 5000, 'rnd_1', 1, 'missed')").run();
  db.prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at, attempts) VALUES ('rnd_1', 'dev_ios', 'n1', 900, 1000, 1)").run();
  db.prepare("INSERT INTO check_attempts (round_id, attempt, recorded_at, outcome, status) VALUES ('rnd_1', 1, 900, 'accepted', 200)").run();
  const answer = db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, text, app_version, platform, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  answer.run("acc_1", 100, "price", "too much", "1.0.0+1", "ios", 100);
  answer.run("acc_1", 100 + 31 * 86_400, "other", null, "1.0.0+2", "android", 200);
  answer.run("acc_2", 300, "unused", null, "1.0.0", "ios", 300);
  return { db, version };
}

const snapshot = (db: Db) => ({
  devices: db.prepare("SELECT * FROM devices ORDER BY id").all(),
  subscriptions: db.prepare("SELECT * FROM subscriptions ORDER BY device_id, topic_hash").all(),
  tokens: db.prepare("SELECT * FROM device_tokens ORDER BY device_id, kind, activity_id").all(),
  checks: db.prepare("SELECT * FROM device_checks ORDER BY device_id").all(),
  rounds: db.prepare("SELECT * FROM check_rounds ORDER BY id").all(),
  attempts: db.prepare("SELECT * FROM check_attempts ORDER BY round_id, attempt").all(),
  answers: db.prepare("SELECT * FROM cancel_answers ORDER BY account_id, created_at").all(),
});

const columns = (db: Db, table: string) => db.pragma(`table_info(${table})`);
const indexes = (db: Db, table: string) => (db.pragma(`index_list(${table})`) as { name: string; unique: number; origin: string }[])
  .map((index) => ({ unique: index.unique, origin: index.origin, columns: (db.pragma(`index_info(${index.name})`) as { name: string }[]).map((column) => column.name), ...(index.origin === "c" ? { name: index.name } : {}) }))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const referencing = (db: Db, table: string) => (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all() as { name: string; sql: string }[])
  .filter((row) => new RegExp(`REFERENCES\\s+"?${table}"?\\s*\\(`).test(row.sql)).map((row) => row.name).sort();
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("migration: devices and cancel_answers accept the platform macos", () => {
  it("the old tables refuse macos, which is why they are rebuilt", () => {
    const { db } = beforeRebuild();
    expect(() => db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_mac', 'acc_1', 'hash_mac', 'macos', 'aa', 1)").run()).toThrow(/CHECK constraint/);
    expect(() => db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, app_version, platform, updated_at) VALUES ('acc_2', 9, 'price', '1', 'macos', 9)").run()).toThrow(/CHECK constraint/);
  });

  it("carries every row of both old platforms across, in both tables and every table that hangs off devices", () => {
    const { db } = beforeRebuild();
    const before = snapshot(db);
    expect(before.devices).toHaveLength(3);
    expect(before.answers).toHaveLength(3);

    migrate(db);

    expect(snapshot(db)).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("keeps the columns, the keys, the indexes and the tables that point at devices", () => {
    const { db } = beforeRebuild();
    const before = {
      devices: columns(db, "devices"), answers: columns(db, "cancel_answers"),
      deviceIndexes: indexes(db, "devices"), answerIndexes: indexes(db, "cancel_answers"),
      pointAtDevices: referencing(db, "devices"), pointAtAccounts: referencing(db, "accounts"),
    };
    expect(before.pointAtDevices).toEqual(["check_rounds", "device_checks", "device_tokens", "subscriptions"]);

    migrate(db);

    expect({
      devices: columns(db, "devices"), answers: columns(db, "cancel_answers"),
      deviceIndexes: indexes(db, "devices"), answerIndexes: indexes(db, "cancel_answers"),
      pointAtDevices: referencing(db, "devices"), pointAtAccounts: referencing(db, "accounts"),
    }).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%s50%'").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([]);
    // The unique device token hash and the primary keys still hold.
    expect(() => db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_new', 'acc_1', 'hash_ios', 'ios', 'x', 1)").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_ios', 'acc_1', 'hash_new', 'ios', 'x', 1)").run()).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, app_version, platform, updated_at) VALUES ('acc_1', 100, 'price', '1', 'ios', 1)").run()).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("a macos row inserts in both tables, and a platform outside the three is still refused", () => {
    const { db } = beforeRebuild();
    migrate(db);
    const device = db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_1', ?, ?, 'aa', 1)");
    const answer = db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, app_version, platform, updated_at) VALUES ('acc_2', ?, 'price', '1', ?, 1)");
    expect(() => device.run("dev_mac", "hash_mac", "macos")).not.toThrow();
    expect(() => answer.run(9_000_000, "macos")).not.toThrow();
    for (const platform of ["web", "macOS", "darwin", ""]) {
      expect(() => device.run(`dev_${platform}x`, `hash_${platform}x`, platform)).toThrow(/CHECK constraint/);
      expect(() => answer.run(9_000_001, platform)).toThrow(/CHECK constraint/);
    }
  });

  it("an account delete still cascades through devices, their children and cancel answers", () => {
    const { db } = beforeRebuild();
    migrate(db);
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_mac', 'acc_1', 'hash_mac', 'macos', 'aa', 1)").run();
    db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_mac', 'h1')").run();

    db.prepare("DELETE FROM accounts WHERE id = 'acc_1'").run();

    expect(db.prepare("SELECT id FROM devices").all()).toEqual([{ id: "dev_other" }]);
    expect(db.prepare("SELECT device_id FROM subscriptions").all()).toEqual([{ device_id: "dev_other" }]);
    for (const table of ["device_tokens", "device_checks", "check_rounds", "check_attempts"]) expect(count(db, table)).toBe(0);
    expect(db.prepare("SELECT account_id FROM cancel_answers").all()).toEqual([{ account_id: "acc_2" }]);
    expect(() => db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_nobody', 'h1')").run()).toThrow(/FOREIGN KEY/);
  });

  it("runs once, and a second migrate changes nothing", () => {
    const { db, version } = beforeRebuild();
    migrate(db);
    const after = snapshot(db);
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: migrationCount });
    expect(version).toBeLessThanOrEqual(migrationCount);
    migrate(db);
    expect(snapshot(db)).toEqual(after);
  });
});
