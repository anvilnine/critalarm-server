import type { Caps, Tier } from "./types.js";

const conservativeCaps: Caps = { devices: 1, critical_topics: 1, p4_daily: 50 };

export function capsFor(_tier: Tier): Caps {
  return { ...conservativeCaps };
}
