import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";

// Migration 17 adds devices.apns_environment: which Apple push host a device's
// token lives on. A Debug or Profile build of the iOS app registers a sandbox
// token and a Release, TestFlight or App Store build registers a production
// one, and each host refuses the other's with BadDeviceToken. Both kinds of
// build sit on the same phone, so one server-wide setting cannot reach both.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// A database at version 16, holding the device rows a server without the column
// would have written.
function atSixteen() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db, 16);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_ios','acc_1','hash_ios','ios','ios-token',1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_android','acc_1','hash_android','android','android-token',1)").run();
  return db;
}

function columnsOf(db: ReturnType<typeof openDatabase>, table: string) {
  return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((column) => column.name);
}

describe("migration 17", () => {
  it("is the seventeenth and last migration", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db);
    expect(migrationCount).toBe(17);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 17 });
  });

  it("adds apns_environment to devices and nowhere else", () => {
    const db = atSixteen();
    expect(columnsOf(db, "devices")).not.toContain("apns_environment");

    migrate(db);

    expect(columnsOf(db, "devices")).toContain("apns_environment");
    expect(columnsOf(db, "device_tokens")).not.toContain("apns_environment");
  });

  // Nothing is backfilled on purpose. A guessed value would send the first push
  // to the wrong host and look right in the table while it did it. Unknown is
  // honest, and costs at most one wasted request per device.
  it("leaves every device that registered before the column unknown", () => {
    const db = atSixteen();

    migrate(db);

    expect(db.prepare("SELECT id, apns_environment FROM devices ORDER BY id").all()).toEqual([
      { id: "dev_android", apns_environment: null },
      { id: "dev_ios", apns_environment: null },
    ]);
  });

  it("carries every device row across with its token and platform intact", () => {
    const db = atSixteen();

    migrate(db);

    expect(db.prepare("SELECT id, platform, push_token FROM devices ORDER BY id").all()).toEqual([
      { id: "dev_android", platform: "android", push_token: "android-token" },
      { id: "dev_ios", platform: "ios", push_token: "ios-token" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts both Apple hosts and holds whichever one is written", () => {
    const db = atSixteen();
    migrate(db);

    db.prepare("UPDATE devices SET apns_environment = 'sandbox' WHERE id = 'dev_ios'").run();
    db.prepare("UPDATE devices SET apns_environment = 'production' WHERE id = 'dev_android'").run();

    expect(db.prepare("SELECT id, apns_environment FROM devices ORDER BY id").all()).toEqual([
      { id: "dev_android", apns_environment: "production" },
      { id: "dev_ios", apns_environment: "sandbox" },
    ]);
  });

  it("runs on a database that holds no devices at all", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db, 16);

    migrate(db);

    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 0 });
    expect(columnsOf(db, "devices")).toContain("apns_environment");
  });
});
