import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { deleteAccount, mergeAccounts } from "../accounts.js";

// api.md §3.7, §3.9 and §4.4. The erase of an account deletes its cancel
// answers and those of every account in its tombstone family, in the same
// transaction. A merge leaves an answer on the account it was written on, so
// every tombstone below is made by a real merge after its answer was written.

type Db = ReturnType<typeof openDatabase>;

const databases: Db[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const NOW = 1_760_000_000;
const clock = { now: () => NOW };
const identities = { resolve: (token: string) => (token === "sess_b" ? { userId: "usr_b" } : null) };

function addAnswer(db: Db, account: string, createdAt: number, text: string | null = "words") {
  db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, text, app_version, platform, updated_at) VALUES (?, ?, 'price', ?, '1.0.0', 'ios', 1)").run(account, createdAt, text);
}

// a, b and c each write an answer while they are separate accounts. Then a is
// merged into b, so a is a tombstone that points at b. c is somebody else.
function seed(db: Db) {
  migrate(db);
  for (const id of ["a", "b", "c"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
  db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_b', 'b', 1)").run();
  addAnswer(db, "a", 100);
  addAnswer(db, "b", 200);
  addAnswer(db, "c", 300);
  expect(mergeAccounts(db, clock, identities, "a", "sess_b", "b").status).toBe(200);
  expect(db.prepare("SELECT merged_into FROM accounts WHERE id = 'a'").get()).toEqual({ merged_into: "b" });
  return db;
}

function memory(): Db {
  const db = openDatabase(":memory:");
  databases.push(db);
  return seed(db);
}

const left = (db: Db) => db.prepare("SELECT account_id, created_at FROM cancel_answers ORDER BY account_id, created_at").all();

describe("deleteAccount and cancel answers", () => {
  it("deletes the answers of the account, of an account that later became a tombstone, and of no one else", () => {
    const db = memory();
    expect(left(db)).toHaveLength(3);
    deleteAccount(db, "b");
    expect(left(db)).toEqual([{ account_id: "c", created_at: 300 }]);
  });

  it("does the same when the erase starts from the tombstone", () => {
    const db = memory();
    deleteAccount(db, "a");
    expect(left(db)).toEqual([{ account_id: "c", created_at: 300 }]);
  });

  it("also takes an answer written on the survivor after the merge", () => {
    const db = memory();
    addAnswer(db, "b", 400, null);
    deleteAccount(db, "b");
    expect(left(db)).toEqual([{ account_id: "c", created_at: 300 }]);
  });

  it("returns the same counts it returned before cancel answers existed", () => {
    const db = memory();
    expect(deleteAccount(db, "b")).toEqual({ accounts: 2, devices: 0, topics: 0, incidents: 0, messages: 0, identities: 1, billingEventsCleared: 0 });
  });

  it("deletes the answers in the same transaction: a failing erase deletes none", () => {
    const db = memory();
    // The survivor is the last account row deleteAccount removes, after the
    // tombstone and its answers. Refusing that delete rolls the whole erase back.
    db.exec("CREATE TRIGGER stop_erase BEFORE DELETE ON accounts WHEN old.id = 'b' BEGIN SELECT RAISE(ABORT, 'stop'); END;");
    expect(() => deleteAccount(db, "b")).toThrow("stop");
    expect(left(db)).toHaveLength(3);
    expect(db.prepare("SELECT id FROM accounts ORDER BY id").all()).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });
});

// The whole path a person takes: answers sent through the route, a merge
// through the route, then DELETE /v1/account from the surviving handset.
describe("DELETE /v1/account and cancel answers", () => {
  function setup() {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db);
    for (const id of ["a", "b", "c"]) {
      db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
      // Was moved to hosted once, which is what lets the route take an answer.
      db.prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES (?, ?, 'free', 'hosted', 'test', NULL, 1)").run(`tch_${id}`, id);
      db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, ?, ?, 'ios', 'x', 1)")
        .run(`dev_${id}`, id, createHash("sha256").update(`dv_${id}`).digest("hex"));
    }
    // A better-auth session, the row the real identity resolver reads.
    db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (\'usr_1\', \'usr_1\', \'usr_1@example.com\', 0, 0, 0)').run();
    db.prepare('INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (\'ses_1\', \'2099-01-01T00:00:00.000Z\', \'sess_1\', 0, 0, \'usr_1\')').run();
    const app = createApp({
      config: { mode: "hosted", baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
      db,
      clock,
      ids: { message: () => `m_${Math.random()}`, incident: () => `inc_${Math.random()}`, timer: () => `tm_${Math.random()}` },
      dispatch: async () => {},
    });
    return { app, db };
  }

  function post(app: ReturnType<typeof setup>["app"], path: string, device: string, body: Record<string, unknown>) {
    return app.request(path, { method: "POST", headers: { Authorization: `Bearer ${device}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  it("erases the answers of the account and of its tombstone, and leaves another account's", async () => {
    const { app, db } = setup();
    for (const device of ["dv_a", "dv_b", "dv_c"]) {
      expect((await post(app, "/v1/account/cancel-reason", device, { reason: "price", text: `from ${device}`, app_version: "1.0.0+12", platform: "ios" })).status).toBe(204);
    }
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    expect((await post(app, "/v1/account/merge", "dv_a", { identity_token: "sess_1", into_account: "b" })).status).toBe(200);
    expect(db.prepare("SELECT merged_into FROM accounts WHERE id = 'a'").get()).toEqual({ merged_into: "b" });
    // The merge left a's answer on a.
    expect(db.prepare("SELECT account_id FROM cancel_answers ORDER BY account_id").all()).toEqual([{ account_id: "a" }, { account_id: "b" }, { account_id: "c" }]);

    const response = await app.request("/v1/account", { method: "DELETE", headers: { Authorization: "Bearer dv_b", "content-type": "application/json" }, body: JSON.stringify({ identity_token: "sess_1" }) });
    expect(response.status).toBe(204);
    expect(db.prepare("SELECT account_id, text FROM cancel_answers").all()).toEqual([{ account_id: "c", text: "from dv_c" }]);
  });
});

// `critalarm account delete`, run as the operator runs it, on a database file.
describe("critalarm account delete and cancel answers", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));

  function seeded(): string {
    const folder = mkdtempSync(join(tmpdir(), "critalarm-erase-"));
    folders.push(folder);
    const db = openDatabase(join(folder, "critalarm.sqlite"));
    seed(db);
    db.close();
    return folder;
  }

  function run(folder: string, ...args: string[]): string {
    return execFileSync(join(root, "node_modules", ".bin", "tsx"), [join(root, "src", "cli.ts"), ...args], {
      cwd: folder,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: folder, BASE_URL: "https://alerts.example.com", ALLOW_NOOP_PUSH: "true", NODE_ENV: "test" },
      encoding: "utf8",
    });
  }

  function answersIn(folder: string) {
    const db = openDatabase(join(folder, "critalarm.sqlite"));
    try {
      return left(db);
    } finally {
      db.close();
    }
  }

  it("deletes the answers of the account and its tombstone, by the survivor's id", () => {
    const folder = seeded();
    expect(run(folder, "account", "delete", "b")).toContain("deleted b: 2 accounts");
    expect(answersIn(folder)).toEqual([{ account_id: "c", created_at: 300 }]);
  }, 30_000);

  it("does the same given the tombstone's id", () => {
    const folder = seeded();
    expect(run(folder, "account", "delete", "a")).toContain("deleted b: 2 accounts");
    expect(answersIn(folder)).toEqual([{ account_id: "c", created_at: 300 }]);
  }, 30_000);
});
