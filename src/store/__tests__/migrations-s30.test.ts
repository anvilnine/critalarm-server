import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";

// Migration 15 rebuilds account_identities without the UNIQUE on account_id, so
// one account can hold a Google identity and an Apple one (api.md §3.7,
// contract 1.14.0). SQLite cannot drop a constraint in place, so the table is
// rebuilt and every row copied across. These tests read the rebuilt table back
// rather than trusting that the migration returned.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// A database at version 14, which is where the UNIQUE still stands, holding the
// rows a 1.13.0 server would have written.
function atFourteen() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db, 14);
  for (const id of ["acc_1", "acc_2", "acc_3"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
  for (const [user, account, at] of [["usr_1", "acc_1", 111], ["usr_2", "acc_2", 222], ["usr_3", "acc_3", 333]]) {
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES (?, ?, ?)").run(user, account, at);
  }
  return db;
}

function identityRows(db: ReturnType<typeof openDatabase>) {
  return db.prepare("SELECT user_id, account_id, linked_at FROM account_identities ORDER BY user_id").all();
}

type IndexRow = { name: string; unique: number; origin: string };

// Every index on the table, with the column each one covers. `origin` is "u"
// for an index SQLite made for a UNIQUE constraint, "pk" for the primary key's
// own, and "c" for one a CREATE INDEX made. Telling them apart matters: the
// primary key on user_id is a unique index too and it is meant to stay.
function indexesOn(db: ReturnType<typeof openDatabase>, table: string) {
  return (db.pragma(`index_list("${table}")`) as IndexRow[]).map((index) => ({
    name: index.name,
    unique: index.unique,
    origin: index.origin,
    columns: (db.pragma(`index_info("${index.name}")`) as { name: string }[]).map((column) => column.name),
  }));
}

describe("migration 15", () => {
  // Version 16, the topic token names, and version 17, the per-device APNs
  // environment, both landed after this one, so the list is two longer than it
  // was.
  it("the list is seventeen long", () => {
    expect(migrationCount).toBe(17);
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 17 });
  });

  it("carries every row across the rebuild with the same user_id and account_id", () => {
    const db = atFourteen();
    const before = identityRows(db);
    expect(before).toHaveLength(3);

    migrate(db);

    // Read out of the rebuilt table, row by row. The rebuild renames a new
    // table into place, so a copy that dropped rows or reordered the columns
    // would show up right here and nowhere else.
    expect(identityRows(db)).toEqual(before);
    expect(identityRows(db)).toEqual([
      { user_id: "usr_1", account_id: "acc_1", linked_at: 111 },
      { user_id: "usr_2", account_id: "acc_2", linked_at: 222 },
      { user_id: "usr_3", account_id: "acc_3", linked_at: 333 },
    ]);
  });

  it("lets one account hold two identities, and refuses one identity two accounts", () => {
    const db = atFourteen();
    migrate(db);

    // The whole point of 1.14.0: Google on one handset, Apple on the other.
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_4', 'acc_1', 444)").run();
    expect(db.prepare("SELECT user_id FROM account_identities WHERE account_id = 'acc_1' ORDER BY user_id").all()).toEqual([
      { user_id: "usr_1" },
      { user_id: "usr_4" },
    ]);

    // user_id is still the primary key: one sign-in identity still points at
    // exactly one account.
    expect(() => db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_1', 'acc_2', 1)").run()).toThrow();
  });

  it("leaves the unique index gone and a plain one on account_id in its place", () => {
    const db = atFourteen();
    const uniqueOnAccount = (db: ReturnType<typeof openDatabase>) =>
      indexesOn(db, "account_identities").some((index) => index.unique === 1 && index.columns.includes("account_id"));
    expect(uniqueOnAccount(db)).toBe(true);

    migrate(db);

    expect(uniqueOnAccount(db)).toBe(false);
    // The lookup that used to ride on the unique index still has one.
    expect(indexesOn(db, "account_identities")).toContainEqual({ name: "account_identities_account_id", unique: 0, origin: "c", columns: ["account_id"] });
    // And the primary key's own unique index is still there.
    expect(indexesOn(db, "account_identities").some((index) => index.origin === "pk" && index.columns.includes("user_id"))).toBe(true);
  });

  it("keeps the cascade from accounts, so an erased account still takes its identities", () => {
    const db = atFourteen();
    migrate(db);
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_4', 'acc_1', 444)").run();

    db.prepare("DELETE FROM accounts WHERE id = 'acc_1'").run();

    expect(identityRows(db)).toEqual([
      { user_id: "usr_2", account_id: "acc_2", linked_at: 222 },
      { user_id: "usr_3", account_id: "acc_3", linked_at: 333 },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("leaves every other table alone", () => {
    const db = atFourteen();
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_1', 'acc_1', 'hash', 'ios', 'p', 1)").run();
    db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, 0, 0)').run("usr_1", "one", "one@example.com");

    migrate(db);

    // The rebuild in migration 3 had to fight a rename that moved every child's
    // REFERENCES clause. Nothing references account_identities, so nothing
    // should have moved here, and the neighbours prove it.
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE '%_s30_%'").get()).toEqual({ count: 0 });
  });

  it("runs on a database that holds no identities at all", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db, 14);
    migrate(db);
    expect(identityRows(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 17 });
  });
});
