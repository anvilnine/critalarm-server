import type { DeliveryEvent } from "./incident/types.js";

export type { DeliveryEvent } from "./incident/types.js";

// What a dispatch reports back. `delivered` counts alarm pushes that APNs or
// FCM accepted. Wiring that only forwards (self-hosted relay client) and test
// fakes return nothing, so the caller treats that as zero.
export interface DispatchResult {
  delivered: number;
}

export type Dispatch = (events: readonly DeliveryEvent[]) => Promise<DispatchResult | void>;
