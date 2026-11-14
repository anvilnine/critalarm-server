import { describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate, migrationCount } from "../migrations.js";

// The three indexes on topic_id. The version is found, not named, so a
// migration that lands after it does not break this file.

type Db = ReturnType<typeof openDatabase>;

const NAMES = ["incidents_by_topic", "messages_by_topic", "topic_tokens_by_topic"];

function indexes(db: Db): string[] {
  const marks = NAMES.map(() => "?").join(", ");
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${marks}) ORDER BY name`).all(...NAMES) as { name: string }[]).map((row) => row.name);
}

function versionThatAddsIndexes(): number {
  for (let version = 1; version <= migrationCount; version += 1) {
    const db = openDatabase(":memory:");
    migrate(db, version);
    const found = indexes(db).length === NAMES.length;
    db.close();
    if (found) return version;
  }
  throw new Error("no migration adds the topic indexes");
}

function seed(db: Db): void {
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'free', 1)").run();
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('t', 'a', 'db', 'https://example.test', 'h', 0, 60, 600, 0, 'none', 1)").run();
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at, name) VALUES ('tok', 't', 'x', 1, 'Token 1')").run();
  db.prepare("INSERT INTO incidents (id, topic_id, state, opened_at, last_message_at, max_ring_s, updated_at) VALUES ('i', 't', 'open', 1, 1, 600, 1)").run();
  db.prepare("INSERT INTO messages (id, topic_id, incident_id, title, body, priority, created_at) VALUES ('m', 't', 'i', 'title', 'body', 5, 1)").run();
}

function plan(db: Db, sql: string, ...parameters: (string | number)[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[]).map((row) => row.detail).join("\n");
}

describe("topic indexes", () => {
  it("are added by one migration and change no row", () => {
    const version = versionThatAddsIndexes();
    const db = openDatabase(":memory:");
    migrate(db, version - 1);
    seed(db);
    expect(indexes(db)).toEqual([]);
    migrate(db);
    expect(indexes(db)).toEqual(NAMES);
    expect(db.prepare("SELECT id FROM topic_tokens").all()).toEqual([{ id: "tok" }]);
    expect(db.prepare("SELECT id FROM incidents").all()).toEqual([{ id: "i" }]);
    expect(db.prepare("SELECT id FROM messages").all()).toEqual([{ id: "m" }]);
    // Running it again changes nothing.
    migrate(db);
    expect(indexes(db)).toEqual(NAMES);
    db.close();
  });

  it("still migrates a database that already holds an index of the same name", () => {
    const version = versionThatAddsIndexes();
    const db = openDatabase(":memory:");
    migrate(db, version - 1);
    db.exec("CREATE INDEX messages_by_topic ON messages(topic_id, created_at)");
    migrate(db);
    expect(indexes(db)).toEqual(NAMES);
    db.close();
  });

  it("serve the poll, the incident list and the token list without reading a whole table", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const poll = plan(db, "SELECT rowid AS sequence, id FROM messages WHERE topic_id = ? AND created_at > ? ORDER BY created_at ASC, rowid ASC", "t", 0);
    expect(poll).toContain("USING INDEX messages_by_topic");
    expect(poll).not.toContain("SCAN");
    expect(poll).not.toContain("TEMP B-TREE");
    const list = plan(db, "SELECT i.id FROM incidents i JOIN topics t ON t.id = i.topic_id WHERE t.account_id = ? ORDER BY i.opened_at DESC LIMIT ?", "a", 20);
    expect(list).toContain("USING INDEX incidents_by_topic");
    expect(list).not.toContain("SCAN");
    const tokens = plan(db, "SELECT id AS token_id, name, created_at FROM topic_tokens WHERE topic_id=? ORDER BY created_at, rowid", "t");
    expect(tokens).toContain("USING INDEX topic_tokens_by_topic");
    expect(tokens).not.toContain("SCAN");
    db.close();
  });
});
