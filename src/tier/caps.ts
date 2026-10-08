import type { Caps, Tier } from "./types.js";

const tierCaps: Record<Tier, Caps> = {
  free: { devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 },
  relay: { devices: 5, critical_topics: null, p4_daily: 1000, history_days: 90 },
  hosted: { devices: 5, critical_topics: null, p4_daily: 1000, history_days: 90 },
};

export function capsFor(tier: Tier): Caps {
  return { ...tierCaps[tier] };
}

// api.md §1.8. The answer of a route that needs a tier the account is not on.
// `tier` names the tier the route needs, never the one the account has.
export function tierRequired(tier: Tier): Response {
  return Response.json({ error: "tier", tier }, { status: 403 });
}
