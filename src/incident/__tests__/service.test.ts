import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { IncidentConflictError, IncidentService } from "../service.js";
import type { Clock, IdGenerator } from "../types.js";

class FakeClock implements Clock {
  constructor(public value: number) {}

  now(): number {
    return this.value;
  }
}

class FixedIds implements IdGenerator {
  private messageNumber = 0;
  private incidentNumber = 0;
  private timerNumber = 0;

  message(): string {
    this.messageNumber += 1;
    return `m_${this.messageNumber}`;
  }

  incident(): string {
    this.incidentNumber += 1;
    return `inc_${this.incidentNumber}`;
  }

  timer(): string {
    this.timerNumber += 1;
    return `tm_${this.timerNumber}`;
  }
}

function setup(now = 1_000) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'free', 1)").run();
  db.prepare(
    "INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 1, 10, 60, 30, 'none', 1)",
  ).run();
  const clock = new FakeClock(now);
  const service = new IncidentService(db, clock, new FixedIds());
  return { clock, db, service };
}

function criticalMessage(title = "Database", body = "db01 is down") {
  return { title, body, priority: 5 as const, tags: ["warning"], click: null, markdown: false };
}

function publication(title?: string, body?: string) {
  return {
    topicId: "top_1",
    topicHash: "hash_prod",
    topic: "prod",
    baseUrl: "https://alerts.example.com",
    repeatIntervalS: 10,
    maxRingS: 60,
    deskTimerS: 30,
    message: criticalMessage(title, body),
  };
}

describe("store migrations", () => {
  it("creates the incident foundation idempotently with its integrity rules", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    migrate(db);

    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "accounts",
        "devices",
        "subscriptions",
        "topics",
        "topic_tokens",
        "messages",
        "incidents",
        "timers",
        "schema_migrations",
      ]),
    );

    db.prepare(
      "INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)",
    ).run();
    db.prepare(
      "INSERT INTO topics (id, account_id, name, base_url, topic_hash, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash', 30, 1800, 600, 'none', 1)",
    ).run();
    db.prepare(
      "INSERT INTO incidents (id, topic_id, state, opened_at, last_message_at) VALUES ('inc_1', 'top_1', 'open', 1, 1)",
    ).run();

    const topic = db
      .prepare("SELECT critical FROM topics WHERE id = 'top_1'")
      .get() as { critical: number };
    expect(topic.critical).toBe(0);
    expect(() =>
      db
        .prepare(
          "INSERT INTO topics (id, account_id, name, base_url, topic_hash, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_2', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_2', 30, 1800, 600, 'none', 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO timers (id, incident_id, kind, fire_at) VALUES ('tm_1', 'inc_1', 'invalid', 1)")
        .run(),
    ).toThrow();
  });
});

