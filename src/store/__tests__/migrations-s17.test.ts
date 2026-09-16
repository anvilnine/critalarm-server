import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";

// Migration 14 adds the identity storage: better-auth's own four tables, copied
// from what better-auth 1.7.5 generates for SQLite, plus account_identities,
// which is the map from a better-auth user to one of our `accounts` rows.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fresh() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  return db;
}

function columnsOf(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((column) => column.name).sort();
}

describe("migration 14", () => {
  it("is the fourteenth and last", () => {
    expect(migrationCount).toBe(14);
    const db = fresh();
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 14 });
  });

  it("creates better-auth's tables with the columns better-auth expects", () => {
    const db = fresh();
    expect(columnsOf(db, "user")).toEqual(["createdAt", "email", "emailVerified", "id", "image", "name", "updatedAt"]);
    expect(columnsOf(db, "session")).toEqual(["createdAt", "expiresAt", "id", "ipAddress", "token", "updatedAt", "userAgent", "userId"]);
    expect(columnsOf(db, "account")).toEqual(["accessToken", "accessTokenExpiresAt", "accountId", "createdAt", "id", "idToken", "password", "providerId", "refreshToken", "refreshTokenExpiresAt", "scope", "updatedAt", "userId"]);
    expect(columnsOf(db, "verification")).toEqual(["createdAt", "expiresAt", "id", "identifier", "updatedAt", "value"]);
  });

  it("maps one identity to one account, both ways", () => {
    const db = fresh();
    for (const id of ["acc_1", "acc_2"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_1', 'acc_1', 1)").run();
    expect(() => db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_1', 'acc_2', 1)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_2', 'acc_1', 1)").run()).toThrow();
  });

  it("drops the mapping when the account is deleted", () => {
    const db = fresh();
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_1', 'acc_1', 1)").run();
    db.prepare("DELETE FROM accounts WHERE id = 'acc_1'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_identities").get()).toEqual({ count: 0 });
  });

  it("keeps the mapping when a better-auth user is deleted, so the tenant outlives its human", () => {
    // No foreign key on user_id on purpose: better-auth owns the "user" table
    // and may rebuild it on a version upgrade, which a reference from here
    // would block.
    const db = fresh();
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
    db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, 0, 0)').run("usr_1", "one", "one@example.com");
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_1', 'acc_1', 1)").run();
    db.prepare('DELETE FROM "user" WHERE id = ?').run("usr_1");
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_identities").get()).toEqual({ count: 1 });
  });

  it("runs on a database that stopped at 13", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db, 13);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'account_identities'").get()).toEqual({ count: 0 });
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'account_identities'").get()).toEqual({ count: 1 });
  });
});
