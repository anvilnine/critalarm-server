import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createApp } from "../../index.js";
import { ensureSelfHostedIdentity } from "../../admin/credentials.js";
import type { Config } from "../../config.js";
import type { DeliveryEvent } from "../../incident/types.js";
import { PushDispatcher } from "../../push/dispatcher.js";
import type { PushSender } from "../../push/types.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { RelayClient } from "../client.js";
import { topicHash } from "../hash.js";
import { createRelayRouter } from "../router.js";

// api.md §3.8 and §4.1, both halves at once. A real relay router and real
// self-hosted apps with real relay clients, joined by injected functions only.
// No socket, no DNS, no secret.

const RELAY_URL = "https://relay.test";
const databases: Database.Database[] = [];
let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logs = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { logs.mockRestore(); for (const db of databases.splice(0)) db.close(); });

function newDb(): Database.Database {
  const db = openDatabase(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}

interface SelfHosted { app: ReturnType<typeof createApp>; db: Database.Database; client: RelayClient; lines: Record<string, unknown>[]; errors: unknown[]; baseUrl: string; topic(name: string): Promise<string>; publish(name: string, token: string, priority?: string): Promise<Response>; }

function world(options: { registration?: "open" | "closed" } = {}) {
  const relayDb = newDb();
  const sent: { device: string; kind: string; topicHash: string }[] = [];
  const sender: PushSender = { send: async (device, event) => { sent.push({ device: device.id, kind: event.kind, topicHash: event.topicHash }); return { status: 200, stale: false }; } };
  const dispatcher = new PushDispatcher(relayDb, { apns: sender, fcm: sender });
  const servers = new Map<string, SelfHosted>();
  const relayCalls: string[] = [];
  const confirmed: boolean[] = [];
  // The real confirmer's accept rule: status 200 and a JSON body that carries
  // the same challenge. The call goes to the self-hosted app that answers at
  // that base_url, if any.
  const confirmChallenge = async (baseUrl: string, challenge: string): Promise<boolean> => {
    const target = servers.get(baseUrl);
    if (target === undefined) return false;
    const response = await target.app.request(`${baseUrl}/v1/relay-challenge/${challenge}`);
    const body = await response.json().catch(() => undefined) as { challenge?: unknown } | undefined;
    const ok = response.status === 200 && body?.challenge === challenge;
    confirmed.push(ok);
    return ok;
  };
  const router = createRelayRouter(relayDb, async (event) => { await dispatcher.dispatch([event]); }, new Counters(relayDb, { now: () => 1 }), { confirmChallenge, ...(options.registration === undefined ? {} : { registration: options.registration }) });
  const relayFetch = async (request: Request): Promise<Response> => { relayCalls.push(`${request.method} ${new URL(request.url).pathname}`); return router.request(request); };
  let phones = 0;
  const phone = (hash: string, accountId = `acc_${++phones}`): string => {
    relayDb.prepare("INSERT OR IGNORE INTO accounts (id,tier,created_at) VALUES (?,'hosted',1)").run(accountId);
    const id = `dev_${accountId}_${phones++}`;
    relayDb.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES (?,?,?,'ios','token',1)").run(id, accountId, `h_${id}`);
    relayDb.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?,?)").run(id, hash);
    return id;
  };
  const clock = { ms: 1_700_000_000_000 };
  function selfHosted(baseUrl: string, db: Database.Database = newDb(), register = true) {
    const identity = ensureSelfHostedIdentity(db);
    const lines: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    const client = new RelayClient({ db, relayUrl: RELAY_URL, baseUrl, relayContent: "none", fetch: relayFetch, now: () => clock.ms, log: (line) => { lines.push(line); } });
    const config: Config = { mode: "selfhosted", baseUrl, relayUrl: RELAY_URL, relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false };
    const ids = { message: () => `m_${crypto.randomUUID()}`, incident: () => `inc_${crypto.randomUUID()}`, timer: () => `tm_${crypto.randomUUID()}` };
    // The wrapper in main.ts: a forward that throws is recorded, never raised.
    const dispatch = async (events: readonly DeliveryEvent[]) => { try { await client.forward(events); } catch (error: unknown) { errors.push(error); } };
    const app = createApp({ config, db, clock: { now: () => Math.floor(clock.ms / 1000) }, ids, dispatch, relayChallenge: (value) => client.isRelayChallenge(value) });
    const server: SelfHosted = {
      app, db, client, lines, errors, baseUrl,
      async topic(name: string): Promise<string> {
        const made = await app.request("/v1/topics", { method: "POST", headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" }, body: JSON.stringify({ name, critical: true }) });
        expect(made.status).toBe(201);
        return ((await made.json()) as { token: string }).token;
      },
      publish(name: string, token: string, priority = "5") { return app.request(`/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, priority }, body: "db01 is down" }); },
    };
    if (register) servers.set(baseUrl, server);
    return server;
  }
  const rawPush = (key: string, body: Record<string, unknown>) => router.request("/relay/v1/push", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ incident_id: "inc_x", message_id: "m_x", priority: 5, kind: "open", ring_until: 2_000_000_000, ...body }) });
  const keyOf = (server: SelfHosted): string => (server.db.prepare("SELECT relay_key FROM relay_client_credentials WHERE relay_url = ?").get(RELAY_URL) as { relay_key: string } | undefined)?.relay_key ?? "";
  return { relayDb, router, sent, servers, relayCalls, confirmed, phone, selfHosted, rawPush, keyOf, clock };
}

const A = "https://a.example.com";
const B = "https://b.example.com";

describe("a self-hosted server and the relay, joined", () => {
  it("registers a fresh server through the challenge with no secret, and rings a phone on its topic hash", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const token = await a.topic("prod");
    const phone = w.phone(topicHash(A, "prod"));

    expect(w.keyOf(a)).toBe("");
    const response = await a.publish("prod", token);

    expect(response.status).toBe(200);
    expect(a.errors).toEqual([]);
    expect(w.keyOf(a)).toMatch(/^rk_/);
    expect(w.confirmed).toEqual([true]);
    expect(a.lines.map((line) => line.event)).toEqual(["relay_registered"]);
    expect(w.sent).toEqual([{ device: phone, kind: "open", topicHash: topicHash(A, "prod") }]);
    // A fresh challenge was used and it is closed again.
    expect(a.client.isRelayChallenge("anything")).toBe(false);
  });

  it("keeps two servers with the same topic name apart, and a hosted account's own prod out of both", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const b = w.selfHosted(B);
    const tokenA = await a.topic("prod");
    const tokenB = await b.topic("prod");
    const phoneA = w.phone(topicHash(A, "prod"));
    const phoneB = w.phone(topicHash(B, "prod"));
    // A hosted account that owns its own topic "prod" on this relay.
    w.relayDb.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc_hosted','hosted',1)").run();
    w.relayDb.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_hosted','acc_hosted','h','ios','token',1)").run();
    const hostedHash = topicHash(RELAY_URL, "prod");
    w.relayDb.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_h','acc_hosted','prod',?,?,1,30,60,30,'none',1)").run(RELAY_URL, hostedHash);
    w.relayDb.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_hosted',?)").run(hostedHash);

    await a.publish("prod", tokenA);
    expect(w.sent.map((entry) => entry.device)).toEqual([phoneA]);
    await b.publish("prod", tokenB);

    expect(w.sent.map((entry) => entry.device)).toEqual([phoneA, phoneB]);
    expect(w.sent.some((entry) => entry.device === "dev_hosted")).toBe(false);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it("refuses a stranger who claims another server's base_url, and the real key keeps working", async () => {
    const w = world();
    const b = w.selfHosted(B);
    const tokenB = await b.topic("prod");
    const phoneB = w.phone(topicHash(B, "prod"));
    await b.publish("prod", tokenB);
    expect(w.sent).toHaveLength(1);

    // The stranger has its own database and its own challenge. Only B's app can
    // answer at B's address, and B never made that challenge.
    const stranger = w.selfHosted(B, newDb(), false);
    const mallory = await w.router.request("/relay/v1/servers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_url: B, version: "1", challenge: "c".repeat(43) }) });
    expect(mallory.status).toBe(422);
    expect(await mallory.json()).toEqual({ error: "challenge failed" });
    await expect(stranger.client.forwardOne({ kind: "open", topicHash: topicHash(B, "prod"), topic: "prod", incidentId: "i", messageId: "m", priority: 5, maxRingS: 60, ringUntil: 99, server: B, title: "T", body: "B", critical: true })).rejects.toThrow("relay registration failed: challenge_failed");
    expect(stranger.lines.map((line) => line.reason)).toEqual(["challenge_failed"]);

    await b.publish("prod", tokenB);
    expect(b.errors).toEqual([]);
    expect(w.sent.map((entry) => entry.device)).toEqual([phoneB, phoneB]);
  });

  it("stops a key holder from ringing another server's phone", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const b = w.selfHosted(B);
    const tokenA = await a.topic("prod");
    await b.topic("prod");
    const phoneA = w.phone(topicHash(A, "prod"));
    w.phone(topicHash(B, "prod"));
    await a.publish("prod", tokenA);
    const keyA = w.keyOf(a);
    expect(keyA).toMatch(/^rk_/);
    w.sent.length = 0;

    const hashB = topicHash(B, "prod");
    expect((await w.rawPush(keyA, { topic_hash: hashB })).status).toBe(400);
    expect((await w.rawPush(keyA, { topic_hash: hashB, topic: "prod" })).status).toBe(403);
    expect((await w.rawPush(keyA, { topic_hash: hashB, topic: "x/prod" })).status).toBe(400);
    expect((await w.rawPush(keyA, { topic_hash: hashB, topic: "../b.example.com/prod" })).status).toBe(400);
    expect((await w.rawPush(keyA, { topic_hash: topicHash(A, "prod"), topic: "a.example.com/prod" })).status).toBe(400);
    expect(w.sent).toEqual([]);
    // The same key still reaches its own server's phone.
    expect((await w.rawPush(keyA, { topic_hash: topicHash(A, "prod"), topic: "prod" })).status).toBe(202);
    expect(w.sent.map((entry) => entry.device)).toEqual([phoneA]);
  });

  it("answers the old key 401 after a server that lost its database registers again, and the old holder recovers on its own", async () => {
    const w = world();
    const old = w.selfHosted(B);
    const tokenOld = await old.topic("prod");
    const phone = w.phone(topicHash(B, "prod"));
    await old.publish("prod", tokenOld);
    const oldKey = w.keyOf(old);
    w.sent.length = 0;

    // B comes back with an empty database at the same address.
    const fresh = w.selfHosted(B);
    const tokenFresh = await fresh.topic("prod");
    await fresh.publish("prod", tokenFresh);
    const freshKey = w.keyOf(fresh);
    expect(freshKey).not.toBe(oldKey);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone]);
    expect((await w.rawPush(oldKey, { topic_hash: topicHash(B, "prod"), topic: "prod" })).status).toBe(401);
    expect(w.relayDb.prepare("SELECT COUNT(*) AS n FROM relay_servers WHERE base_url = ?").get(B)).toEqual({ n: 1 });

    // The old holder is the same server (the address answers as it again). Its
    // next forward gets 401, registers once and retries once.
    w.servers.set(B, old);
    w.sent.length = 0;
    w.relayCalls.length = 0;
    await old.publish("prod", tokenOld);

    expect(old.errors).toEqual([]);
    expect(w.relayCalls).toEqual(["POST /relay/v1/push", "POST /relay/v1/servers", "POST /relay/v1/push"]);
    expect(w.keyOf(old)).not.toBe(oldKey);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone]);
  });

  it("logs one actionable line when the relay has closed registration, backs off, and makes no call inside the wait", async () => {
    const w = world({ registration: "closed" });
    const a = w.selfHosted(A);
    const token = await a.topic("prod");
    w.phone(topicHash(A, "prod"));

    expect((await a.publish("prod", token)).status).toBe(200);
    expect(w.relayCalls).toEqual(["POST /relay/v1/servers"]);
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]).toMatchObject({ event: "relay_registration_failed", reason: "registration_closed", status: 403 });
    expect(String(a.lines[0]?.message)).toContain("RELAY_URL");

    w.clock.ms += 10_000;
    await a.publish("prod", token);
    expect(w.relayCalls).toEqual(["POST /relay/v1/servers"]);
    expect(a.lines).toHaveLength(1);
    expect(a.errors).toHaveLength(2);
    expect(w.sent).toEqual([]);

    // After the 30 second gap it tries again, once, and logs nothing new for the same reason.
    w.clock.ms += 30_000;
    await a.publish("prod", token);
    expect(w.relayCalls).toEqual(["POST /relay/v1/servers", "POST /relay/v1/servers"]);
    expect(a.lines).toHaveLength(1);
  });

  it("answers 403 topic mismatch after base_url changes, drops the key, then registers under the new address and delivers", async () => {
    const w = world();
    const db = newDb();
    const before = w.selfHosted(A, db);
    const tokenProd = await before.topic("prod");
    await before.publish("prod", tokenProd);
    const oldKey = w.keyOf(before);
    expect(oldKey).toMatch(/^rk_/);

    // Same database, same key, new BASE_URL. A topic made now hashes the new address.
    const moved = "https://moved.example.com";
    const after = w.selfHosted(moved, db);
    const tokenWeb = await after.topic("web");
    const phone = w.phone(topicHash(moved, "web"));
    expect(w.keyOf(after)).toBe(oldKey);

    await after.publish("web", tokenWeb);
    expect(after.lines.map((line) => line.event)).toEqual(["relay_topic_mismatch"]);
    expect(after.lines[0]).toMatchObject({ base_url: moved });
    expect(after.errors).toHaveLength(1);
    expect(w.keyOf(after)).toBe("");
    expect(w.sent).toEqual([]);

    await after.publish("web", tokenWeb);
    expect(after.lines.map((line) => line.event)).toEqual(["relay_topic_mismatch", "relay_registered"]);
    expect(w.keyOf(after)).toMatch(/^rk_/);
    expect(w.keyOf(after)).not.toBe(oldKey);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone]);
  });

  it("has the relay route accept every kind the real client forwards with 202", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const base = { topicHash: topicHash(A, "prod"), topic: "prod", incidentId: "inc_1", messageId: "m_1", priority: 5 as const, maxRingS: 60, ringUntil: 2_000_000_000, server: A, title: "T", body: "B", critical: true };
    const kinds = ["open", "repeat", "reopen", "p4", "p5", "ack", "close", "expire"] as const;
    const statuses: number[] = [];
    for (const kind of kinds) {
      const response = await a.client.forwardOne({ ...base, kind, priority: kind === "p4" ? 4 : 5, incidentId: kind === "p4" ? null : "inc_1", ringUntil: kind === "p4" || kind === "ack" || kind === "close" || kind === "expire" ? null : base.ringUntil });
      statuses.push(response?.status ?? 0);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 202, 202]);
    expect(a.errors).toEqual([]);
  });
});
