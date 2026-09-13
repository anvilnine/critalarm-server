import type Database from "better-sqlite3";
import type { DeliveryEvent } from "../domain-events.js";
import type { Clock } from "../incident/types.js";

// api.md §4.4. Counters are incremented when something happens, never computed
// on read. Every row is keyed by (day, relay_key, metric). Work that arrives
// through /relay/v1/push is keyed by the pushing server's relay key hash;
// work the relay does for its own hosted accounts is keyed LOCAL_KEY.
export const LOCAL_KEY = "local";

export const METRICS = ["pushes_delivered", "alarms_rung", "acks", "incidents_opened"] as const;
export type Metric = (typeof METRICS)[number];
export type Totals = Record<Metric, number>;
export type DayRow = Totals & { day: string };
export interface KeyRow {
  relay_key: string;
  zeroed: boolean;
  totals: Totals;
  days: DayRow[];
}
export interface Stats {
  totals: Totals;
  servers_total: number;
  devices_active_7d: number;
  days: DayRow[];
  keys?: KeyRow[];
}

const DAY_S = 86_400;
const WINDOW_DAYS = 30;

export function dayKey(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function emptyTotals(): Totals {
  return { pushes_delivered: 0, alarms_rung: 0, acks: 0, incidents_opened: 0 };
}

type CountRow = { day: string; relay_key: string; metric: string; count: number };

function isMetric(value: string): value is Metric {
  return (METRICS as readonly string[]).includes(value);
}

export class Counters {
  private readonly insert;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {
    this.insert = db.prepare(
      `INSERT INTO counters (day, relay_key, metric, count) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, relay_key, metric) DO UPDATE SET count = count + excluded.count`,
    );
  }

  add(relayKey: string, metric: Metric, amount = 1): void {
    if (amount <= 0) return;
    this.insert.run(dayKey(this.clock.now()), relayKey, metric, amount);
  }

  // An open is both a new incident and a ring. A reopen rings again on an
  // incident that already existed, so it counts as an alarm and not as an open.
  // repeat, p4, p5, close and expire ring nobody new and are not counted here.
  countEvents(relayKey: string, events: readonly DeliveryEvent[]): void {
    for (const event of events) {
      if (event.kind === "open") {
        this.add(relayKey, "incidents_opened");
        this.add(relayKey, "alarms_rung");
      } else if (event.kind === "reopen") {
        this.add(relayKey, "alarms_rung");
      } else if (event.kind === "ack") {
        this.add(relayKey, "acks");
      }
    }
  }

  // Keeps the rows, drops the key out of every total. Returns how many counter
  // rows the key owns so the admin command can say what was excluded.
  zeroKey(relayKey: string): number {
    this.db
      .prepare("INSERT INTO counters_zeroed (relay_key, zeroed_at) VALUES (?, ?) ON CONFLICT (relay_key) DO NOTHING")
      .run(relayKey, this.clock.now());
    const row = this.db.prepare("SELECT COUNT(*) AS rows FROM counters WHERE relay_key = ?").get(relayKey) as {
      rows: number;
    };
    return row.rows;
  }

  read(options: { byKey?: boolean } = {}): Stats {
    const now = this.clock.now();
    const since = dayKey(now - (WINDOW_DAYS - 1) * DAY_S);
    const zeroed = new Set(
      (this.db.prepare("SELECT relay_key FROM counters_zeroed").all() as { relay_key: string }[]).map(
        (row) => row.relay_key,
      ),
    );
    const rows = this.db.prepare("SELECT day, relay_key, metric, count FROM counters").all() as CountRow[];

    const totals = emptyTotals();
    const byDay = new Map<string, DayRow>();
    const byKey = new Map<string, KeyRow>();
    for (const row of rows) {
      if (!isMetric(row.metric)) continue;
      const counted = !zeroed.has(row.relay_key);
      if (counted) {
        totals[row.metric] += row.count;
        if (row.day >= since) dayRow(byDay, row.day)[row.metric] += row.count;
      }
      if (options.byKey === true) {
        const key = keyRow(byKey, row.relay_key, zeroed.has(row.relay_key));
        key.totals[row.metric] += row.count;
        if (row.day >= since) dayRowInList(key.days, row.day)[row.metric] += row.count;
      }
    }

    const servers = this.db
      .prepare("SELECT COUNT(*) AS total FROM relay_servers WHERE relay_key_hash NOT IN (SELECT relay_key FROM counters_zeroed)")
      .get() as { total: number };
    const devices = this.db.prepare("SELECT COUNT(*) AS total FROM devices WHERE last_seen >= ?").get(now - 7 * DAY_S) as {
      total: number;
    };

    const stats: Stats = {
      totals,
      servers_total: servers.total,
      devices_active_7d: devices.total,
      days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
    };
    if (options.byKey === true) {
      stats.keys = [...byKey.values()]
        .map((key) => ({ ...key, days: [...key.days].sort((a, b) => b.day.localeCompare(a.day)) }))
        .sort((a, b) => b.totals.alarms_rung - a.totals.alarms_rung || a.relay_key.localeCompare(b.relay_key));
    }
    return stats;
  }
}

function dayRow(days: Map<string, DayRow>, day: string): DayRow {
  const existing = days.get(day);
  if (existing !== undefined) return existing;
  const created: DayRow = { day, ...emptyTotals() };
  days.set(day, created);
  return created;
}

function dayRowInList(days: DayRow[], day: string): DayRow {
  const existing = days.find((row) => row.day === day);
  if (existing !== undefined) return existing;
  const created: DayRow = { day, ...emptyTotals() };
  days.push(created);
  return created;
}

function keyRow(keys: Map<string, KeyRow>, relayKey: string, zeroed: boolean): KeyRow {
  const existing = keys.get(relayKey);
  if (existing !== undefined) return existing;
  const created: KeyRow = { relay_key: relayKey, zeroed, totals: emptyTotals(), days: [] };
  keys.set(relayKey, created);
  return created;
}
