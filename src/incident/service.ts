import type Database from "better-sqlite3";
import type {
  Clock,
  CriticalPublication,
  DeliveryEvent,
  IdGenerator,
  IncidentFilter,
  IncidentRecord,
  IncidentState,
  IncidentWithMessages,
  MessageRecord,
} from "./types.js";

type IncidentRow = {
  id: string;
  topic_id: string;
  state: IncidentState;
  opened_at: number;
  acked_at: number | null;
  closed_at: number | null;
  last_message_at: number;
};

type MessageRow = {
  id: string;
  topic_id: string;
  incident_id: string | null;
  title: string;
  body: string;
  priority: number;
  tags: string;
  click: string | null;
  markdown: number;
  created_at: number;
};

type ScopedIncidentRow = IncidentRow & {
  topic: string;
  topic_hash: string;
  base_url: string;
  critical: number;
  repeat_interval_s: number;
  max_ring_s: number;
  desk_timer_s: number;
};

export class IncidentConflictError extends Error {
  constructor() {
    super("incident state conflict");
    this.name = "IncidentConflictError";
  }
}

export class IncidentNotFoundError extends Error {
  constructor() {
    super("incident not found");
    this.name = "IncidentNotFoundError";
  }
}

function incidentRecord(row: IncidentRow): IncidentRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    state: row.state,
    openedAt: row.opened_at,
    ackedAt: row.acked_at,
    closedAt: row.closed_at,
    lastMessageAt: row.last_message_at,
  };
}

function messageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    incidentId: row.incident_id,
    title: row.title,
    body: row.body,
    priority: row.priority,
    tags: JSON.parse(row.tags) as string[],
    click: row.click,
    markdown: row.markdown === 1,
    createdAt: row.created_at,
  };
}

