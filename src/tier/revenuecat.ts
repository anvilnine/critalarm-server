import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Tier, TierDependencies } from "./types.js";

const eventSchema = z.object({
  event: z.object({
    // RevenueCat's own event id and timestamp (api.md §4.3: the body is
    // RevenueCat's webhook event). They are the dedup key and the ordering key.
    id: z.string().min(1).optional(),
    event_timestamp_ms: z.number().optional(),
    app_user_id: z.string().min(1),
    type: z.string().min(1),
    entitlement_id: z.string().min(1).nullable().optional(),
    entitlement_ids: z.array(z.string().min(1)).nullable().optional(),
    expiration_at_ms: z.number().nullable().optional(),
  }).passthrough(),
}).passthrough();

export type RevenueCatEvent = z.infer<typeof eventSchema>;

const RANK: Record<Tier, number> = { free: 0, relay: 1, hosted: 2 };

export function parseRevenueCatEvent(value: unknown): RevenueCatEvent {
  return eventSchema.parse(value);
}

// What this one billing id pays for after the event. A real expiry means it pays
// for nothing; expiration_at_ms is read rather than the type trusted alone, so a
// billing-issue event with a future expiry does not turn anyone's alarms off
// because a card failed on a Tuesday. null means the event names no entitlement
// we know, and the billing id keeps what it had.
function entitledTier(deps: TierDependencies, event: RevenueCatEvent["event"]): Tier | null {
  if (event.type === "EXPIRATION") return "free";
  if (event.expiration_at_ms !== undefined && event.expiration_at_ms !== null && event.expiration_at_ms <= deps.clock.now() * 1_000) return "free";
  const configured = deps.revenueCat?.entitlements ?? {};
  const entitlements = [event.entitlement_id, ...event.entitlement_ids ?? []];
  for (const entitlement of entitlements) {
    if (entitlement !== undefined && entitlement !== null && configured[entitlement] !== undefined) return configured[entitlement];
  }
  return null;
}

// A merged account keeps its row and points at the winner, so an id that was
// linked before the merge still lands on the account that owns the devices now.
// The chain is kept one hop by the merge itself; the bound is here so a cycle
// written by hand cannot spin forever.
function followMerge(deps: TierDependencies, accountId: string): string | null {
  let current = accountId;
  for (let hop = 0; hop < 8; hop += 1) {
    const row = deps.db.prepare("SELECT id, merged_into FROM accounts WHERE id = ?").get(current) as { id: string; merged_into: string | null } | undefined;
    if (row === undefined) return null;
    if (row.merged_into === null) return row.id;
    current = row.merged_into;
  }
  return null;
}

// account_billing_ids first. Falling back to accounts.id keeps api.md §4.3
// working ("app_user_id is the account_id", set on the SDK right after
// registration): the first event for an id is what links it, so a subscriber
// who bought before this table existed still resolves.
function resolveAccount(deps: TierDependencies, appUserId: string): string | null {
  const linked = deps.db.prepare("SELECT account_id FROM account_billing_ids WHERE app_user_id = ?").get(appUserId) as { account_id: string } | undefined;
  if (linked !== undefined) return followMerge(deps, linked.account_id);
  const account = deps.db.prepare("SELECT id FROM accounts WHERE id = ?").get(appUserId) as { id: string } | undefined;
  if (account === undefined) return null;
  return followMerge(deps, account.id);
}

// The highest tier any of this account's billing ids pays for. Never
// last-write-wins: after a merge of two paying accounts, one lapsing must not
// take the other's subscription down with it.
//
// The account merge (src/v1/accounts.ts) recomputes the tier the same way once
// it has moved the billing ids, so this takes the database alone rather than
// the whole TierDependencies: the merge route has no ids generator and no
// RevenueCat config, and neither is read here.
export function highestEntitledTier(deps: Pick<TierDependencies, "db">, accountId: string): Tier {
  const rows = deps.db.prepare("SELECT entitled_tier FROM account_billing_ids WHERE account_id = ?").all(accountId) as { entitled_tier: Tier }[];
  return rows.reduce<Tier>((best, row) => (RANK[row.entitled_tier] > RANK[best] ? row.entitled_tier : best), "free");
}

// Whether `tier` pays for more than `than`. The account merge asks, because a
// merge only ever raises a tier, and the ranking is not a thing to write down
// in two places.
export function isHigherTier(tier: Tier, than: Tier): boolean {
  return RANK[tier] > RANK[than];
}

export function applyRevenueCatEvent(deps: TierDependencies, event: RevenueCatEvent): void {
  const body = event.event;
  const receivedAt = deps.clock.now();
  const eventAt = body.event_timestamp_ms === undefined ? receivedAt : Math.floor(body.event_timestamp_ms / 1_000);
  // RevenueCat sends an id on every event. When one arrives without it there is
  // nothing to deduplicate on, so the id is rebuilt from the parts that make the
  // event what it is and an identical repeat still lands once.
  const eventId = body.id ?? `rc:${body.app_user_id}:${body.type}:${eventAt}`;

  deps.db.transaction(() => {
    if (deps.db.prepare("SELECT 1 FROM billing_events WHERE event_id = ?").get(eventId) !== undefined) return;

    const accountId = resolveAccount(deps, body.app_user_id);
    const tier = entitledTier(deps, body);
    const link = deps.db.prepare("SELECT last_event_at FROM account_billing_ids WHERE app_user_id = ?").get(body.app_user_id) as { last_event_at: number | null } | undefined;
    // Ordering is per billing id, not per account: one account can hold several
    // subscriptions and they expire independently.
    const stale = link !== undefined && link.last_event_at !== null && eventAt < link.last_event_at;
    const applied = accountId !== null && tier !== null && !stale;

    deps.db
      .prepare("INSERT INTO billing_events (event_id, app_user_id, account_id, type, event_at, applied, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(eventId, body.app_user_id, accountId, body.type, eventAt, applied ? 1 : 0, receivedAt);
    if (!applied || accountId === null || tier === null) return;

    // account_id is written on the update too. The only way it can move is when
    // resolveAccount followed a tombstone, so a late event for a merged account
    // repoints its billing id at the account that absorbed it.
    deps.db
      .prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_user_id) DO UPDATE SET account_id = excluded.account_id, last_event_at = excluded.last_event_at, entitled_tier = excluded.entitled_tier")
      .run(body.app_user_id, accountId, receivedAt, eventAt, tier);

    const current = deps.db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: Tier };
    const next = highestEntitledTier(deps, accountId);
    if (next === current.tier) return;
    deps.db.prepare("UPDATE accounts SET tier = ? WHERE id = ?").run(next, accountId);
    // "Tier became free" answers no support ticket. "Tier became free because
    // event X for billing id Y at time Z" closes one.
    deps.db
      .prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`tch_${randomUUID()}`, accountId, current.tier, next, `revenuecat ${body.type} for ${body.app_user_id}`, eventId, receivedAt);
  })();
}
