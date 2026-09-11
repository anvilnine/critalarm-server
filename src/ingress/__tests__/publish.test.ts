import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IncidentService } from "../../incident/service.js";
import type { Clock, IdGenerator } from "../../incident/types.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createIngressRouter } from "../router.js";

class FakeClock implements Clock {
  constructor(public value = 1_000) {}
  now(): number { return this.value; }
}

class FixedIds implements IdGenerator {
  private messageNumber = 0;
  private timerNumber = 0;
  message(): string { this.messageNumber += 1; return `m_${this.messageNumber}`; }
  incident(): string { return "inc_1"; }
  timer(): string { this.timerNumber += 1; return `tm_${this.timerNumber}`; }
}

function setup(critical = true, dispatch = vi.fn(async () => {})) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', ?, 10, 60, 30, 'none', 1)").run(critical ? 1 : 0);
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
  const clock = new FakeClock();
  const ids = new FixedIds();
  const app = createIngressRouter({ db, clock, ids, incidents: new IncidentService(db, clock, ids), dispatch });
  return { app, db, dispatch };
}

const bearer = { Authorization: "Bearer tk_test" };

describe("ntfy publish", () => {
  it.each(["POST", "PUT"] as const)("publishes with %s /{topic}", async (method) => {
    const { app } = setup();
    const response = await app.request("/prod", { method, headers: bearer, body: "db01 is down" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"id":"m_1","time":1000,"expires":44200,"event":"message","topic":"prod","title":"prod","message":"db01 is down","priority":3,"tags":[]}');
  });

  it("accepts JSON publish at root", async () => {
    const { app } = setup();
    const response = await app.request("/", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ topic: "prod", message: "db down", title: "Kuma", priority: 4, tags: ["warning"], click: "https://status.example.com", markdown: true, unknown: "ignored" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "m_1", time: 1_000, expires: 44_200, event: "message", topic: "prod", title: "Kuma", message: "db down", priority: 4, tags: ["warning"], click: "https://status.example.com", markdown: true });
  });

  it("returns an incident id and dispatches for critical priority 5", async () => {
    const { app, dispatch } = setup(true);
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "down" });
    expect(await response.json()).toMatchObject({ id: "m_1", incident_id: "inc_1" });
    expect(dispatch).toHaveBeenCalledWith([expect.objectContaining({ kind: "open", incidentId: "inc_1", priority: 5 })]);
  });

  it("joins a second critical publish to the existing incident", async () => {
    const { app, db, dispatch } = setup(true);
    await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "first" });
    const second = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "second" });
    expect(await second.json()).toMatchObject({ id: "m_2", incident_id: "inc_1" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM incidents").get()).toEqual({ count: 1 });
    expect(dispatch).toHaveBeenLastCalledWith([expect.objectContaining({ kind: "p5", incidentId: "inc_1" })]);
  });

  it("forwards noncritical priority 5 without an incident", async () => {
    const { app, db, dispatch } = setup(false);
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "down" });
    expect(await response.json()).not.toHaveProperty("incident_id");
    expect(db.prepare("SELECT incident_id FROM messages").get()).toEqual({ incident_id: null });
    expect(dispatch).toHaveBeenCalledWith([expect.objectContaining({ kind: "p5", incidentId: null, priority: 5, critical: false })]);
  });

  it("forwards priority 4 and suppresses priority 1 and 2 delivery", async () => {
    const { app, dispatch } = setup();
    await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "4" }, body: "high" });
    await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "1" }, body: "min" });
    await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "2" }, body: "low" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith([expect.objectContaining({ kind: "p4", incidentId: null, priority: 4 })]);
  });

  it("stores but does not dispatch the 51st account-wide priority 4 message today", async () => {
    const { app, db, dispatch } = setup();
    for (let number = 0; number < 50; number += 1) db.prepare("INSERT INTO messages (id,topic_id,incident_id,title,body,priority,tags,markdown,created_at) VALUES (?, 'top_1', NULL, 'old', 'old', 4, '[]', 0, 1000)").run(`old_${number}`);
    const response = await app.request("/prod", { method:"POST",headers:{...bearer,Priority:"4"},body:"new" });
    expect(response.status).toBe(200); expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the 50th account-wide priority 4 message today", async () => {
    const { app, db, dispatch } = setup();
    for (let number = 0; number < 49; number += 1) db.prepare("INSERT INTO messages (id,topic_id,incident_id,title,body,priority,tags,markdown,created_at) VALUES (?, 'top_1', NULL, 'old', 'old', 4, '[]', 0, 1000)").run(`old_${number}`);
    await app.request("/prod", { method:"POST",headers:{...bearer,Priority:"4"},body:"fiftieth" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("accepts Basic authorization", async () => {
    const { app } = setup();
    const response = await app.request("/prod", { method: "POST", headers: { Authorization: `Basic ${Buffer.from("anything:tk_test").toString("base64")}` }, body: "down" });
    expect(response.status).toBe(200);
  });

  it("accepts ntfy query authorization", async () => {
    const { app } = setup();
    const response = await app.request(`/prod?auth=${encodeURIComponent(Buffer.from("Bearer tk_test").toString("base64"))}`, { method: "POST", body: "down" });
    expect(response.status).toBe(200);
  });

  it("rejects a token scoped to another topic", async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_2', 'acc_1', 'staging', 'https://alerts.example.com', 'hash_staging', 0, 10, 60, 30, 'none', 1)").run();
    const response = await app.request("/staging", { method: "POST", headers: bearer, body: "down" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 40101, http: 401, error: "unauthorized" });
  });

  it("keeps a stored message when delivery dispatch rejects", async () => {
    const rejectedDispatch = vi.fn(async () => { throw new Error("provider unavailable"); });
    const { app, db } = setup(false, rejectedDispatch);
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "4" }, body: "down" });
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT id, body FROM messages").all()).toEqual([{ id: "m_1", body: "down" }]);
  });
});
