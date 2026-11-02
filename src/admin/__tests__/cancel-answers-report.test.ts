import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { parseSinceDate, reportCancelAnswers } from "../cancel-answers-report.js";

// api.md §4.4, `critalarm cancel-answers [--since YYYY-MM-DD]`.

type Db = ReturnType<typeof openDatabase>;

const databases: Db[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const DAY = 86_400;
const START = Date.UTC(2026, 9, 1) / 1000;

function fill(db: Db) {
  migrate(db);
  for (const id of ["acc_secret1", "acc_secret2"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
  const add = (account: string, reason: string, text: string | null, createdAt: number, platform = "ios") =>
    db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, text, app_version, platform, updated_at) VALUES (?, ?, ?, ?, '1.0.0+12', ?, ?)").run(account, createdAt, reason, text, platform, createdAt);
  add("acc_secret1", "price", null, START);
  add("acc_secret1", "price", "too much for what I use", START + DAY);
  add("acc_secret2", "selfhost", "running my own box\nnow, \"for real\"", START + 2 * DAY + 3_600, "android");
  add("acc_secret2", "unused", null, START + 2 * DAY + 7_200);
  return db;
}

function seed(): Db {
  const db = openDatabase(":memory:");
  databases.push(db);
  return fill(db);
}

describe("reportCancelAnswers", () => {
  it("prints the total, a count per reason busiest first, then each text newest first", () => {
    expect(reportCancelAnswers(seed()).split("\n")).toEqual([
      "4 answers",
      "price\t2",
      "selfhost\t1",
      "unused\t1",
      "",
      `2026-10-03\tselfhost\tandroid\t1.0.0+12\t"running my own box\\nnow, \\"for real\\""`,
      `2026-10-02\tprice\tios\t1.0.0+12\t"too much for what I use"`,
    ]);
  });

  it("keeps only answers first stored on or after the date given", () => {
    const db = seed();
    expect(reportCancelAnswers(db, START + 2 * DAY).split("\n")).toEqual([
      "2 answers",
      "selfhost\t1",
      "unused\t1",
      "",
      `2026-10-03\tselfhost\tandroid\t1.0.0+12\t"running my own box\\nnow, \\"for real\\""`,
    ]);
    // On the day itself, from midnight UTC.
    expect(reportCancelAnswers(db, START).split("\n")[0]).toBe("4 answers");
  });

  it("prints no account id", () => {
    const report = reportCancelAnswers(seed());
    expect(report).not.toContain("acc_secret");
  });

  it("says so when there is nothing", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db);
    expect(reportCancelAnswers(db)).toBe("0 answers");
  });
});

describe("parseSinceDate", () => {
  it("reads a UTC calendar date as its midnight", () => {
    expect(parseSinceDate("2026-10-01")).toBe(START);
    expect(parseSinceDate("2028-02-29")).toBe(Date.UTC(2028, 1, 29) / 1000);
  });

  it("refuses anything that is not a real YYYY-MM-DD date", () => {
    for (const given of ["tomorrow", "", "2026-10-1", "2026-13-01", "2026-02-31", "2027-02-29", "2026-10-01T00:00:00Z", " 2026-10-01"]) {
      expect([given, parseSinceDate(given)]).toEqual([given, undefined]);
    }
  });
});

// The command as the operator runs it, on a data folder.
describe("critalarm cancel-answers", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const usage = "usage: critalarm token show|rotate\n       critalarm stats zero-key <relay_key>\n       critalarm account delete <acc_id>|--email <address>\n       critalarm cancel-answers [--since YYYY-MM-DD]\n";

  function folder(withAnswers: boolean): string {
    const made = mkdtempSync(join(tmpdir(), "critalarm-answers-"));
    folders.push(made);
    if (withAnswers) {
      const db = openDatabase(join(made, "critalarm.sqlite"));
      fill(db);
      db.close();
    }
    return made;
  }

  function run(dataDir: string, ...args: string[]) {
    return spawnSync(join(root, "node_modules", ".bin", "tsx"), [join(root, "src", "cli.ts"), "cancel-answers", ...args], {
      cwd: dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dataDir, BASE_URL: "https://alerts.example.com", ALLOW_NOOP_PUSH: "true", NODE_ENV: "test" },
      encoding: "utf8",
    });
  }

  it("prints the report, and filters by --since", () => {
    const dataDir = folder(true);
    const all = run(dataDir);
    expect([all.status, all.stderr]).toEqual([0, ""]);
    expect(all.stdout.split("\n")[0]).toBe("4 answers");
    expect(all.stdout).not.toContain("acc_secret");
    const since = run(dataDir, "--since", "2026-10-03");
    expect([since.status, since.stdout.split("\n")[0]]).toEqual([0, "2 answers"]);
  }, 30_000);

  it("prints 0 answers on an empty data folder", () => {
    const result = run(folder(false));
    expect([result.status, result.stdout, result.stderr]).toEqual([0, "0 answers\n", ""]);
  }, 30_000);

  it("exits 2 with the usage line on a bad date, a missing date or an unknown flag", () => {
    const dataDir = folder(true);
    for (const args of [["--since", "tomorrow"], ["--since", "2026-02-31"], ["--since"], ["--until", "2026-10-01"], ["--since", "2026-10-01", "extra"]]) {
      const result = run(dataDir, ...args);
      expect([args, result.status, result.stdout, result.stderr]).toEqual([args, 2, "", usage]);
    }
  }, 60_000);
});
