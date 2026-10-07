import type Database from "better-sqlite3";
import { z } from "zod";
import type { Clock } from "../incident/types.js";
import type { BillingReads } from "./billing-reads.js";
import { resolveAccount } from "./revenuecat.js";

// api.md §4.3 with reading switched on. An event carries no answer. It names
// the customers to read again, and that is the only thing taken from it: its
// type, its expiry and the entitlements it lists decide nothing.

const customerIds = z.array(z.string()).nullable().optional();

const triggerSchema = z.object({
  event: z.object({
    id: z.string().min(1).optional(),
    event_timestamp_ms: z.number().optional(),
    // Optional here, unlike on the event path: a transfer may name its
    // customers only in the two arrays.
    app_user_id: z.string().min(1).nullable().optional(),
    type: z.string().min(1),
    transferred_from: customerIds,
    transferred_to: customerIds,
  }).passthrough(),
}).passthrough();

export interface ReadTriggerEvent {
  id: string | undefined;
  type: string;
  eventAtMs: number | undefined;
  // Every customer the event names, each once, in the order given.
  appUserIds: string[];
}

// The customers an event names: app_user_id, and every id in transferred_from
// and transferred_to. Anything that is not a non-empty string is skipped.
export function namedCustomers(event: { app_user_id?: unknown; transferred_from?: unknown; transferred_to?: unknown }): string[] {
  const named: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value !== "" && !named.includes(value)) named.push(value);
  };
  add(event.app_user_id);
  for (const list of [event.transferred_from, event.transferred_to]) {
    if (Array.isArray(list)) for (const value of list) add(value);
  }
  return named;
}

// Throws a ZodError for a body that is not an event or that names no customer.
export function parseReadTrigger(value: unknown): ReadTriggerEvent {
  const parsed = triggerSchema.parse(value).event;
  const appUserIds = namedCustomers(parsed);
  if (appUserIds.length === 0) throw new z.ZodError([]);
  return { id: parsed.id, type: parsed.type, eventAtMs: parsed.event_timestamp_ms, appUserIds };
}

function report(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

// Records the event and queues one read for each customer it names that
// resolves to an account. One transaction, no network: the caller answers 200
// as soon as this returns.
export function queueReadsForEvent(deps: { db: Database.Database; clock: Clock }, reads: BillingReads, event: ReadTriggerEvent): void {
  const receivedAt = deps.clock.now();
  const eventAt = event.eventAtMs === undefined ? receivedAt : Math.floor(event.eventAtMs / 1_000);
  const first = event.appUserIds[0] ?? "";
  // The same fallback the event path uses, so an event with no id of its own is
  // still seen once.
  const eventId = event.id ?? `rc:${first}:${event.type}:${eventAt}`;

  deps.db.transaction(() => {
    // Events are retried. A repeat stops here and triggers nothing.
    if (deps.db.prepare("SELECT 1 FROM billing_events WHERE event_id = ?").get(eventId) !== undefined) return;

    const resolved: { appUserId: string; accountId: string }[] = [];
    for (const appUserId of event.appUserIds) {
      const accountId = resolveAccount(deps, appUserId);
      if (accountId === null) {
        report({ event: "billing_event_unresolved", event_id: eventId, app_user_id: appUserId });
        continue;
      }
      resolved.push({ appUserId, accountId });
    }

    // applied means "this event caused a read", which is all an event can do
    // on this path.
    deps.db
      .prepare("INSERT INTO billing_events (event_id, app_user_id, account_id, type, event_at, applied, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(eventId, first, resolved.find((entry) => entry.appUserId === first)?.accountId ?? null, event.type, eventAt, resolved.length > 0 ? 1 : 0, receivedAt);

    for (const { appUserId, accountId } of resolved) {
      // Linking on any event that resolves is what lets the daily read find a
      // customer whose purchase maps to no tier.
      reads.link(appUserId, accountId);
      // Kept current so the event path's ordering rule still has its mark if
      // reading is ever switched back off.
      deps.db.prepare("UPDATE account_billing_ids SET last_event_at = MAX(COALESCE(last_event_at, 0), ?) WHERE app_user_id = ?").run(eventAt, appUserId);
      reads.enqueue(appUserId);
    }
  })();
}
