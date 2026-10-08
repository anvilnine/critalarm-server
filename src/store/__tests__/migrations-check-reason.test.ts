import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate } from "../migrations.js";

// Migration 21 rebuilds check_rounds so a round can carry the reason 'tier'
// (api.md §4.5, contract 1.19.0). The old table allowed 'pack' and not 'tier'.
// The rebuilt one allows both, because a round closed before 1.19.0 keeps the
// reason it was written with. These tests read the rebuilt table back.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const ROUND_COLUMNS = "id, device_id, nonce_hash, opened_at, closes_at, closed_at, attempts, result, reason, held_until, attempt_received, receipt_at, device_received_at, late_receipt_at";

// A database at version 20, holding what a 1.18.0 relay would have written:
// an enrolled device, one round of every kind, and their attempts.
function atTwenty() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db, 20);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, app_version, last_seen) VALUES ('dev_a', 'acc_1', 'hash_a', 'ios', 'push_a', '1.0.0', 1)").run();
  db.prepare("INSERT INTO device_checks (device_id, enabled, enrolled_at, next_attempt_at, next_due_at, round_id, misses, last_result) VALUES ('dev_a', 1, 100, 900, 5000, 'rnd_open', 1, 'missed')").run();
  const round = db.prepare(`INSERT INTO check_rounds (${ROUND_COLUMNS}) VALUES (?, 'dev_a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  round.run("rnd_received", "n1", 100, 200, 105, 1, "received", null, null, 1, 105, 104, null);
  round.run("rnd_missed", "n2", 300, 400, 400, 3, "missed", null, null, null, null, null, 450);
  round.run("rnd_pack", "n3", 500, 600, 520, 1, "skipped", "pack", null, null, null, null, null);
  round.run("rnd_held", "n4", 700, 800, 800, 0, "skipped", "held", 790, null, null, null, null);
  round.run("rnd_open", "n5", 900, 1000, null, 2, null, null, null, null, null, null, null);
  const attempt = db.prepare("INSERT INTO check_attempts (round_id, attempt, recorded_at, outcome, status) VALUES (?, ?, ?, ?, ?)");
  attempt.run("rnd_received", 1, 100, "accepted", 200);
  attempt.run("rnd_missed", 1, 300, "accepted", 200);
  attempt.run("rnd_missed", 2, 320, "failed", 503);
  attempt.run("rnd_missed", 3, 360, "accepted", 200);
  attempt.run("rnd_pack", 1, 500, "accepted", 200);
  attempt.run("rnd_open", 1, 900, "accepted", 200);
  attempt.run("rnd_open", 2, 920, null, null);
  return db;
}

const rounds = (db: ReturnType<typeof openDatabase>) => db.prepare(`SELECT ${ROUND_COLUMNS} FROM check_rounds ORDER BY opened_at`).all();
const attempts = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT round_id, attempt, recorded_at, outcome, status FROM check_attempts ORDER BY round_id, attempt").all();
const state = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT * FROM device_checks").all();

describe("migration 21", () => {
  it("the old table refuses the reason tier, which is why it is rebuilt", () => {
    const db = atTwenty();
    expect(() => db.prepare("UPDATE check_rounds SET result = 'skipped', reason = 'tier' WHERE id = 'rnd_open'").run()).toThrow(/CHECK constraint/);
  });

  it("carries every round, every attempt and the device's check state across unchanged", () => {
    const db = atTwenty();
    const before = { rounds: rounds(db), attempts: attempts(db), state: state(db) };
    expect(before.rounds).toHaveLength(5);
    expect(before.attempts).toHaveLength(7);

    migrate(db);

    expect(rounds(db)).toEqual(before.rounds);
    expect(attempts(db)).toEqual(before.attempts);
    expect(state(db)).toEqual(before.state);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("a round written with reason pack keeps it", () => {
    const db = atTwenty();
    migrate(db);
    expect(db.prepare("SELECT result, reason, closed_at FROM check_rounds WHERE id = 'rnd_pack'").get()).toEqual({ result: "skipped", reason: "pack", closed_at: 520 });
  });

  it("accepts tier and every reason it accepted before, and still refuses one it does not know", () => {
    const db = atTwenty();
    migrate(db);
    const write = db.prepare("UPDATE check_rounds SET result = 'skipped', reason = ? WHERE id = 'rnd_open'");
    for (const reason of ["tier", "pack", "no_token", "disabled", "held", "unsent", null]) expect(() => write.run(reason)).not.toThrow();
    expect(() => write.run("because")).toThrow(/CHECK constraint/);
    expect(() => db.prepare("UPDATE check_rounds SET result = 'done' WHERE id = 'rnd_open'").run()).toThrow(/CHECK constraint/);
  });

  it("keeps the unique check_id hash, the primary key and both indexes", () => {
    const db = atTwenty();
    migrate(db);
    const insert = db.prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at) VALUES (?, 'dev_a', ?, 1, 2)");
    expect(() => insert.run("rnd_new", "n1")).toThrow(/UNIQUE/);
    expect(() => insert.run("rnd_pack", "n9")).toThrow(/UNIQUE|PRIMARY KEY/);
    const named = (db.pragma('index_list("check_rounds")') as { name: string; origin: string }[]).filter((index) => index.origin === "c").map((index) => index.name).sort();
    expect(named).toEqual(["check_rounds_device", "check_rounds_opened"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%s42%'").all()).toEqual([]);
  });

  it("attempts still hang off their round, and rounds off their device", () => {
    const db = atTwenty();
    migrate(db);
    expect(() => db.prepare("INSERT INTO check_attempts (round_id, attempt, recorded_at) VALUES ('rnd_nobody', 1, 1)").run()).toThrow(/FOREIGN KEY/);
    db.prepare("DELETE FROM check_rounds WHERE id = 'rnd_missed'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_attempts WHERE round_id = 'rnd_missed'").get()).toEqual({ n: 0 });
    db.prepare("DELETE FROM devices WHERE id = 'dev_a'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_rounds").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_attempts").get()).toEqual({ n: 0 });
  });

  it("runs once, and a second migrate changes nothing", () => {
    const db = atTwenty();
    migrate(db);
    const after = rounds(db);
    migrate(db);
    expect(rounds(db)).toEqual(after);
  });
});
