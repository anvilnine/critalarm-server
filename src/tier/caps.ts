import type { Caps, Tier } from "./types.js";

const tierCaps: Record<Tier, Caps> = {
  free: { devices: 5, critical_topics: 2, p4_daily: 50, history_incidents: 20, history_days: 7 },
  relay: { devices: 5, critical_topics: null, p4_daily: 1000, history_incidents: null, history_days: 90 },
  hosted: { devices: 5, critical_topics: null, p4_daily: 1000, history_incidents: null, history_days: 90 },
};

export function capsFor(tier: Tier): Caps {
  return { ...tierCaps[tier] };
}
