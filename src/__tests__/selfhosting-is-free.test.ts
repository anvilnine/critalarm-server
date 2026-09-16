import { describe, it, expect } from "vitest";
import { createApp } from "../index.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../store/database.js";
import { migrate } from "../store/migrations.js";

// Crit Alarm has decided that self-hosting costs a self-hoster nothing, and
// that it stays that way. Caps, anonymous accounts and the billing webhook all
// live on the tier router, so the promise is kept by never mounting that router
// on a selfhosted server. This file exists to break if a later change mounts it
// there, even by accident.
//
// The server below is the operator the old inference read wrong: their own APNs
// key, no relay URL, and `mode: selfhosted` written down.

const testEnv = { ALLOWED_ORIGINS: "http://localhost:3000" };

const config = loadConfig({
  BASE_URL: "https://alerts.example.com",
  DATA_DIR: "/tmp",
  MODE: "selfhosted",
  APNS_TEAM_ID: "team",
  APNS_KEY_ID: "key",
  APNS_PRIVATE_KEY: "pem",
  APNS_BUNDLE_ID: "app.critalarm.example",
});

const db = openDatabase(":memory:");
migrate(db);
const app = createApp({ config, db, clock: { now: () => 1 }, ids: { message: () => "m", incident: () => "i", timer: () => "t" }, dispatch: async () => {} });

// Every route the tier router serves, plus the relay router's two.
const TIER_ROUTES = [
  ["POST", "/relay/v1/devices"],
  ["PATCH", "/relay/v1/devices/dev_1"],
  ["POST", "/relay/v1/devices/dev_1/subscriptions"],
  ["DELETE", "/relay/v1/devices/dev_1/subscriptions/topichash"],
  ["POST", "/relay/v1/devices/dev_1/tokens"],
  ["DELETE", "/relay/v1/devices/dev_1/tokens/apns"],
  ["POST", "/webhooks/revenuecat"],
] as const;

const RELAY_ROUTES = [
  ["POST", "/relay/v1/servers"],
  ["POST", "/relay/v1/push"],
] as const;

describe("self-hosting Crit Alarm stays free, permanently", () => {
  it("promises a selfhosted server serves no tier route, so caps can never be mounted on one", async () => {
    for (const [method, path] of TIER_ROUTES) {
      const res = await app.request(path, { method }, testEnv);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });

  it("serves no relay route either, so it never accepts another server's pushes", async () => {
    for (const [method, path] of RELAY_ROUTES) {
      const res = await app.request(path, { method }, testEnv);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("reports the mode the operator wrote down at GET /v1/info", async () => {
    const res = await app.request("/v1/info", {}, testEnv);

    expect(res.status).toBe(200);
    expect((await res.json() as { mode: string }).mode).toBe("selfhosted");
  });
});
