import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";

const databases: Database.Database[] = [];
afterEach(() => { while (databases.length > 0) databases.pop()?.close(); });

const insert = "INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at) VALUES (?,?,'1',?,1)";

// api.md §4.1, 1.20.0. A key issued before the migration has no proven base_url.
describe("the relay key legacy migration", () => {
  function before() {
    const db = openDatabase(":memory:");
    databases.push(db);
    // The legacy migration is the one before the relay name column.
    migrate(db, migrationCount - 2);
    return db;
  }

  it("marks every existing row legacy, even rows that share a base_url", () => {
    const db = before();
    db.prepare(insert).run("r1", "https://a.example.com", "k1");
    db.prepare(insert).run("r2", "https://a.example.com", "k2");
    migrate(db);
    expect(db.prepare("SELECT id, legacy FROM relay_servers ORDER BY id").all()).toEqual([{ id: "r1", legacy: 1 }, { id: "r2", legacy: 1 }]);
  });

  it("gives a row inserted afterwards legacy 0", () => {
    const db = before();
    migrate(db);
    db.prepare(insert).run("r3", "https://a.example.com", "k3");
    expect(db.prepare("SELECT legacy FROM relay_servers").get()).toEqual({ legacy: 0 });
  });

  it("allows two legacy rows with one base_url and refuses two new ones", () => {
    const db = before();
    migrate(db);
    const legacy = db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at,legacy) VALUES (?,?,'1',?,1,1)");
    legacy.run("l1", "https://a.example.com", "k1");
    legacy.run("l2", "https://a.example.com", "k2");
    db.prepare(insert).run("n1", "https://a.example.com", "k3");
    expect(() => db.prepare(insert).run("n2", "https://a.example.com", "k4")).toThrow();
    db.prepare(insert).run("n3", "https://b.example.com", "k5");
  });

  it("creates the registration attempts table", () => {
    const db = before();
    migrate(db);
    db.prepare("INSERT INTO relay_registration_attempts (client,day_start,count) VALUES ('c',0,1)").run();
    expect(() => db.prepare("INSERT INTO relay_registration_attempts (client,day_start,count) VALUES ('c',0,1)").run()).toThrow();
  });
});
