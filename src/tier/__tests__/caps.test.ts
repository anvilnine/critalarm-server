import { expect, it } from "vitest";
import { capsFor, tierRequired } from "../caps.js";

it("returns the contract cap row for every tier", () => {
  expect(capsFor("free")).toEqual({ devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 });
  for (const tier of ["relay", "hosted"] as const) {
    expect(capsFor(tier)).toEqual({ devices: 5, critical_topics: null, p4_daily: 1000, history_days: 90 });
  }
});

// api.md §1.8: 403 {"error":"tier","tier":"..."}. `tier` is the tier the route
// needs.
it("tierRequired is a 403 naming the tier the route needs", async () => {
  for (const tier of ["free", "relay", "hosted"] as const) {
    const response = tierRequired(tier);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "tier", tier });
  }
});
