import { describe, it, expect } from "vitest";
import { createApp } from "../index.js";
import { openDatabase } from "../store/database.js";
import { migrate } from "../store/migrations.js";

// docs/api.md puts every route at the root: /{topic} for the ntfy-compatible
// surface and /v1/ for everything else. The /api case below asserts 404 on
// purpose. It exists to fail if anyone reintroduces a prefix, which would make
// every URL in the contract and the integration docs wrong.

const testEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
};
const db = openDatabase(":memory:");
migrate(db);
const app = createApp({ config: { baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false }, db, clock: { now: () => 1 }, ids: { message: () => "m", incident: () => "i", timer: () => "t" }, dispatch: async () => {} });

describe("health", () => {
  it("answers at /v1/health", async () => {
    const res = await app.request("/v1/health", {}, testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("is not reachable under an /api prefix", async () => {
    const res = await app.request("/api/v1/health", {}, testEnv);
    expect(res.status).toBe(404);
  });
});

// api.md §4.2 is relay and hosted only. The tier router is not mounted in
// selfhosted mode, so joining an account and releasing a device do not exist
// there at all.
describe("selfhosted mode", () => {
  const selfhostedDb = openDatabase(":memory:");
  migrate(selfhostedDb);
  const selfhosted = createApp({ config: { mode: "selfhosted", baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false }, db: selfhostedDb, clock: { now: () => 1 }, ids: { message: () => "m", incident: () => "i", timer: () => "t" }, dispatch: async () => {} });

  it("does not serve POST /relay/v1/devices", async () => {
    const res = await selfhosted.request("/relay/v1/devices", { method: "POST", body: JSON.stringify({ device_id: "dev_123e4567-e89b-12d3-a456-426614174000", platform: "ios", push_token: "t", app_version: "1.0.0" }) }, testEnv);
    expect(res.status).toBe(404);
  });

  it("does not serve DELETE /relay/v1/devices/{device_id}", async () => {
    const res = await selfhosted.request("/relay/v1/devices/dev_123e4567-e89b-12d3-a456-426614174000", { method: "DELETE", headers: { Authorization: "Bearer dv_anything" } }, testEnv);
    expect(res.status).toBe(404);
  });
});

describe("404s", () => {
  it("answers plain JSON", async () => {
    const res = await app.request("/v1/nope", {}, testEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
