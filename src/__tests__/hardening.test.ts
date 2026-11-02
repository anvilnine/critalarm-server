import { describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import type { Config } from "../config.js";
import { openDatabase } from "../store/database.js";
import { migrate } from "../store/migrations.js";
import { rotateAdminToken } from "../admin/credentials.js";

// api.md 1.26.0: JSON 500, nosniff on every response, HSTS when BASE_URL is https.

function build(baseUrl: string, mode: Config["mode"] = "relay") {
  const db = openDatabase(":memory:");
  migrate(db);
  const config: Config = { mode, baseUrl, relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false };
  const app = createApp({ config, db, clock: { now: () => 1000 }, ids: { message: () => "m", incident: () => "i", timer: () => "t" }, dispatch: async () => {} });
  return { app, db };
}

describe("unexpected errors", () => {
  it("answers 500 {error:internal error} as JSON, logs the error, and leaks nothing", async () => {
    const { app } = build("https://alerts.example.com");
    app.get("/boom", () => { throw new Error("secret detail at /srv/app.ts"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request("/boom");
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).toBe('{"error":"internal error"}');
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls[0]?.map(String))).toContain("secret detail");
    } finally { log.mockRestore(); }
  });

  it("leaves answers that already carry a specific error alone", async () => {
    const { app } = build("https://alerts.example.com");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const missing = await app.request("/v1/nothing/here");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "Not found" });
      const unauthorized = await app.request("/v1/topics");
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});

describe("security headers", () => {
  it("sends nosniff on every response: 200, 401, 404 and 500", async () => {
    const { app } = build("http://alerts.example.com");
    app.get("/boom", () => { throw new Error("x"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [path, status] of [["/v1/health", 200], ["/v1/topics", 401], ["/v1/nothing/here", 404], ["/boom", 500]] as const) {
        const response = await app.request(path);
        expect(response.status).toBe(status);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
    } finally { log.mockRestore(); }
  });

  it("sends HSTS on every response when BASE_URL is https", async () => {
    const { app } = build("https://alerts.example.com");
    app.get("/boom", () => { throw new Error("x"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const path of ["/v1/health", "/v1/topics", "/v1/nothing/here", "/boom"]) {
        const response = await app.request(path);
        expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
      }
    } finally { log.mockRestore(); }
  });

  it("sends a 429 with both headers", async () => {
    const { app } = build("https://alerts.example.com");
    let last: Response | undefined;
    for (let n = 0; n < 21; n += 1) last = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(last?.status).toBe(429);
    expect(last?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(last?.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("omits HSTS when BASE_URL is http", async () => {
    const { app } = build("http://localhost:8080");
    const response = await app.request("/v1/health");
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("self-hosted admin token", () => {
  it("accepts the exact ad_ token and refuses a wrong, truncated or longer one", async () => {
    const { app, db } = build("https://alerts.example.com", "selfhosted");
    const token = rotateAdminToken(db);
    const status = async (value: string) => (await app.request("/v1/topics", { headers: { authorization: `Bearer ${value}` } })).status;
    expect(await status(token)).toBe(200);
    expect(await status(`${token.slice(0, -1)}x`)).toBe(401);
    expect(await status(token.slice(0, -1))).toBe(401);
    expect(await status(`${token}x`)).toBe(401);
    expect(await status("ad_")).toBe(401);
    expect((await app.request("/v1/topics")).status).toBe(401);
  });
});
