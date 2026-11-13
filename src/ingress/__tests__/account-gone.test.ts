import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IncidentService } from "../../incident/service.js";
import type { Clock, IdGenerator } from "../../incident/types.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { deleteDevice, registerDevice } from "../../tier/devices.js";
import { createIngressRouter } from "../router.js";

// api.md §1.8, "A topic nobody can hear". In hosted mode a publish to a topic
// whose account has no device answers 410 41001 and writes nothing.

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

const DEVICE = "dev_00000000-0000-4000-8000-000000000001";
const DEVICE_AGAIN = "dev_00000000-0000-4000-8000-000000000002";
const JOIN = "aj_join";
const gone = { code: 41001, http: 410, error: "account is gone" };
const bearer = { Authorization: "Bearer tk_test" };

type Mode = "selfhosted" | "relay" | "hosted";

function setup(mode: Mode, options: { device?: boolean; publishLimit?: number } = {}) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, join_token_hash, created_at) VALUES ('acc_1', 'hosted', ?, 1)").run(createHash("sha256").update(JOIN).digest("hex"));
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 1, 10, 60, 30, 'none', 1)").run();
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
  if (options.device !== false) {
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_1', 'hash_dev', 'ios', 'abcd', 1)").run(DEVICE);
  }
  const clock = new FakeClock();
  const ids = new FixedIds();
  const dispatch = vi.fn(async () => {});
  const app = createIngressRouter({ db, clock, ids, incidents: new IncidentService(db, clock, ids), dispatch, mode, ...(options.publishLimit === undefined ? {} : { publishLimit: options.publishLimit }) });
  const tierDeps = { db, clock, ids: { account: () => "acc_new", deviceToken: () => "dv_again", accountJoinToken: () => "aj_new" } };
  return { app, db, dispatch, tierDeps };
}

function counts(db: ReturnType<typeof openDatabase>): { messages: number; incidents: number; timers: number; tokens: string } {
  const one = (sql: string): number => (db.prepare(sql).get() as { count: number }).count;
  return {
    messages: one("SELECT COUNT(*) AS count FROM messages"),
    incidents: one("SELECT COUNT(*) AS count FROM incidents"),
    timers: one("SELECT COUNT(*) AS count FROM timers"),
    tokens: JSON.stringify(db.prepare("SELECT * FROM topic_tokens ORDER BY id").all()),
  };
}

describe("rule 1, the check: hosted publish to an account with no device", () => {
  it("answers 410 41001 after the only device is deleted, and writes nothing", async () => {
    const { app, db, dispatch, tierDeps } = setup("hosted");
    deleteDevice(tierDeps, DEVICE);
    const before = counts(db);
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "db01 is down" });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(gone);
    expect(counts(db)).toEqual(before);
    expect(before.messages).toBe(0);
    expect(before.incidents).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not charge the heads-up cap for a publish it refuses", async () => {
    const { app, db } = setup("hosted", { device: false });
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "4" }, body: "high" });
    expect(response.status).toBe(410);
    expect(db.prepare("SELECT COUNT(*) AS count FROM relay_p4_usage").get()).toEqual({ count: 0 });
  });

  it("still publishes with 200 when the account has a device", async () => {
    const { app } = setup("hosted");
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "down" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ incident_id: "inc_1" });
  });

  it("resolves a merged account forward: a tombstone whose survivor has a device publishes with 200", async () => {
    const { app, db } = setup("hosted", { device: false });
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'hosted', 1)").run();
    db.prepare("UPDATE accounts SET merged_into = 'acc_2' WHERE id = 'acc_1'").run();
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_2', 'hash_dev2', 'ios', 'abcd', 1)").run(DEVICE_AGAIN);
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "down" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ incident_id: "inc_1" });
  });

  it("answers 410 for a tombstone whose survivor has no device either", async () => {
    const { app, db } = setup("hosted", { device: false });
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'hosted', 1)").run();
    db.prepare("UPDATE accounts SET merged_into = 'acc_2' WHERE id = 'acc_1'").run();
    const response = await app.request("/prod", { method: "POST", headers: bearer, body: "down" });
    expect(response.status).toBe(410);
  });
});

