import { describe, expect, it } from "vitest";
import { openDatabase } from "../database.js";
import { migrate } from "../migrations.js";

const BEFORE_TOKEN_NAMES = 15;

// A database at the version before token names, holding two topics with two
// tokens each. The second topic's tokens go in newest first, so the backfill
// has to read created_at rather than insertion order.
function filledAtVersion15() {
  const db = openDatabase(":memory:");
  migrate(db, BEFORE_TOKEN_NAMES);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  for (const [id, name] of [["top_1", "prod"], ["top_2", "staging"]]) {
    db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES (?, 'acc_1', ?, 'https://alerts.example.com', ?, 0, 30, 1800, 600, 'none', 1)").run(id, name, `${id}_hash`);
  }
  for (const [id, topic, createdAt] of [["tok_1a", "top_1", 100], ["tok_1b", "top_1", 200], ["tok_2b", "top_2", 400], ["tok_2a", "top_2", 300]] as [string, string, number][]) {
    db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES (?, ?, ?, ?)").run(id, topic, `hash_${id}`, createdAt);
  }
  return db;
}

describe("the token name backfill", () => {
  it("numbers each topic's tokens from one, in creation order", () => {
    const db = filledAtVersion15();
    try {
      migrate(db);

      expect(db.prepare("SELECT id, name FROM topic_tokens ORDER BY topic_id, created_at").all()).toEqual([
        { id: "tok_1a", name: "Token 1" },
        { id: "tok_1b", name: "Token 2" },
        { id: "tok_2a", name: "Token 1" },
        { id: "tok_2b", name: "Token 2" },
      ]);
    } finally { db.close(); }
  });
});
