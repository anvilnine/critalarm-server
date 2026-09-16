import { z } from "zod";
import type { Tier, TierDependencies } from "./types.js";

const eventSchema = z.object({
  event: z.object({
    app_user_id: z.string().min(1),
    type: z.string().min(1),
    entitlement_id: z.string().min(1).optional(),
    entitlement_ids: z.array(z.string().min(1)).optional(),
    expiration_at_ms: z.number().nullable().optional(),
  }).passthrough(),
}).passthrough();

export type RevenueCatEvent = z.infer<typeof eventSchema>;

export function parseRevenueCatEvent(value: unknown): RevenueCatEvent {
  return eventSchema.parse(value);
}

function tierForEvent(deps: TierDependencies, event: RevenueCatEvent["event"]): Tier | null {
  if (event.type === "EXPIRATION" || (event.expiration_at_ms !== undefined && event.expiration_at_ms !== null && event.expiration_at_ms <= deps.clock.now() * 1_000)) return "free";
  const configured = deps.revenueCat?.entitlements ?? {};
  const entitlements = [event.entitlement_id, ...event.entitlement_ids ?? []];
  for (const entitlement of entitlements) {
    if (entitlement !== undefined && configured[entitlement] !== undefined) return configured[entitlement];
  }
  return null;
}

export function applyRevenueCatEvent(deps: TierDependencies, event: RevenueCatEvent): void {
  const tier = tierForEvent(deps, event.event);
  if (tier === null) return;
  deps.db.prepare("UPDATE accounts SET tier = ? WHERE id = ?").run(tier, event.event.app_user_id);
}
