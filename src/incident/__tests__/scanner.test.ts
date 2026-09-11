import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { startTimerScanner } from "../scanner.js";
import { IncidentService } from "../service.js";
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
  message(): string { this.messageNumber += 1; return `m_${this.messageNumber}`; }
  incident(): string { this.incidentNumber += 1; return `inc_${this.incidentNumber}`; }
  timer(): string { this.timerNumber += 1; return `tm_${this.timerNumber}`; }
}

function setup(now = 1_000) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 1, 10, 60, 30, 'none', 1)").run();
  const clock = new FakeClock(now);
  return { clock, db, ids: new FixedIds() };
}

function publication() {
  return {
    topicId: "top_1", topicHash: "hash_prod", topic: "prod", baseUrl: "https://alerts.example.com",
    repeatIntervalS: 10, maxRingS: 60, deskTimerS: 30,
    message: { title: "Database", body: "db01 is down", priority: 5 as const, tags: ["warning"], click: null, markdown: false },
  };
}

describe("due incident timers", () => {
  it("reopens acked incident when desk timer fires", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    const opened = service.publishCritical(publication());
    clock.value = 1_010;
    service.acknowledge("acc_1", opened.incident.id);
    clock.value = 1_040;

    expect(service.scanDue()).toEqual([expect.objectContaining({ kind: "reopen", incidentId: "inc_1", messageId: "m_1" })]);
    expect(db.prepare("SELECT state, opened_at, acked_at FROM incidents WHERE id = 'inc_1'").get()).toEqual({ state: "open", opened_at: 1_040, acked_at: null });
  });

  it("restarts max-ring deadline from reopen time", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    const opened = service.publishCritical(publication());
    clock.value = 1_010;
    service.acknowledge("acc_1", opened.incident.id);
    clock.value = 1_040;

    service.scanDue();

    expect(db.prepare("SELECT kind, fire_at FROM timers ORDER BY kind").all()).toEqual([
      { kind: "expire", fire_at: 1_100 },
      { kind: "repeat", fire_at: 1_050 },
    ]);
  });

  it("emits repeat and advances repeat row while open", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    service.publishCritical(publication());
    clock.value = 1_010;

    expect(service.scanDue()).toEqual([expect.objectContaining({ kind: "repeat", incidentId: "inc_1", messageId: "m_1" })]);
    expect(db.prepare("SELECT fire_at FROM timers WHERE kind = 'repeat'").get()).toEqual({ fire_at: 1_020 });
  });

  it("uses current critical toggle for repeat delivery", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    service.publishCritical(publication());
    db.prepare("UPDATE topics SET critical = 0 WHERE id = 'top_1'").run();
    clock.value = 1_010;

    expect(service.scanDue()).toEqual([
      expect.objectContaining({ kind: "repeat", incidentId: "inc_1", critical: false }),
    ]);
  });

  it("uses the critical toggle but original duration when reopening", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    const opened = service.publishCritical(publication());
    clock.value = 1_010;
    service.acknowledge("acc_1", opened.incident.id);
    db.prepare("UPDATE topics SET critical = 0, max_ring_s = 120 WHERE id = 'top_1'").run();
    clock.value = 1_040;

    expect(service.scanDue()).toEqual([
      {
        kind: "reopen",
        topicHash: "hash_prod",
        topic: "prod",
        incidentId: "inc_1",
        messageId: "m_1",
        priority: 5,
        maxRingS: 60,
        server: "https://alerts.example.com",
        title: "Database",
        body: "db01 is down",
        critical: false,
      },
    ]);
    expect(db.prepare("SELECT kind, fire_at FROM timers ORDER BY kind").all()).toEqual([
      { kind: "expire", fire_at: 1_100 },
      { kind: "repeat", fire_at: 1_050 },
    ]);
  });

  it("expires open incident at max-ring deadline", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    service.publishCritical(publication());
    clock.value = 1_060;

    expect(service.scanDue()).toEqual([]);
    expect(db.prepare("SELECT state, closed_at FROM incidents WHERE id = 'inc_1'").get()).toEqual({ state: "expired", closed_at: 1_060 });
    expect(db.prepare("SELECT * FROM timers").all()).toEqual([]);
  });

  it("processes expiration before repeat at same timestamp", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    service.publishCritical({ ...publication(), repeatIntervalS: 60 });
    clock.value = 1_060;

    expect(service.scanDue()).toEqual([]);
    expect(db.prepare("SELECT state FROM incidents WHERE id = 'inc_1'").get()).toEqual({ state: "expired" });
  });

  it("ignores stale timer whose incident state changed", () => {
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    const opened = service.publishCritical(publication());
    clock.value = 1_001;
    service.acknowledge("acc_1", opened.incident.id);
    db.prepare("INSERT INTO timers (id, incident_id, kind, fire_at) VALUES ('tm_stale', 'inc_1', 'repeat', 1001)").run();

    expect(service.scanDue()).toEqual([]);
    expect(db.prepare("SELECT * FROM timers WHERE id = 'tm_stale'").all()).toEqual([]);
  });

  it("keeps timers durable across service recreation", () => {
    const { clock, db, ids } = setup();
    const first = new IncidentService(db, clock, ids);
    first.publishCritical(publication());
    const second = new IncidentService(db, clock, ids);
    clock.value = 1_010;

    expect(second.scanDue()).toEqual([expect.objectContaining({ kind: "repeat", incidentId: "inc_1" })]);
  });
});

describe("timer scanner lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports rejected dispatch and continues later scans", async () => {
    vi.useFakeTimers();
    const { clock, db, ids } = setup();
    const service = new IncidentService(db, clock, ids);
    service.publishCritical(publication());
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deliveries: string[] = [];
    let attempts = 0;
    const stop = startTimerScanner(service, async (events) => {
      attempts += 1;
      deliveries.push(events[0]?.kind ?? "none");
      if (attempts === 1) {
        throw new Error("relay unavailable");
      }
    }, 10);

    clock.value = 1_010;
    await vi.advanceTimersByTimeAsync(10);
    clock.value = 1_020;
    await vi.advanceTimersByTimeAsync(10);
    stop();

    expect(deliveries).toEqual(["repeat", "repeat"]);
    expect(report).toHaveBeenCalledWith("incident timer dispatch failed", expect.any(Error));
  });
});
