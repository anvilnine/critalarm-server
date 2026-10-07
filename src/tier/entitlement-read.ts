import type { Clock } from "../incident/types.js";
import type { PackId } from "./packs.js";
import { API_ORIGIN, MAX_PAGES, activeEntitlementsSchema, type ActiveEntitlement } from "./reconcile.js";
import { isHigherTier } from "./revenuecat.js";
import type { Tier } from "./types.js";

// api.md §4.3. One read of one customer's active entitlements, and what that
// list means for the tier and for the packs. Nothing here writes anything.
//
// The key this uses is read only. There is no code here that could write to
// RevenueCat.

export interface StoreReadConfig {
  secretApiKey: string;
  projectId: string;
  // Entitlement identifier to tier, and entitlement identifier to pack. Two
  // maps, because a pack is not a tier. The identifiers are configuration and
  // this code never spells one.
  entitlements: Record<string, Tier>;
  packEntitlements: Record<string, PackId>;
}

export interface StoreReadDependencies {
  clock: Clock;
  fetch: typeof globalThis.fetch;
  api: StoreReadConfig;
  // How long one request may take before it counts as a failed read. Unset
  // means no limit, which is what the tests use.
  readTimeoutMs?: number;
}

export type StoreAnswer =
  // 404 is a customer the store has never seen: a successful read with an empty
  // list (api.md §4.3).
  | { ok: true; status: 200 | 404; items: ActiveEntitlement[] }
  | { ok: false; status: number | null; reason: "network" | "status" | "body" | "too many pages" };

export async function readStore(deps: StoreReadDependencies, appUserId: string): Promise<StoreAnswer> {
  const items: ActiveEntitlement[] = [];
  let path = `/v2/projects/${encodeURIComponent(deps.api.projectId)}/customers/${encodeURIComponent(appUserId)}/active_entitlements`;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await deps.fetch(`${API_ORIGIN}${path}`, {
        headers: { Authorization: `Bearer ${deps.api.secretApiKey}`, Accept: "application/json" },
        ...(deps.readTimeoutMs === undefined ? {} : { signal: AbortSignal.timeout(deps.readTimeoutMs) }),
      });
    } catch {
      return { ok: false, status: null, reason: "network" };
    }
    // Only the first page can say "never seen". A 404 further in is a listing
    // that broke halfway, and half a list must not be read as the whole one.
    if (response.status === 404 && page === 0) return { ok: true, status: 404, items: [] };
    if (response.status !== 200) return { ok: false, status: response.status, reason: "status" };
    const parsed = activeEntitlementsSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { ok: false, status: 200, reason: "body" };
    items.push(...parsed.data.items);
    if (parsed.data.next_page === undefined || parsed.data.next_page === null || parsed.data.next_page === "") return { ok: true, status: 200, items };
    path = parsed.data.next_page;
  }
  return { ok: false, status: 200, reason: "too many pages" };
}

export interface StoreView {
  // Every identifier exactly as the store returned it, before any mapping.
  entitlementIds: string[];
  // Live identifiers that neither map names.
  unknownIds: string[];
  // The highest tier the live entitlements pay for.
  tier: Tier;
  // Each pack the live entitlements give, with its end in epoch seconds or null
  // for no end date.
  packs: Map<PackId, number | null>;
}

export function viewEntitlements(items: readonly ActiveEntitlement[], config: Pick<StoreReadConfig, "entitlements" | "packEntitlements">, nowSeconds: number): StoreView {
  const nowMs = nowSeconds * 1_000;
  const view: StoreView = { entitlementIds: items.map((item) => item.entitlement_id), unknownIds: [], tier: "free", packs: new Map() };
  for (const item of items) {
    // Read the expiry, do not trust the list membership alone. The store keeps
    // an entitlement listed through a billing grace period with a future
    // expiry, and that one counts. One whose expiry has passed does not.
    if (item.expires_at !== undefined && item.expires_at !== null && item.expires_at <= nowMs) continue;
    const tier = Object.hasOwn(config.entitlements, item.entitlement_id) ? config.entitlements[item.entitlement_id] : undefined;
    const pack = Object.hasOwn(config.packEntitlements, item.entitlement_id) ? config.packEntitlements[item.entitlement_id] : undefined;
    if (tier === undefined && pack === undefined) {
      if (!view.unknownIds.includes(item.entitlement_id)) view.unknownIds.push(item.entitlement_id);
      continue;
    }
    if (tier !== undefined && isHigherTier(tier, view.tier)) view.tier = tier;
    if (pack !== undefined) {
      const expiresAt = item.expires_at === undefined || item.expires_at === null ? null : Math.floor(item.expires_at / 1_000);
      const held = view.packs.get(pack);
      if (!view.packs.has(pack)) view.packs.set(pack, expiresAt);
      else if (held !== null && held !== undefined) view.packs.set(pack, expiresAt === null ? null : Math.max(held, expiresAt));
    }
  }
  return view;
}