export class IncidentService {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  publishCritical(input: CriticalPublication): {
    message: MessageRecord;
    incident: IncidentRecord;
    events: DeliveryEvent[];
  } {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const existing = this.db
        .prepare(
          "SELECT id, topic_id, state, opened_at, acked_at, closed_at, last_message_at FROM incidents WHERE topic_id = ? AND state IN ('open', 'acked')",
        )
        .get(input.topicId) as IncidentRow | undefined;
      const incident = existing ?? {
        id: this.ids.incident(),
        topic_id: input.topicId,
        state: "open" as const,
        opened_at: now,
        acked_at: null,
        closed_at: null,
        last_message_at: now,
      };

      if (existing === undefined) {
        this.db
          .prepare(
            "INSERT INTO incidents (id, topic_id, state, opened_at, acked_at, closed_at, last_message_at) VALUES (?, ?, 'open', ?, NULL, NULL, ?)",
          )
          .run(incident.id, input.topicId, now, now);
        this.insertTimer(incident.id, "repeat", now + input.repeatIntervalS);
        this.insertTimer(incident.id, "expire", now + input.maxRingS);
      } else {
        this.db
          .prepare("UPDATE incidents SET last_message_at = ? WHERE id = ?")
          .run(now, incident.id);
        incident.last_message_at = now;
      }

      const messageRow: MessageRow = {
        id: this.ids.message(),
        topic_id: input.topicId,
        incident_id: incident.id,
        title: input.message.title,
        body: input.message.body,
        priority: input.message.priority,
        tags: JSON.stringify(input.message.tags),
        click: input.message.click,
        markdown: input.message.markdown ? 1 : 0,
        created_at: now,
      };
      this.db
        .prepare(
          "INSERT INTO messages (id, topic_id, incident_id, title, body, priority, tags, click, markdown, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          messageRow.id,
          messageRow.topic_id,
          messageRow.incident_id,
          messageRow.title,
          messageRow.body,
          messageRow.priority,
          messageRow.tags,
          messageRow.click,
          messageRow.markdown,
          messageRow.created_at,
        );

      return {
        message: messageRecord(messageRow),
        incident: incidentRecord(incident),
        events: [
          this.deliveryEvent(
            existing === undefined ? "open" : "p5",
            input.topicHash,
            input.topic,
            input.baseUrl,
            incident.id,
            messageRow,
            input.maxRingS,
          ),
        ],
      };
    })();
  }

  acknowledge(accountId: string, incidentId: string): IncidentRecord {
    return this.db.transaction(() => {
      const incident = this.scopedIncident(accountId, incidentId);
      if (incident.state !== "open") {
        throw new IncidentConflictError();
      }
      const now = this.clock.now();
      this.db.prepare("UPDATE incidents SET state = 'acked', acked_at = ? WHERE id = ?").run(now, incidentId);
      this.db.prepare("DELETE FROM timers WHERE incident_id = ?").run(incidentId);
      this.insertTimer(incidentId, "desk", now + incident.desk_timer_s);
      return { ...incidentRecord(incident), state: "acked" as const, ackedAt: now };
    })();
  }

  close(accountId: string, incidentId: string): IncidentRecord {
    return this.db.transaction(() => {
      const incident = this.scopedIncident(accountId, incidentId);
      if (incident.state !== "acked") {
        throw new IncidentConflictError();
      }
      const now = this.clock.now();
      this.db.prepare("UPDATE incidents SET state = 'closed', closed_at = ? WHERE id = ?").run(now, incidentId);
      this.db.prepare("DELETE FROM timers WHERE incident_id = ?").run(incidentId);
      return { ...incidentRecord(incident), state: "closed" as const, closedAt: now };
    })();
  }

  get(accountId: string, incidentId: string): IncidentWithMessages | null {
    const incident = this.scopedIncidentOrNull(accountId, incidentId);
    return incident === null ? null : this.withMessages(incident);
  }

  list(accountId: string, filter: IncidentFilter): IncidentWithMessages[] {
    const clauses = ["t.account_id = ?"];
    const parameters: (string | number)[] = [accountId];
    if (filter.state !== undefined) {
      clauses.push("i.state = ?");
      parameters.push(filter.state);
    }
    if (filter.topic !== undefined) {
      clauses.push("t.name = ?");
      parameters.push(filter.topic);
    }
    const limit = filter.limit ?? 20;
    parameters.push(limit);
    const rows = this.db
      .prepare(
        `SELECT i.id, i.topic_id, i.state, i.opened_at, i.acked_at, i.closed_at, i.last_message_at,
          t.name AS topic, t.topic_hash, t.base_url, t.critical, t.repeat_interval_s, t.max_ring_s, t.desk_timer_s
         FROM incidents i JOIN topics t ON t.id = i.topic_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY i.opened_at DESC LIMIT ?`,
      )
      .all(...parameters) as ScopedIncidentRow[];
    return rows.map((row) => this.withMessages(row));
  }

  scanDue(): DeliveryEvent[] {
    const due = this.db
      .prepare(
        `SELECT tm.id AS timer_id, tm.kind, tm.fire_at, i.id, i.topic_id, i.state, i.opened_at, i.acked_at, i.closed_at, i.last_message_at,
          t.name AS topic, t.topic_hash, t.base_url, t.critical, t.repeat_interval_s, t.max_ring_s, t.desk_timer_s
         FROM timers tm JOIN incidents i ON i.id = tm.incident_id JOIN topics t ON t.id = i.topic_id
         WHERE tm.fire_at <= ?
         ORDER BY CASE tm.kind WHEN 'expire' THEN 0 WHEN 'desk' THEN 1 ELSE 2 END, tm.fire_at, tm.id`,
      )
      .all(this.clock.now()) as (ScopedIncidentRow & { timer_id: string; kind: "repeat" | "expire" | "desk"; fire_at: number })[];

    const events: DeliveryEvent[] = [];
    for (const timer of due) {
      const event = this.db.transaction(() => this.processTimer(timer))();
      if (event !== null) {
        events.push(event);
      }
    }
    return events;
  }

  private processTimer(timer: ScopedIncidentRow & { timer_id: string; kind: "repeat" | "expire" | "desk" }): DeliveryEvent | null {
    const current = this.db
      .prepare(
        "SELECT id, topic_id, state, opened_at, acked_at, closed_at, last_message_at FROM incidents WHERE id = ?",
      )
      .get(timer.id) as IncidentRow | undefined;
    if (current === undefined) {
      return null;
    }
    const now = this.clock.now();
    if (timer.kind === "expire") {
      if (current.state !== "open") {
        this.db.prepare("DELETE FROM timers WHERE id = ?").run(timer.timer_id);
        return null;
      }
      this.db.prepare("UPDATE incidents SET state = 'expired', closed_at = ? WHERE id = ?").run(now, timer.id);
      this.db.prepare("DELETE FROM timers WHERE incident_id = ?").run(timer.id);
      return null;
    }
    if (timer.kind === "desk") {
      if (current.state !== "acked") {
        this.db.prepare("DELETE FROM timers WHERE id = ?").run(timer.timer_id);
        return null;
      }
      this.db.prepare("UPDATE incidents SET state = 'open', opened_at = ?, acked_at = NULL WHERE id = ?").run(now, timer.id);
      this.db.prepare("DELETE FROM timers WHERE incident_id = ?").run(timer.id);
      this.insertTimer(timer.id, "repeat", now + timer.repeat_interval_s);
      this.insertTimer(timer.id, "expire", now + timer.max_ring_s);
      return this.timerEvent("reopen", timer);
    }
    if (current.state !== "open") {
      this.db.prepare("DELETE FROM timers WHERE id = ?").run(timer.timer_id);
      return null;
    }
    this.db.prepare("UPDATE timers SET fire_at = ? WHERE id = ?").run(now + timer.repeat_interval_s, timer.timer_id);
    return this.timerEvent("repeat", timer);
  }

  private timerEvent(kind: "repeat" | "reopen", incident: ScopedIncidentRow): DeliveryEvent {
    const message = this.db
      .prepare(
        "SELECT id, topic_id, incident_id, title, body, priority, tags, click, markdown, created_at FROM messages WHERE incident_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(incident.id) as MessageRow;
    return this.deliveryEvent(kind, incident.topic_hash, incident.topic, incident.base_url, incident.id, message, incident.max_ring_s);
  }

  private deliveryEvent(
    kind: DeliveryEvent["kind"],
    topicHash: string,
    topic: string,
    server: string,
    incidentId: string,
    message: MessageRow,
    maxRingS: number,
  ): DeliveryEvent {
    return {
      kind,
      topicHash,
      topic,
      incidentId,
      messageId: message.id,
      priority: 5,
      maxRingS,
      server,
      title: message.title,
      body: message.body,
      critical: true,
    };
  }

  private insertTimer(incidentId: string, kind: "repeat" | "expire" | "desk", fireAt: number): void {
    this.db.prepare("INSERT INTO timers (id, incident_id, kind, fire_at) VALUES (?, ?, ?, ?)").run(this.ids.timer(), incidentId, kind, fireAt);
  }

  private scopedIncident(accountId: string, incidentId: string): ScopedIncidentRow {
    const incident = this.scopedIncidentOrNull(accountId, incidentId);
    if (incident === null) {
      throw new IncidentNotFoundError();
    }
    return incident;
  }

  private scopedIncidentOrNull(accountId: string, incidentId: string): ScopedIncidentRow | null {
    const row = this.db
      .prepare(
        `SELECT i.id, i.topic_id, i.state, i.opened_at, i.acked_at, i.closed_at, i.last_message_at,
          t.name AS topic, t.topic_hash, t.base_url, t.critical, t.repeat_interval_s, t.max_ring_s, t.desk_timer_s
         FROM incidents i JOIN topics t ON t.id = i.topic_id
         WHERE i.id = ? AND t.account_id = ?`,
      )
      .get(incidentId, accountId) as ScopedIncidentRow | undefined;
    return row ?? null;
  }

  private withMessages(incident: ScopedIncidentRow): IncidentWithMessages {
    const messages = this.db
      .prepare(
        "SELECT id, topic_id, incident_id, title, body, priority, tags, click, markdown, created_at FROM messages WHERE incident_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(incident.id) as MessageRow[];
    return { ...incidentRecord(incident), topic: incident.topic, messages: messages.map(messageRecord) };
  }
}
