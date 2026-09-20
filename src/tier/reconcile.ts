import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Clock } from "../incident/types.js";
import { highestEntitledTier, isHigherTier } from "./revenuecat.js";
import type { Tier } from "./types.js";

// Guard 4 of planning/accounts-plan.md section 8: read entitlements back from
// RevenueCat instead of only listening for webhooks. A webhook that always
// fails and a product nobody has bought look identical from here, because both
// leave zero rows in billing_events. Only asking RevenueCat tells them apart.
//
// The key this uses is scoped to Customers Configuration, read only. The sweep
// reads. It never writes to RevenueCat, and there is no code here that could.

export interface RevenueCatApiConfig {
  secretApiKey: string;
  projectId: string;
  entitlements: Record<string, Tier>;
}

export interface ReconcileDependencies {
  db: Database.Database;
  clock: Clock;
  fetch: typeof globalThis.fetch;
  // Absent when REVENUECAT_SECRET_API_KEY is unset, which is every self-hosted
  // server. Absent means the sweep does nothing at all: no timer, no read, and
  // no log line on every tick about a key that is never going to arrive.
  revenueCatApi?: RevenueCatApiConfig;
  requestGapMs?: number;
}

type LiveDependencies = ReconcileDependencies & { revenueCatApi: RevenueCatApiConfig };

const API_ORIGIN = "https://api.revenuecat.com";

// RevenueCat v2 allows 480 Customer Information requests a minute, which is 8 a
// second. Source: https://www.revenuecat.com/docs/api-v2
// Waiting 250ms between reads asks at most 4 a second and leaves half the
// budget for everything else that touches a customer.
const DEFAULT_REQUEST_GAP_MS = 250;

// Nightly. Q6 of planning/revenuecat-setup.md: "Nightly is plenty at our size."
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

// Enough pages for any customer a person could really hold. The list is one
// entitlement per product tier, so page two is already theoretical.
const MAX_PAGES = 10;

const activeEntitlementsSchema = z.object({
  items: z.array(z.object({
    entitlement_id: z.string().min(1),
    // Milliseconds since epoch, null for a lifetime entitlement.
    expires_at: z.number().nullable().optional(),
  }).passthrough()),
  next_page: z.string().nullable().optional(),
}).passthrough();

type ActiveEntitlement = z.infer<typeof activeEntitlementsSchema>["items"][number];

function report(fields: Record<string, unknown>): void {
  // The same shape and the same place as push_dropped in push/dispatcher.ts:
  // one JSON line on stdout, which is what the deployment collects.
  console.log(JSON.stringify(fields));
}

// Every active entitlement for one billing id, or null when the read did not
// work. Null means "change nothing": a wrong project id, an expired key or a
// RevenueCat outage would otherwise read as "this customer pays for nothing"
// and take away what every paying account has.
async function readActiveEntitlements(deps: LiveDependencies, appUserId: string): Promise<ActiveEntitlement[] | null> {
  const items: ActiveEntitlement[] = [];
  let path = `/v2/projects/${encodeURIComponent(deps.revenueCatApi.projectId)}/customers/${encodeURIComponent(appUserId)}/active_entitlements`;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await deps.fetch(`${API_ORIGIN}${path}`, { headers: { Authorization: `Bearer ${deps.revenueCatApi.secretApiKey}`, Accept: "application/json" } });
    } catch (error: unknown) {
      report({ event: "reconcile_read_failed", app_user_id: appUserId, reason: "network", detail: String(error) });
      return null;
    }
    if (response.status !== 200) {
      report({ event: "reconcile_read_failed", app_user_id: appUserId, reason: "status", status: response.status });
      return null;
    }
    const parsed = activeEntitlementsSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      report({ event: "reconcile_read_failed", app_user_id: appUserId, reason: "body" });
      return null;
    }
    items.push(...parsed.data.items);
    if (parsed.data.next_page === undefined || parsed.data.next_page === null || parsed.data.next_page === "") return items;
    path = parsed.data.next_page;
  }
  report({ event: "reconcile_read_failed", app_user_id: appUserId, reason: "too many pages" });
  return null;
}

