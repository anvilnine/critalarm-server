import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createApp } from "../../index.js";
import { ensureSelfHostedIdentity } from "../../admin/credentials.js";
import type { Config } from "../../config.js";
import type { DeliveryEvent } from "../../incident/types.js";
import { openDatabase } from "../../store/database.js";
import { migrate, migrationCount } from "../../store/migrations.js";

// api.md §3.1, 1.21.0. A selfhosted server gives every topic a relay_name and
// returns it on the topic object. A relay or hosted server does neither.

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const config = (mode: Config["mode"]): Config => ({ mode, baseUrl: "https://alerts.example.com", relayUrl: "https://relay.example.com", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false });
const ids = { message: () => `m_${crypto.randomUUID()}`, incident: () => `inc_${crypto.randomUUID()}`, timer: () => `tm_${crypto.randomUUID()}` };

function server(mode: Config["mode"], db: Database.Database = openDatabase(":memory:")) {
  if (!databases.includes(db)) databases.push(db);
  migrate(db);
  let token = "dv_a";
  if (mode === "selfhosted") token = ensureSelfHostedIdentity(db).token;
  else {
    db.prepare("INSERT OR IGNORE INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT OR IGNORE INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('da','a',?,'ios','x',1)").run(createHash("sha256").update(token).digest("hex"));
  }
  const events: DeliveryEvent[] = [];
  const app = createApp({ config: config(mode), db, clock: { now: () => 1000 }, ids, dispatch: async (batch) => { events.push(...batch); } });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = (method: string, path: string, body?: Record<string, unknown>) => app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, db, events, call };
}

describe("relay_name on a selfhosted server", () => {
  it("is 43 characters of base64url on GET, POST and PATCH, and the same on each", async () => {
    const { call } = server("selfhosted");
    const made = await call("POST", "/v1/topics", { name: "prod" });
    expect(made.status).toBe(201);
    const created = await made.json() as { relay_name: string };
    expect(created.relay_name).toMatch(/^[-_A-Za-z0-9]{43}$/);
    const listed = await (await call("GET", "/v1/topics")).json() as { relay_name: string }[];
    const patched = await (await call("PATCH", "/v1/topics/prod", { critical: true })).json() as { relay_name: string };
    expect(listed.map((topic) => topic.relay_name)).toEqual([created.relay_name]);
    expect(patched.relay_name).toBe(created.relay_name);
  });

  it("differs between topics", async () => {
    const { call } = server("selfhosted");
    const one = await (await call("POST", "/v1/topics", { name: "one" })).json() as { relay_name: string };
    const two = await (await call("POST", "/v1/topics", { name: "two" })).json() as { relay_name: string };
    expect(one.relay_name).not.toBe(two.relay_name);
  });

  it("cannot be set by a request", async () => {
    const { call } = server("selfhosted");
    const made = await (await call("POST", "/v1/topics", { name: "prod", relay_name: "x".repeat(43) })).json() as { relay_name: string };
    expect(made.relay_name).not.toBe("x".repeat(43));
    const patched = await (await call("PATCH", "/v1/topics/prod", { relay_name: "y".repeat(43) })).json() as { relay_name: string };
    expect(patched.relay_name).toBe(made.relay_name);
  });

  it("is absent from the publish route's answer and from a request without a credential", async () => {
    const { app, call } = server("selfhosted");
    const made = await (await call("POST", "/v1/topics", { name: "prod" })).json() as { token: string; relay_name: string };
    const published = await app.request("/prod", { method: "POST", headers: { authorization: `Bearer ${made.token}` }, body: "x" });
    expect(await published.text()).not.toContain(made.relay_name);
    const bare = await app.request("/v1/topics");
    expect(bare.status).toBe(401);
    expect(await bare.text()).not.toContain(made.relay_name);
  });
});

describe("a topic that exists before the migration", () => {
  function upgraded() {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db, migrationCount - 1);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc_old','free',1)").run();
    const insert = db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES (?,?,?,?,?,0,30,60,30,'none',1)");
    insert.run("t1", "acc_old", "old-one", "https://alerts.example.com", "h1");
    insert.run("t2", "acc_old", "old-two", "https://alerts.example.com", "h2");
    return db;
  }
  const names = (db: Database.Database) => db.prepare("SELECT name, relay_name FROM topics ORDER BY name").all() as { name: string; relay_name: string | null }[];

  it("has a relay name after the selfhosted server starts, and the same one on a second start", () => {
    const db = upgraded();
    // The topics were made before the column existed.
    expect(() => names(db)).toThrow("no such column");
    server("selfhosted", db);
    const first = names(db);
    expect(first.map((row) => row.relay_name)).toEqual([expect.stringMatching(/^[-_A-Za-z0-9]{43}$/), expect.stringMatching(/^[-_A-Za-z0-9]{43}$/)]);
    expect(first[0]?.relay_name).not.toBe(first[1]?.relay_name);
    server("selfhosted", db);
    expect(names(db)).toEqual(first);
  });

  it("is not given one by a relay or hosted server", () => {
    for (const mode of ["relay", "hosted"] as const) {
      const db = upgraded();
      server(mode, db);
      expect(names(db).map((row) => row.relay_name)).toEqual([null, null]);
    }
  });
});

describe("relay and hosted servers", () => {
  it.each(["relay", "hosted"] as const)("return no relay_name in %s mode, keep the hash of the name, and store none", async (mode) => {
    const { call, db, app, events } = server(mode);
    const made = await call("POST", "/v1/topics", { name: "prod", critical: true });
    expect(made.status).toBe(201);
    const created = await made.json() as Record<string, unknown> & { token: string };
    expect(created).not.toHaveProperty("relay_name");
    expect(await (await call("GET", "/v1/topics")).json()).toEqual([expect.not.objectContaining({ relay_name: expect.anything() })]);
    expect(await (await call("PATCH", "/v1/topics/prod", { critical: false })).json()).not.toHaveProperty("relay_name");
    expect(db.prepare("SELECT relay_name, topic_hash FROM topics").get()).toEqual({ relay_name: null, topic_hash: createHash("sha256").update("https://alerts.example.com/prod").digest("hex") });
    await app.request("/prod", { method: "POST", headers: { authorization: `Bearer ${created.token}`, priority: "4" }, body: "x" });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).toMatchObject({ topic: "prod", topicHash: createHash("sha256").update("https://alerts.example.com/prod").digest("hex") });
  });
});