describe("IncidentService", () => {
  it("opens critical publication and persists repeat and expire timers", () => {
    const { db, service } = setup();

    const result = service.publishCritical(publication());

    expect(result.incident).toMatchObject({
      id: "inc_1",
      topicId: "top_1",
      state: "open",
      openedAt: 1_000,
      ackedAt: null,
      closedAt: null,
      lastMessageAt: 1_000,
    });
    expect(result.message).toMatchObject({ id: "m_1", incidentId: "inc_1", createdAt: 1_000 });
    expect(
      db.prepare("SELECT max_ring_s FROM incidents WHERE id = 'inc_1'").get(),
    ).toEqual({ max_ring_s: 60 });
    expect(result.events).toEqual([
      {
        kind: "open",
        topicHash: "hash_prod",
        topic: "prod",
        incidentId: "inc_1",
        messageId: "m_1",
        priority: 5,
        maxRingS: 60,
        server: "https://alerts.example.com",
        title: "Database",
        body: "db01 is down",
        critical: true,
      },
    ]);
    expect(
      db.prepare("SELECT kind, fire_at FROM timers ORDER BY kind").all(),
    ).toEqual([
      { kind: "expire", fire_at: 1_060 },
      { kind: "repeat", fire_at: 1_010 },
    ]);
  });

  it("joins message into existing open incident without adding timers", () => {
    const { clock, db, service } = setup();
    service.publishCritical(publication());
    clock.value = 1_005;

    const result = service.publishCritical(publication("Cache", "cache01 is down"));

    expect(result.incident).toMatchObject({ id: "inc_1", state: "open", lastMessageAt: 1_005 });
    expect(result.message).toMatchObject({ id: "m_2", incidentId: "inc_1" });
    expect(result.events.map((event) => event.kind)).toEqual(["p5"]);
    expect(db.prepare("SELECT kind, fire_at FROM timers ORDER BY kind").all()).toEqual([
      { kind: "expire", fire_at: 1_060 },
      { kind: "repeat", fire_at: 1_010 },
    ]);
  });

  it("joins message into acked incident without reopening it", () => {
    const { clock, db, service } = setup();
    const opened = service.publishCritical(publication());
    clock.value = 1_010;
    service.acknowledge("acc_1", opened.incident.id);
    clock.value = 1_011;

    const result = service.publishCritical(publication("Cache", "cache01 is down"));

    expect(result.incident).toMatchObject({ id: "inc_1", state: "acked", ackedAt: 1_010 });
    expect(result.events).toEqual([
      {
        kind: "p5",
        topicHash: "hash_prod",
        topic: "prod",
        incidentId: "inc_1",
        messageId: "m_2",
        priority: 5,
        maxRingS: 60,
        server: "https://alerts.example.com",
        title: "Cache",
        body: "cache01 is down",
        critical: false,
      },
    ]);
    expect(db.prepare("SELECT kind, fire_at FROM timers").all()).toEqual([
      { kind: "desk", fire_at: 1_040 },
    ]);
  });

  it("acknowledges open incident and replaces ring timers with desk timer", () => {
    const { clock, db, service } = setup();
    const opened = service.publishCritical(publication());
    clock.value = 1_010;

    const acked = service.acknowledge("acc_1", opened.incident.id);

    expect(acked.incident).toMatchObject({ state: "acked", ackedAt: 1_010, closedAt: null });
    expect(acked.events).toEqual([expect.objectContaining({ kind: "ack", incidentId: opened.incident.id })]);
    expect(db.prepare("SELECT kind, fire_at FROM timers").all()).toEqual([
      { kind: "desk", fire_at: 1_040 },
    ]);
  });

  it("rejects acknowledgement unless incident is open", () => {
    const { service } = setup();
    const opened = service.publishCritical(publication());
    service.acknowledge("acc_1", opened.incident.id);

    expect(() => service.acknowledge("acc_1", opened.incident.id)).toThrow(IncidentConflictError);
  });

  it("closes acked incident and removes timers", () => {
    const { clock, db, service } = setup();
    const opened = service.publishCritical(publication());
    clock.value = 1_010;
    service.acknowledge("acc_1", opened.incident.id);
    clock.value = 1_011;

    const closed = service.close("acc_1", opened.incident.id);

    expect(closed.incident).toMatchObject({ state: "closed", closedAt: 1_011 });
    expect(closed.events).toEqual([expect.objectContaining({ kind: "close", incidentId: opened.incident.id })]);
    expect(db.prepare("SELECT * FROM timers").all()).toEqual([]);
  });

  it("rejects close unless incident is acked", () => {
    const { service } = setup();
    const opened = service.publishCritical(publication());

    expect(() => service.close("acc_1", opened.incident.id)).toThrow(IncidentConflictError);
  });

  it("returns null for an incident outside the account scope", () => {
    const { service } = setup();
    const opened = service.publishCritical(publication());

    expect(service.get("acc_2", opened.incident.id)).toBeNull();
    expect(service.list("acc_2", {})).toEqual([]);
  });
});
