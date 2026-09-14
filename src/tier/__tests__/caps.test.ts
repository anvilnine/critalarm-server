import { expect, it } from "vitest";
import { capsFor } from "../caps.js";

it("returns the contract cap row for every tier", () => {
  expect(capsFor("free")).toEqual({ devices: 1, critical_topics: 2, p4_daily: 50, history_incidents: 20, history_days: 7 });
  for (const tier of ["relay", "hosted"] as const) {
    expect(capsFor(tier)).toEqual({ devices: 5, critical_topics: null, p4_daily: 1000, history_incidents: null, history_days: 90 });
  }
});