describe("rule 2, order against the other errors", () => {
  it("answers 401 for a bad token before 410", async () => {
    const { app } = setup("hosted", { device: false });
    const response = await app.request("/prod", { method: "POST", headers: { Authorization: "Bearer tk_wrong" }, body: "down" });
    expect(response.status).toBe(401);
  });

  it("answers 400 for a bad topic name before 410", async () => {
    const { app } = setup("hosted", { device: false });
    const response = await app.request("/bad.name", { method: "POST", headers: bearer, body: "down" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 40001 });
  });

  it("keeps 413 ahead of 410 on POST /{topic}, as parsing runs before the publish", async () => {
    const { app } = setup("hosted", { device: false });
    const response = await app.request("/prod", { method: "POST", headers: bearer, body: "x".repeat(4097) });
    expect(response.status).toBe(413);
  });

  it("keeps 413 ahead of 410 on POST /, as the body is read before the token", async () => {
    const { app } = setup("hosted", { device: false });
    const response = await app.request("/", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ topic: "prod", message: "x".repeat(4097) }) });
    expect(response.status).toBe(413);
  });

  it("counts a refused publish against the rate limit", async () => {
    const { app } = setup("hosted", { device: false, publishLimit: 1 });
    const first = await app.request("/prod", { method: "POST", headers: bearer, body: "down" });
    const second = await app.request("/prod", { method: "POST", headers: bearer, body: "down" });
    expect(first.status).toBe(410);
    expect(second.status).toBe(429);
  });
});

describe("rule 3, every publish form goes through the check", () => {
  const forms: Array<[string, string, RequestInit]> = [
    ["POST /{topic}", "/prod", { method: "POST", headers: bearer, body: "down" }],
    ["PUT /{topic}", "/prod", { method: "PUT", headers: bearer, body: "down" }],
    ["POST / with JSON", "/", { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ topic: "prod", message: "down" }) }],
    ["POST /{topic}?m=", "/prod?m=down&p=5", { method: "POST", headers: bearer }],
    ["POST /{topic}?auth=", `/prod?auth=${Buffer.from("Bearer tk_test").toString("base64url")}`, { method: "POST", body: "down" }],
  ];

  it.each(forms)("%s answers 410 41001", async (_name, path, init) => {
    const { app, db } = setup("hosted", { device: false });
    const response = await app.request(path, init);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual(gone);
    expect(counts(db).messages).toBe(0);
  });
});

describe("rule 4, coming back: a device joining again makes the same token publish", () => {
  it("publishes with 200 and opens an incident after a device joins with the join token, and no token row changes", async () => {
    const { app, db, tierDeps } = setup("hosted");
    const tokensAtStart = counts(db).tokens;
    deleteDevice(tierDeps, DEVICE);
    const refused = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "down" });
    expect(refused.status).toBe(410);
    expect(counts(db).tokens).toBe(tokensAtStart);

    registerDevice(tierDeps, { device_id: DEVICE_AGAIN, platform: "ios", push_token: "abcd", app_version: "1.0.0" }, undefined, undefined, JOIN);
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "down" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ incident_id: "inc_1" });
    expect(counts(db)).toMatchObject({ messages: 1, incidents: 1, tokens: tokensAtStart });
  });
});

describe("rule 5, nothing leaks to a caller without the token", () => {
  it.each([
    ["no credential", {}],
    ["a wrong token", { Authorization: "Bearer tk_wrong" }],
  ])("answers 401, never 410, with %s", async (_name, headers) => {
    const { app } = setup("hosted", { device: false });
    const response = await app.request("/prod", { method: "POST", headers, body: "down" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 40101, http: 401, error: "unauthorized" });
  });
});

describe("other modes never answer 410", () => {
  it.each(["selfhosted", "relay"] as const)("%s mode publishes with 200 to an account with no device, as before", async (mode) => {
    const { app, db } = setup(mode, { device: false });
    const response = await app.request("/prod", { method: "POST", headers: { ...bearer, Priority: "5" }, body: "down" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ incident_id: "inc_1" });
    expect(counts(db)).toMatchObject({ messages: 1, incidents: 1 });
  });

  it("a router built with no mode keeps the old answer", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
    db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 1, 10, 60, 30, 'none', 1)").run();
    db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
    const clock = new FakeClock();
    const ids = new FixedIds();
    const app = createIngressRouter({ db, clock, ids, incidents: new IncidentService(db, clock, ids), dispatch: vi.fn(async () => {}) });
    const response = await app.request("/prod", { method: "POST", headers: bearer, body: "down" });
    expect(response.status).toBe(200);
  });
});
