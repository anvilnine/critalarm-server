import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IncidentService } from "../../incident/service.js";
import type { Clock, IdGenerator } from "../../incident/types.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createIngressRouter } from "../router.js";

const clock: Clock = { now: () => 1_000 };
let nextId = 0;
const ids: IdGenerator = { message: () => `generated_${nextId += 1}`, incident: () => "inc_1", timer: () => "tm_1" };

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 0, 10, 60, 30, 'none', 1)").run();
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
  const insert = db.prepare("INSERT INTO messages (id, topic_id, incident_id, title, body, priority, tags, click, markdown, created_at) VALUES (?, 'top_1', ?, ?, ?, 3, '[]', NULL, 0, ?)");
  return {
    db,
    app: createIngressRouter({ db, clock, ids, incidents: new IncidentService(db, clock, ids), dispatch: async () => {} }),
    add: (id: string, createdAt: number, incidentId: string | null = null) => insert.run(id, incidentId, id, `body ${id}`, createdAt),
  };
}

const headers = { Authorization: "Bearer tk_test" };

async function ndjson(response: Response): Promise<{ id: string; time: number; expires: number; event: string; topic: string; title: string; message: string; priority: number; tags: string[]; incident_id?: string }[]> {
  const text = await response.text();
  return text === "" ? [] : text.trimEnd().split("\n").map((line) => JSON.parse(line) as { id: string; time: number; expires: number; event: string; topic: string; title: string; message: string; priority: number; tags: string[]; incident_id?: string });
}

describe("ntfy poll", () => {
  it("uses the omitted 12-hour boundary", async () => {
    const { add, app } = setup();
    add("m_expired", -42_201);
    add("m_boundary", -42_200);
    const response = await app.request("/prod/json?poll=1", { headers });
    expect(response.status).toBe(200);
    expect((await ndjson(response)).map((message) => message.id)).toEqual(["m_boundary"]);
  });

  it("returns all messages when since is all", async () => {
    const { add, app } = setup();
    add("m_old", -50_000);
    add("m_new", 999);
    expect((await ndjson(await app.request("/prod/json?poll=1&since=all", { headers }))).map((message) => message.id)).toEqual(["m_old", "m_new"]);
  });

  it("accepts Unix-second and duration since values", async () => {
    const { add, app } = setup();
    add("m_old", 399);
    add("m_boundary", 400);
    add("m_new", 996);
    expect((await ndjson(await app.request("/prod/json?poll=1&since=995", { headers }))).map((message) => message.id)).toEqual(["m_new"]);
    expect((await ndjson(await app.request("/prod/json?poll=1&since=10m", { headers }))).map((message) => message.id)).toEqual(["m_boundary", "m_new"]);
  });

  it("uses a message id as an exclusive boundary", async () => {
    const { add, app } = setup();
    add("m_a", 800);
    add("m_b", 800);
    add("m_c", 801);
    expect((await ndjson(await app.request("/prod/json?poll=1&since=m_a", { headers }))).map((message) => message.id)).toEqual(["m_b", "m_c"]);
  });

  it("returns oldest-first NDJSON with a final newline", async () => {
    const { add, app } = setup();
    add("m_a", 800);
    add("m_b", 801);
    const response = await app.request("/prod/json?poll=1&since=all", { headers });
    const text = await response.text();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["m_a", "m_b"]);
  });

  it("preserves the additive incident id on an incident message", async () => {
    const { add, app, db } = setup();
    db.prepare("INSERT INTO incidents (id, topic_id, state, opened_at, acked_at, closed_at, last_message_at, max_ring_s) VALUES ('inc_1', 'top_1', 'open', 1, NULL, NULL, 1, 60)").run();
    add("m_incident", 800, "inc_1");
    expect((await ndjson(await app.request("/prod/json?poll=1&since=all", { headers })))[0]?.incident_id).toBe("inc_1");
  });

  it("returns an empty body for an empty valid result", async () => {
    const { app } = setup();
    const response = await app.request("/prod/json?poll=1", { headers });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("requires poll=1 and rejects unsupported streaming paths", async () => {
    const { app } = setup();
    expect((await app.request("/prod/json", { headers })).status).toBe(501);
    expect((await app.request("/prod/sse", { headers })).status).toBe(501);
    expect((await app.request("/prod/ws", { headers })).status).toBe(501);
    expect((await app.request("/prod/raw", { headers })).status).toBe(501);
  });
});
