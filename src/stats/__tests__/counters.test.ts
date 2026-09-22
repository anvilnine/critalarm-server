import { describe, expect, it } from "vitest";
import type { DeliveryEvent } from "../../domain-events.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { Counters, LOCAL_KEY, dayKey } from "../counters.js";

function event(kind: DeliveryEvent["kind"]): DeliveryEvent {
  return {
    kind,
    topicHash: "a".repeat(64),
    topic: "prod",
    incidentId: "inc_1",
    messageId: "m_1",
    priority: 5,
    maxRingS: 60,
  ringUntil: 1_060,
    server: "https://alerts.example.com",
    title: "Database",
    body: "db01 is down",
    critical: true,
  };
}

function setup(start: number) {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = { now: () => now };
  let now = start;
  return { db, counters: new Counters(db, clock), set: (value: number) => { now = value; }, now: () => now };
}

const noon = Math.floor(Date.UTC(2026, 8, 13, 12, 0, 0) / 1000);

describe("counting rules", () => {
  it("counts an open as one incident and one alarm", () => {
    const { counters } = setup(noon);
    counters.countEvents(LOCAL_KEY, [event("open")]);
    expect(counters.read().totals).toMatchObject({ incidents_opened: 1, alarms_rung: 1, acks: 0 });
  });

  it("counts a reopen as an alarm and not as a new incident", () => {
    const { counters } = setup(noon);
    counters.countEvents(LOCAL_KEY, [event("open"), event("reopen"), event("reopen")]);
    expect(counters.read().totals).toMatchObject({ incidents_opened: 1, alarms_rung: 3 });
  });

  it("counts an ack and ignores repeat, p4, p5, close and expire", () => {
    const { counters } = setup(noon);
    counters.countEvents(LOCAL_KEY, [event("ack"), event("repeat"), event("p4"), event("p5"), event("close"), event("expire")]);
    expect(counters.read().totals).toEqual({ acks: 1, alarms_rung: 0, incidents_opened: 0, pushes_delivered: 0 });
  });

  it("never records a push that was not delivered", () => {
    const { counters } = setup(noon);
    counters.add(LOCAL_KEY, "pushes_delivered", 0);
    expect(counters.read().totals.pushes_delivered).toBe(0);
    expect(counters.read().days).toEqual([]);
  });
});

describe("day boundary", () => {
  it("splits counts either side of UTC midnight and still sums them in totals", () => {
    const beforeMidnight = Math.floor(Date.UTC(2026, 8, 13, 23, 59, 30) / 1000);
    const { counters, set } = setup(beforeMidnight);
    counters.countEvents(LOCAL_KEY, [event("open")]);
    set(beforeMidnight + 60);
    counters.countEvents(LOCAL_KEY, [event("open"), event("reopen")]);

    const stats = counters.read();
    expect(stats.totals).toMatchObject({ incidents_opened: 2, alarms_rung: 3 });
    expect(stats.days).toEqual([
      { day: "2026-09-14", pushes_delivered: 0, alarms_rung: 2, acks: 0, incidents_opened: 1 },
      { day: "2026-09-13", pushes_delivered: 0, alarms_rung: 1, acks: 0, incidents_opened: 1 },
    ]);
  });

  it("keeps only the last 30 days in the day rows, lifetime totals keep everything", () => {
    const { counters, set } = setup(noon);
    counters.countEvents(LOCAL_KEY, [event("open")]);
    set(noon + 45 * 86_400);
    counters.countEvents(LOCAL_KEY, [event("open")]);

    const stats = counters.read();
    expect(stats.totals.incidents_opened).toBe(2);
    expect(stats.days.map((row) => row.day)).toEqual([dayKey(noon + 45 * 86_400)]);
  });
});

describe("zeroing a key", () => {
  it("drops the key out of totals and day rows but keeps its rows", () => {
    const { db, counters } = setup(noon);
    counters.countEvents("key_good", [event("open")]);
    counters.countEvents("key_abusive", [event("open"), event("open"), event("open")]);
    counters.add("key_abusive", "pushes_delivered", 9);

    expect(counters.read().totals).toMatchObject({ incidents_opened: 4, pushes_delivered: 9 });
    expect(counters.zeroKey("key_abusive")).toBe(3);

    const stats = counters.read({ byKey: true });
    expect(stats.totals).toMatchObject({ incidents_opened: 1, alarms_rung: 1, pushes_delivered: 0 });
    expect(stats.days).toEqual([{ day: "2026-09-13", pushes_delivered: 0, alarms_rung: 1, acks: 0, incidents_opened: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS rows FROM counters WHERE relay_key = 'key_abusive'").get()).toEqual({ rows: 3 });
    expect(stats.keys).toEqual([
      { relay_key: "key_abusive", zeroed: true, totals: { pushes_delivered: 9, alarms_rung: 3, acks: 0, incidents_opened: 3 }, days: [{ day: "2026-09-13", pushes_delivered: 9, alarms_rung: 3, acks: 0, incidents_opened: 3 }] },
      { relay_key: "key_good", zeroed: false, totals: { pushes_delivered: 0, alarms_rung: 1, acks: 0, incidents_opened: 1 }, days: [{ day: "2026-09-13", pushes_delivered: 0, alarms_rung: 1, acks: 0, incidents_opened: 1 }] },
    ]);
  });

  it("leaves a zeroed relay server out of servers_total", () => {
    const { db, counters } = setup(noon);
    db.prepare("INSERT INTO relay_servers (id, base_url, version, relay_key_hash, created_at) VALUES ('rly_1','https://a.example.com','0.1.0','key_good',1)").run();
    db.prepare("INSERT INTO relay_servers (id, base_url, version, relay_key_hash, created_at) VALUES ('rly_2','https://b.example.com','0.1.0','key_abusive',1)").run();
    expect(counters.read().servers_total).toBe(2);
    counters.zeroKey("key_abusive");
    expect(counters.read().servers_total).toBe(1);
  });
});

describe("devices_active_7d", () => {
  it("counts only devices seen in the last seven days", () => {
    const { db, counters } = setup(noon);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1','hosted',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_fresh','acc_1','h1','ios','t1',?)").run(noon - 6 * 86_400);
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_stale','acc_1','h2','ios','t2',?)").run(noon - 8 * 86_400);
    expect(counters.read().devices_active_7d).toBe(1);
  });
});
