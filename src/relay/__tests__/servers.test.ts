import { describe, expect, it, vi } from "vitest";
import { createRelayRouter } from "../router.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";

function router(registrationSecret?: string) {
  const db = openDatabase(":memory:");
  migrate(db);
  return { db, app: createRelayRouter(db, vi.fn(async () => {}), new Counters(db, { now: () => 1 }), registrationSecret) };
}

function register(app: ReturnType<typeof createRelayRouter>, secret?: string) {
  return app.request("/relay/v1/servers", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret === undefined ? {} : { Authorization: `Bearer ${secret}` }) },
    body: JSON.stringify({ base_url: "https://alerts.example.com", version: "0.1.0" }),
  });
}

describe("relay server registration", () => {
  it("is not mounted without a registration secret", async () => {
    const { db, app } = router();
    try {
      expect((await register(app)).status).toBe(404);
      expect(db.prepare("SELECT count(*) AS rows FROM relay_servers").get()).toEqual({ rows: 0 });
    } finally { db.close(); }
  });

  it("is not mounted when the registration secret is empty", async () => {
    const { db, app } = router("");
    try {
      expect((await register(app, "")).status).toBe(404);
    } finally { db.close(); }
  });

  it("refuses a caller with no secret and a caller with the wrong one", async () => {
    const { db, app } = router("registration-secret");
    try {
      expect((await register(app)).status).toBe(401);
      expect((await register(app, "wrong")).status).toBe(401);
      expect(db.prepare("SELECT count(*) AS rows FROM relay_servers").get()).toEqual({ rows: 0 });
    } finally { db.close(); }
  });

  it("issues a relay key to a caller that presents the secret", async () => {
    const { db, app } = router("registration-secret");
    try {
      const response = await register(app, "registration-secret");
      expect(response.status).toBe(201);
      expect(await response.json() as { relay_key: string }).toEqual({ relay_key: expect.stringMatching(/^rk_[0-9a-f]{32}$/) });
      expect(db.prepare("SELECT base_url, version FROM relay_servers").all()).toEqual([{ base_url: "https://alerts.example.com", version: "0.1.0" }]);
    } finally { db.close(); }
  });
});
