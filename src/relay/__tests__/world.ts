import { expect } from "vitest";
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
import { createRelayRouter } from "../router.js";

// A real relay router and real self-hosted apps with real relay clients, joined
// by injected functions only. No socket, no DNS, no secret. Shared by the joined
// tests.

export const RELAY_URL = "https://relay.test";
const databases: Database.Database[] = [];
export function closeDatabases(): void { for (const db of databases.splice(0)) db.close(); }

export function newDb(): Database.Database {
  const db = openDatabase(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}

export interface SelfHosted { app: ReturnType<typeof createApp>; db: Database.Database; client: RelayClient; lines: Record<string, unknown>[]; errors: unknown[]; baseUrl: string; topic(name: string): Promise<string>; publish(name: string, token: string, priority?: string): Response | Promise<Response>; }

function buildWorld(options: { registration?: "open" | "closed"; plainHash?: boolean } = {}) {
  const relayDb = newDb();
  const sent: { device: string; kind: string; topicHash: string }[] = [];
  const sender: PushSender = { send: async (device, event) => { sent.push({ device: device.id, kind: event.kind, topicHash: event.topicHash }); return { status: 200, stale: false }; } };
  const dispatcher = new PushDispatcher(relayDb, { apns: sender, fcm: sender });
  const servers = new Map<string, SelfHosted>();
  const relayCalls: string[] = [];
  const confirmed: boolean[] = [];
  // The real confirmer's accept rule: status 200 and a JSON body that carries
  // the same challenge and names the host the registration was called on. The
  // call goes to the self-hosted app that answers at that base_url, if any.
  const confirmChallenge = async (baseUrl: string, challenge: string, relayHosts: readonly string[]): Promise<boolean> => {
    const target = servers.get(baseUrl);
    if (target === undefined) return false;
    const response = await target.app.request(`${baseUrl}/v1/relay-challenge/${challenge}`);
    const body = await response.json().catch(() => undefined) as { challenge?: unknown; relay?: unknown } | undefined;
    const ok = response.status === 200 && body?.challenge === challenge && typeof body?.relay === "string" && relayHosts.includes(body.relay);
    confirmed.push(ok);
    return ok;
  };
  const router = createRelayRouter(relayDb, async (event) => { await dispatcher.dispatch([event]); }, new Counters(relayDb, { now: () => 1 }), { confirmChallenge, publicHosts: [new URL(RELAY_URL).host], ...(options.registration === undefined ? {} : { registration: options.registration }) });
  // A real request carries a Host header. The relay does not read it for the
  // challenge check, but the transport adds the one a client would send.
  const toRouter = (request: Request): Promise<Response> | Response => {
    const headers = new Headers(request.headers);
    headers.set("host", new URL(request.url).host);
    return router.request(new Request(request, { headers }));
  };
  const relayPushBodies: Record<string, unknown>[] = [];
  const relayFetch = async (request: Request): Promise<Response> => { relayCalls.push(`${request.method} ${new URL(request.url).pathname}`); if (new URL(request.url).pathname === "/relay/v1/push") relayPushBodies.push(await request.clone().json() as Record<string, unknown>); return toRouter(request); };
  let phones = 0;
  const phone = (hash: string, accountId = `acc_${++phones}`): string => {
    relayDb.prepare("INSERT OR IGNORE INTO accounts (id,tier,created_at) VALUES (?,'hosted',1)").run(accountId);
    const id = `dev_${accountId}_${phones++}`;
    relayDb.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES (?,?,?,'ios','token',1)").run(id, accountId, `h_${id}`);
    relayDb.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?,?)").run(id, hash);
    return id;
  };
  const clock = { ms: 1_700_000_000_000 };
  function selfHosted(baseUrl: string, db: Database.Database = newDb(), register = true, via: { relayUrl: string; fetch: (request: Request) => Promise<Response> } = { relayUrl: RELAY_URL, fetch: relayFetch }) {
    const identity = ensureSelfHostedIdentity(db);
    const lines: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    const client = new RelayClient({ db, relayUrl: via.relayUrl, baseUrl, relayContent: "none", ...(options.plainHash === undefined ? {} : { plainHash: options.plainHash }), fetch: via.fetch, now: () => clock.ms, log: (line) => { lines.push(line); } });
    const config: Config = { mode: "selfhosted", baseUrl, relayUrl: via.relayUrl, relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false };
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
  return { relayDb, router, relayPushBodies, sent, servers, relayCalls, confirmed, phone, selfHosted, rawPush, keyOf, clock, toRouter };
}


export interface World {
  relayDb: Database.Database;
  router: ReturnType<typeof createRelayRouter>;
  sent: { device: string; kind: string; topicHash: string }[];
  servers: Map<string, SelfHosted>;
  relayCalls: string[];
  // The JSON body of every push the relay received, in order.
  relayPushBodies: Record<string, unknown>[];
  confirmed: boolean[];
  phone(hash: string, accountId?: string): string;
  selfHosted(baseUrl: string, db?: Database.Database, register?: boolean, via?: { relayUrl: string; fetch: (request: Request) => Promise<Response> }): SelfHosted;
  rawPush(key: string, body: Record<string, unknown>): Response | Promise<Response>;
  keyOf(server: SelfHosted): string;
  clock: { ms: number };
  toRouter(request: Request): Promise<Response> | Response;
}
export function world(options: { registration?: "open" | "closed"; plainHash?: boolean } = {}): World { return buildWorld(options); }
