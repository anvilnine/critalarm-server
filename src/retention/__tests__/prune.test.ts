import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { pruneHistory } from "../prune.js";
import type { Clock } from "../../incident/types.js";

const day = 86_400;
const now = 100 * day;
const clock: Clock = { now: () => now };

// One account per tier, one topic each. Rows are placed by age in days, so a
// test reads as "a closed incident eight days old".
function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  for (const [id, tier] of [["acc_free", "free"], ["acc_hosted", "hosted"]]) {
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES (?,?,1)").run(id, tier);
    db.prepare(
      "INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES (?,?,'prod','https://a',?,1,30,60,30,'none',1)",
    ).run(`top_${id}`, id, `hash_${id}`);
  }
  return db;
}

function addIncident(db: ReturnType<typeof setup>, id: string, account: string, state: string, ageDays: number) {
  db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,last_message_at,max_ring_s) VALUES (?,?,?,?,?,60)")
    .run(id, `top_${account}`, state, now - ageDays * day, now - ageDays * day);
}

function addMessage(db: ReturnType<typeof setup>, id: string, account: string, incidentId: string | null, ageDays: number) {
  db.prepare("INSERT INTO messages (id,topic_id,incident_id,title,body,priority,tags,markdown,created_at) VALUES (?,?,?,'t','b',5,'[]',0,?)")
    .run(id, `top_${account}`, incidentId, now - ageDays * day);
}

function ids(db: ReturnType<typeof setup>, table: "incidents" | "messages"): string[] {
  return (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((row) => row.id);
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

describe("history prune", () => {
  it("keeps a free account seven days and a paid one ninety", () => {
    const db = setup();
    try {
      addIncident(db, "free_day6", "acc_free", "closed", 6);
      addIncident(db, "free_day8", "acc_free", "expired", 8);
      addIncident(db, "paid_day89", "acc_hosted", "closed", 89);
      addIncident(db, "paid_day91", "acc_hosted", "closed", 91);

      expect(pruneHistory(db, clock, "hosted")).toEqual({ accounts: 2, incidents: 2, messages: 0 });
      expect(ids(db, "incidents")).toEqual(["free_day6", "paid_day89"]);
    } finally { db.close(); }
  });

  it("never deletes an open or acked incident, or its messages", () => {
    const db = setup();
    try {
      addIncident(db, "still_open", "acc_free", "open", 40);
      addMessage(db, "m_open", "acc_free", "still_open", 40);
      addIncident(db, "still_acked", "acc_hosted", "acked", 400);
      addMessage(db, "m_acked", "acc_hosted", "still_acked", 400);

      expect(pruneHistory(db, clock, "relay")).toEqual({ accounts: 2, incidents: 0, messages: 0 });
      expect(ids(db, "incidents")).toEqual(["still_acked", "still_open"]);
      expect(ids(db, "messages")).toEqual(["m_acked", "m_open"]);
    } finally { db.close(); }
  });

  it("puts a message with no incident on the same window", () => {
    const db = setup();
    try {
      addMessage(db, "m_day6", "acc_free", null, 6);
      addMessage(db, "m_day8", "acc_free", null, 8);
      addMessage(db, "m_day89", "acc_hosted", null, 89);
      addMessage(db, "m_day91", "acc_hosted", null, 91);

      expect(pruneHistory(db, clock, "hosted")).toEqual({ accounts: 2, incidents: 0, messages: 2 });
      expect(ids(db, "messages")).toEqual(["m_day6", "m_day89"]);
    } finally { db.close(); }
  });

  it("takes the messages of a closed incident with it", () => {
    const db = setup();
    try {
      addIncident(db, "free_day8", "acc_free", "closed", 8);
      addMessage(db, "m_day8", "acc_free", "free_day8", 8);

      expect(pruneHistory(db, clock, "hosted")).toEqual({ accounts: 2, incidents: 1, messages: 1 });
      expect(ids(db, "messages")).toEqual([]);
    } finally { db.close(); }
  });

  it("deletes nothing on a self-hosted server, whatever the age", () => {
    const db = setup();
    try {
      addIncident(db, "free_day8", "acc_free", "closed", 8);
      addMessage(db, "m_old", "acc_free", null, 900);

      expect(pruneHistory(db, clock, "selfhosted")).toEqual({ accounts: 0, incidents: 0, messages: 0 });
      expect(ids(db, "incidents")).toEqual(["free_day8"]);
      expect(ids(db, "messages")).toEqual(["m_old"]);
      expect(log).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("logs one line with what it deleted", () => {
    const db = setup();
    try {
      addIncident(db, "free_day8", "acc_free", "closed", 8);

      pruneHistory(db, clock, "hosted");

      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "history_pruned", accounts: 2, incidents: 1, messages: 0 }));
    } finally { db.close(); }
  });
});
