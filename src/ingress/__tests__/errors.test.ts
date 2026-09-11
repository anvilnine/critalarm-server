import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IncidentService } from "../../incident/service.js";
import type { Clock, IdGenerator } from "../../incident/types.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createIngressRouter } from "../router.js";

const clock: Clock = { now: () => 1_000 };
const ids: IdGenerator = { message: () => "m_1", incident: () => "inc_1", timer: () => "tm_1" };

function setup(publishLimit?: number) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 0, 10, 60, 30, 'none', 1)").run();
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
  return createIngressRouter({ db, clock, ids, incidents: new IncidentService(db, clock, ids), dispatch: async () => {}, publishLimit });
}

describe("publish errors", () => {
  it("returns the exact unauthorized error", async () => {
    const response = await setup().request("/prod", { method: "POST", body: "down" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 40101, http: 401, error: "unauthorized" });
  });

  it("returns the exact invalid-topic error", async () => {
    const response = await setup().request("/bad!", { method: "POST", headers: { Authorization: "Bearer tk_test" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 40001, http: 400, error: "invalid topic name" });
  });

  it("returns the exact oversized-message error by UTF-8 byte size", async () => {
    const response = await setup().request("/prod", { method: "POST", headers: { Authorization: "Bearer tk_test" }, body: "é".repeat(2049) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: 41301, http: 413, error: "message too large" });
  });

  it("returns the exact rate-limit error", async () => {
    const app = setup(1);
    await app.request("/prod", { method: "POST", headers: { Authorization: "Bearer tk_test", "x-real-ip": "127.0.0.1" }, body: "one" });
    const response = await app.request("/prod", { method: "POST", headers: { Authorization: "Bearer tk_test", "x-real-ip": "127.0.0.1" }, body: "two" });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ code: 42901, http: 429, error: "rate limited" });
  });
});
