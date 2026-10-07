import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import { readStore, viewEntitlements, type StoreReadConfig } from "./entitlement-read.js";
import { isHigherTier } from "./revenuecat.js";
import type { Tier } from "./types.js";

// The step before reading is switched on. Every write stays on the event path.
// Beside it, this reads the store the way the read path would, and logs one
// line saying what that read would have written. It writes nothing: no tier,
// no pack, no queue row, no read number.
//
// The line exists to be read by a person before the switch. entitlement_ids is
// the identifiers exactly as the store returned them, before any mapping,
// which is the only place their form can be seen.

export type ShadowTrigger = "webhook" | "sweep" | "refresh";

export interface ShadowDependencies {
  db: Database.Database;
  clock: Clock;
  fetch: typeof globalThis.fetch;
  api: StoreReadConfig;
  readTimeoutMs?: number;
}

export class ShadowReads {
  constructor(private readonly deps: ShadowDependencies) {}

  // Never throws and never rejects: a shadow read that goes wrong must not
  // reach the request or the sweep it runs beside.
  async read(appUserId: string, trigger: ShadowTrigger): Promise<void> {
    try {
      const answer = await readStore(this.deps, appUserId);
      const stored = this.deps.db.prepare("SELECT entitled_tier FROM account_billing_ids WHERE app_user_id = ?").get(appUserId) as { entitled_tier: Tier } | undefined;
      // A customer with no billing row is one the event path holds at free.
      const storedTier: Tier = stored?.entitled_tier ?? "free";
      if (!answer.ok) {
        console.log(JSON.stringify({ event: "billing_shadow", app_user_id: appUserId, trigger, status: answer.status, reason: answer.reason, entitlement_ids: [], unknown_ids: [], read_tier: null, read_packs: [], stored_tier: storedTier, agrees: null }));
        return;
      }
      const view = viewEntitlements(answer.items, this.deps.api, this.deps.clock.now());
      // What the read path would write: a list carrying an identifier neither
      // map names may raise the tier and may not lower it.
      const readTier = view.unknownIds.length > 0 && isHigherTier(storedTier, view.tier) ? storedTier : view.tier;
      console.log(JSON.stringify({
        event: "billing_shadow",
        app_user_id: appUserId,
        trigger,
        status: answer.status,
        entitlement_ids: view.entitlementIds,
        unknown_ids: view.unknownIds,
        read_tier: readTier,
        read_packs: [...view.packs.keys()],
        stored_tier: storedTier,
        agrees: readTier === storedTier,
      }));
    } catch (error: unknown) {
      console.error("billing shadow read failed", error);
    }
  }
}