// What this billing id actually pays for, or null when the answer cannot be
// trusted enough to write it down.
function entitledTier(deps: LiveDependencies, appUserId: string, items: ActiveEntitlement[]): Tier | null {
  const nowMs = deps.clock.now() * 1_000;
  let best: Tier = "free";
  let unknown: string | null = null;
  for (const item of items) {
    // Guard 3, seen from the sweep: read the expiry, do not trust the list
    // membership. RevenueCat keeps an entitlement listed through a grace
    // period, and a card that failed on a Tuesday must not stop an alarm.
    if (item.expires_at !== undefined && item.expires_at !== null && item.expires_at <= nowMs) continue;
    const tier = deps.revenueCatApi.entitlements[item.entitlement_id];
    if (tier === undefined) {
      unknown = item.entitlement_id;
      continue;
    }
    if (isHigherTier(tier, best)) best = tier;
  }
  if (unknown !== null) {
    // An entitlement the map does not name might be the one paying for this
    // account. Say so and change nothing, rather than downgrade on a map that
    // someone forgot to update.
    report({ event: "reconcile_unknown_entitlement", app_user_id: appUserId, entitlement_id: unknown });
    return null;
  }
  return best;
}

function applyTier(deps: LiveDependencies, appUserId: string, tier: Tier): void {
  deps.db.transaction(() => {
    const link = deps.db.prepare("SELECT account_id, entitled_tier FROM account_billing_ids WHERE app_user_id = ?").get(appUserId) as { account_id: string; entitled_tier: Tier } | undefined;
    if (link === undefined) return;
    const at = deps.clock.now();
    if (link.entitled_tier !== tier) {
      // The point of the whole sweep. A disagreement here means the webhook
      // path lost an event, so a person is told rather than only the column
      // being fixed behind their back.
      report({ event: "tier_drift", source: "reconcile", app_user_id: appUserId, account_id: link.account_id, stored_tier: link.entitled_tier, revenuecat_tier: tier });
      deps.db.prepare("UPDATE account_billing_ids SET entitled_tier = ? WHERE app_user_id = ?").run(tier, appUserId);
    }
    const current = deps.db.prepare("SELECT tier FROM accounts WHERE id = ?").get(link.account_id) as { tier: Tier } | undefined;
    if (current === undefined) return;
    // The same ranking the webhook uses, never a second one: an account can
    // hold several subscriptions and one lapsing must not take the others down.
    const next = highestEntitledTier(deps, link.account_id);
    if (next === current.tier) return;
    deps.db.prepare("UPDATE accounts SET tier = ? WHERE id = ?").run(next, link.account_id);
    // Guard 5. event_id is null because no webhook caused this, and the reason
    // says the sweep did it, so a support question has an answer.
    deps.db
      .prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`tch_${randomUUID()}`, link.account_id, current.tier, next, `revenuecat reconcile for ${appUserId}`, null, at);
  })();
}

export async function reconcileBillingId(deps: LiveDependencies, appUserId: string): Promise<void> {
  const items = await readActiveEntitlements(deps, appUserId);
  if (items === null) return;
  const tier = entitledTier(deps, appUserId, items);
  if (tier === null) return;
  applyTier(deps, appUserId, tier);
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function reconcileEach(deps: LiveDependencies, appUserIds: string[]): Promise<void> {
  const gap = deps.requestGapMs ?? DEFAULT_REQUEST_GAP_MS;
  for (const [index, appUserId] of appUserIds.entries()) {
    if (index > 0 && gap > 0) await sleep(gap);
    await reconcileBillingId(deps, appUserId);
  }
}

// Every billing id we know about. account_billing_ids is the list of ids worth
// asking about: an account with no row there has never bought anything.
export async function reconcileAll(deps: ReconcileDependencies): Promise<void> {
  if (deps.revenueCatApi === undefined) return;
  const rows = deps.db.prepare("SELECT app_user_id FROM account_billing_ids ORDER BY app_user_id").all() as { app_user_id: string }[];
  await reconcileEach({ ...deps, revenueCatApi: deps.revenueCatApi }, rows.map((row) => row.app_user_id));
}

// Every billing id one account holds. Called after a merge, because the
// surviving account now holds ids it did not have a moment ago.
export async function reconcileAccount(deps: ReconcileDependencies, accountId: string): Promise<void> {
  if (deps.revenueCatApi === undefined) return;
  const rows = deps.db.prepare("SELECT app_user_id FROM account_billing_ids WHERE account_id = ? ORDER BY app_user_id").all(accountId) as { app_user_id: string }[];
  await reconcileEach({ ...deps, revenueCatApi: deps.revenueCatApi }, rows.map((row) => row.app_user_id));
}

export function startReconcileSweep(deps: ReconcileDependencies, intervalMs = DEFAULT_INTERVAL_MS): () => void {
  // Dormant, and dormant means silent. No key means no RevenueCat, which is
  // every self-hosted server, and those must not carry a timer or a warning
  // about something they will never be configured for.
  if (deps.revenueCatApi === undefined) return () => {};
  const run = () => {
    void reconcileAll(deps).catch((error: unknown) => { console.error("revenuecat reconcile failed", error); });
  };
  run();
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
