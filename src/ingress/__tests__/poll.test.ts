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

  it("uses insertion order for same-second message boundaries", async () => {
    const { add, app } = setup();
    add("m_z", 800);
    add("m_a", 800);
    expect((await ndjson(await app.request("/prod/json?poll=1&since=m_z", { headers }))).map((message) => message.id)).toEqual(["m_a"]);
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
    db.prepare("INSERT INTO incidents (id, topic_id, state, opened_at, acked_at, closed_at, last_message_at, updated_at, max_ring_s) VALUES ('inc_1', 'top_1', 'open', 1, NULL, NULL, 1, 1, 60)").run();
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


// api.md §2 and §4.2. A hosted or relay server hides a message older than the
// account's window even before the hourly prune has deleted it. A self-hosted
// server has no window.
describe("poll history window", () => {
  const day = 86_400;
  const now = 100 * day;
  const lateClock: Clock = { now: () => now };

  function windowSetup(mode: "selfhosted" | "relay" | "hosted") {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
    db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 0, 10, 60, 30, 'none', 1)").run();
    db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
    const insert = db.prepare("INSERT INTO messages (id, topic_id, incident_id, title, body, priority, tags, click, markdown, created_at) VALUES (?, 'top_1', NULL, ?, 'body', 3, '[]', NULL, 0, ?)");
    for (const [id, ageDays] of [["m_day6", 6], ["m_day8", 8]] as const) insert.run(id, id, now - ageDays * day);
    return createIngressRouter({ db, clock: lateClock, ids, incidents: new IncidentService(db, lateClock, ids), dispatch: async () => {}, mode });
  }

  it("hides a message past a free account's seven days on a hosted server", async () => {
    const app = windowSetup("hosted");
    expect((await ndjson(await app.request("/prod/json?poll=1&since=all", { headers }))).map((message) => message.id)).toEqual(["m_day6"]);
    expect((await ndjson(await app.request("/prod/json?poll=1&since=0", { headers }))).map((message) => message.id)).toEqual(["m_day6"]);
    expect((await ndjson(await app.request("/prod/json?poll=1&since=365d", { headers }))).map((message) => message.id)).toEqual(["m_day6"]);
  });

  it("returns everything it still holds on a self-hosted server", async () => {
    const app = windowSetup("selfhosted");
    expect((await ndjson(await app.request("/prod/json?poll=1&since=all", { headers }))).map((message) => message.id)).toEqual(["m_day8", "m_day6"]);
  });
});
