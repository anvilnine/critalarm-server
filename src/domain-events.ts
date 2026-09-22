import type { DeliveryEvent } from "./incident/types.js";

export type { DeliveryEvent } from "./incident/types.js";

// api.md §5.2. The three kinds that say an incident changed state. They never
// ring: Android hears them as a data-only push, iOS as a Live Activity update.
export const stateKinds: ReadonlySet<DeliveryEvent["kind"]> = new Set(["ack", "close", "expire"]);

export function isStateKind(kind: DeliveryEvent["kind"]): boolean {
  return stateKinds.has(kind);
}

// What a dispatch reports back. `delivered` counts alarm pushes that APNs or
// FCM accepted. Wiring that only forwards (self-hosted relay client) and test
// fakes return nothing, so the caller treats that as zero.
export interface DispatchResult {
  delivered: number;
}

export type Dispatch = (events: readonly DeliveryEvent[]) => Promise<DispatchResult | void>;
