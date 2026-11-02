import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { CANCEL_ANSWER_RETENTION_S, pruneCancelAnswers, startHistoryPrune } from "../prune.js";

// api.md §3.9. An answer is kept 365 days after it was first stored, then the
// hourly prune (§4.2) deletes it.

const NOW = 1_800_000_000;
const DAY = 86_400;

function seed() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'free', 1)").run();
  // updated_at is NOW on every row: a late change to the text must not keep
  // an answer past its first stored time.
  const add = (createdAt: number) => db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, text, app_version, platform, updated_at) VALUES ('a', ?, 'other', 'words', '1.0.0', 'ios', ?)").run(createdAt, NOW);
  add(NOW - CANCEL_ANSWER_RETENTION_S - 1);
  add(NOW - CANCEL_ANSWER_RETENTION_S);
  add(NOW - DAY);
  return db;
}

const left = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT created_at FROM cancel_answers ORDER BY created_at").all();

describe("pruneCancelAnswers", () => {
  it("keeps 365 days", () => {
    expect(CANCEL_ANSWER_RETENTION_S).toBe(365 * DAY);
  });

  it("deletes answers older than 365 days by first stored time, and keeps one exactly 365 days old", () => {
    const db = seed();
    expect(pruneCancelAnswers(db, { now: () => NOW }, "hosted")).toBe(1);
    expect(left(db)).toEqual([{ created_at: NOW - CANCEL_ANSWER_RETENTION_S }, { created_at: NOW - DAY }]);
  });

  it("does nothing outside hosted mode", () => {
    for (const mode of ["selfhosted", "relay"] as const) {
      const db = seed();
      expect(pruneCancelAnswers(db, { now: () => NOW }, mode)).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM cancel_answers").get()).toEqual({ count: 3 });
    }
  });

  it("is safe to run twice", () => {
    const db = seed();
    pruneCancelAnswers(db, { now: () => NOW }, "hosted");
    expect(pruneCancelAnswers(db, { now: () => NOW }, "hosted")).toBe(0);
  });
});

describe("the hourly run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deletes an answer once it passes 365 days, on the first run and on a later one", () => {
    const db = seed();
    let now = NOW;
    const stop = startHistoryPrune(db, { now: () => now }, "hosted", 3_600_000, 60_000);
    vi.advanceTimersByTime(60_000);
    expect(left(db)).toEqual([{ created_at: NOW - CANCEL_ANSWER_RETENTION_S }, { created_at: NOW - DAY }]);
    // An hour later the one that was exactly 365 days old is past it.
    now = NOW + 3_600;
    vi.advanceTimersByTime(3_600_000);
    expect(left(db)).toEqual([{ created_at: NOW - DAY }]);
    stop();
  });

  it("deletes nothing on a relay", () => {
    const db = seed();
    const stop = startHistoryPrune(db, { now: () => NOW }, "relay", 3_600_000, 60_000);
    vi.advanceTimersByTime(60_000 + 3_600_000);
    expect(left(db)).toHaveLength(3);
    stop();
  });
});
