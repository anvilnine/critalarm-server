import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import { loadConfig } from "../../config.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createAuthHandler } from "../better-auth.js";

// Migration 14 holds a copy of better-auth's SQLite schema, so the one thing
// worth proving without a provider is that better-auth can read it. The
// credentials below are fake and no OAuth call is made: the request goes to
// better-auth's own session endpoint, which only touches the database.
//
// better-auth resolves the route against its baseURL, so the requests below use
// the absolute URL the config declares rather than Hono's localhost default.

const BASE = "https://alerts.example.com";
const db = openDatabase(":memory:");
migrate(db);
const config = loadConfig({
  BASE_URL: BASE,
  RELAY_URL: "https://relay.critalarm.app",
  DATA_DIR: "/tmp",
  ALLOW_NOOP_PUSH: "true",
  // Without this the guess reads "no push provider" as selfhosted, and a
  // selfhosted server does not mount the sign-in surface at all.
  MODE: "relay",
  AUTH_SECRET: "a".repeat(32),
  GOOGLE_CLIENT_ID: "not-a-real-client",
  GOOGLE_CLIENT_SECRET: "not-a-real-secret",
});
const authHandler = createAuthHandler(config, db);
const app = createApp({
  config,
  db,
  clock: { now: () => 1_760_000_000 },
  ids: { message: () => "m", incident: () => "i", timer: () => "t" },
  dispatch: async () => {},
  ...(authHandler === undefined ? {} : { authHandler }),
});
afterAll(() => db.close());

describe("the mounted better-auth surface", () => {
  it("is built when a provider is configured", () => {
    expect(authHandler).toBeInstanceOf(Function);
  });

  it("answers on the schema migration 14 created", async () => {
    const response = await app.request(`${BASE}/api/auth/get-session`);
    expect(response.status).toBe(200);
    // No cookie, so no session. The point is that the query ran at all.
    expect(await response.text()).toBe("null");
  });

  it("leaves the rest of the server alone", async () => {
    expect((await app.request(`${BASE}/v1/health`)).status).toBe(200);
    expect((await app.request(`${BASE}/api/v1/health`)).status).toBe(404);
  });
});
