import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayRouter } from "../router.js";
import { RelayClient, relayKeyHash } from "../client.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createIngressRouter } from "../../ingress/router.js";
import { IncidentService } from "../../incident/service.js";
import type { Clock, DeliveryEvent, IdGenerator } from "../../incident/types.js";
import { ApnsSender } from "../../push/apns.js";
import type { ApnsTransport } from "../../push/apns.js";
import { FcmSender } from "../../push/fcm.js";
import { PushDispatcher } from "../../push/dispatcher.js";

// api.md §1.7, §4.1 and §5. A self-hosted server reaches a phone only through
// its relay client. These tests publish to the self-hosted server over HTTP,
// let the client forward to a relay as src/main.ts wires it, and look at three
// things: what the relay received, what it dispatched, and the pushes it built.

const baseUrl = "https://alerts.example.com";
const topicHash = createHash("sha256").update(`${baseUrl}/prod`).digest("hex");
const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const fcmKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const publishHeaders = { Authorization: "Bearer tk_test", Priority: "5" };

class FakeClock implements Clock {
  constructor(public value = 1_000) {}
  now(): number { return this.value; }
}

class CountingIds implements IdGenerator {
  private messages = 0;
  private incidents = 0;
  private timers = 0;
  message(): string { this.messages += 1; return `m_${this.messages}`; }
  incident(): string { this.incidents += 1; return `inc_${this.incidents}`; }
  timer(): string { this.timers += 1; return `tm_${this.timers}`; }
}

type FcmMessage = { android: { priority: string }; data: Record<string, string> };

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

function setup(critical: boolean, relayTier: "free" | "relay" | "hosted" = "hosted") {
  // The relay: one account with an iPhone and an Android phone, both subscribed
  // to the self-hosted server's topic by its hash.
  const relayDb = openDatabase(":memory:");
  migrate(relayDb);
  relayDb.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc_phone',?,1)").run(relayTier);
  relayDb.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_ios','acc_phone','h1','ios','ios-token',1)").run();
  relayDb.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_and','acc_phone','h2','android','android-token',1)").run();
  for (const id of ["dev_ios", "dev_and"]) relayDb.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?,?)").run(id, topicHash);
  relayDb.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at) VALUES ('rly_1',?,'1',?,1)").run(baseUrl, relayKeyHash("rk_test"));

  const apnsBodies: Record<string, unknown>[] = [];
  const transport: ApnsTransport = { send: async (_path, _headers, body) => { apnsBodies.push(JSON.parse(body) as Record<string, unknown>); return { status: 200, headers: {}, body: "" }; }, close: () => {} };
  const apns = new ApnsSender({ teamId: "t", keyId: "k", privateKey: apnsKey, bundleId: "app.critalarm", environment: "production", clock: { now: () => 1_000 }, transport: () => transport });
  const fcmMessages: FcmMessage[] = [];
  const fcm = new FcmSender({
    projectId: "p", clientEmail: "p@p.iam.gserviceaccount.com", privateKey: fcmKey, tokenUrl: "https://oauth.example.test/token", clock: { now: () => 1_000 },
    fetch: async (request) => {
      if (request.url === "https://oauth.example.test/token") return Response.json({ access_token: "a", expires_in: 3_600 });
      fcmMessages.push(((await request.json()) as { message: FcmMessage }).message);
      return new Response(null, { status: 200 });
    },
  });
  const dispatcher = new PushDispatcher(relayDb, { apns, fcm });
  const dispatched: DeliveryEvent[] = [];
  const relay = createRelayRouter(relayDb, async (event) => { dispatched.push(event); return dispatcher.dispatch([event]); }, new Counters(relayDb, { now: () => 1 }));

  // The self-hosted server: one topic, and the dispatch src/main.ts builds for
  // MODE=selfhosted, which is the relay client and nothing else.
  const serverDb = openDatabase(":memory:");
  migrate(serverDb);
  serverDb.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  serverDb.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', ?, ?, ?, 10, 60, 30, 'none', 1)").run(baseUrl, topicHash, critical ? 1 : 0);
  serverDb.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
  serverDb.prepare("INSERT INTO relay_client_credentials (relay_url, relay_key, created_at) VALUES ('https://relay.test','rk_test',1)").run();
  const received: Record<string, unknown>[] = [];
  const statuses: number[] = [];
  const client = new RelayClient({
    db: serverDb, relayUrl: "https://relay.test", baseUrl, relayContent: "none",
    fetch: async (request) => {
      received.push((await request.clone().json()) as Record<string, unknown>);
      const response = await relay.request(request);
      statuses.push(response.status);
      return response;
    },
  });
  const clock = new FakeClock();
  const ids = new CountingIds();
  const incidents = new IncidentService(serverDb, clock, ids);
  const server = createIngressRouter({ db: serverDb, clock, ids, incidents, mode: "selfhosted", dispatch: async (events) => { await client.forward(events); } });
  const publish = (body: string) => server.request("/prod", { method: "POST", headers: publishHeaders, body });
  const close = () => { serverDb.close(); relayDb.close(); };
  return { publish, received, statuses, dispatched, apnsBodies, fcmMessages, incidents, clock, serverDb, relayDb, close };
}

describe("self-hosted priority 5 through the relay", () => {
  it("forwards priority 5 on a topic with Critical off as one push that does not ring", async () => {
    const t = setup(false);
    try {
      const response = await t.publish("disk is filling");

      // api.md §1.7: stored, forwarded, no incident.
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("incident_id");
      expect(t.serverDb.prepare("SELECT priority, incident_id FROM messages").all()).toEqual([{ priority: 5, incident_id: null }]);
      expect(t.serverDb.prepare("SELECT COUNT(*) AS n FROM incidents").get()).toEqual({ n: 0 });

      // api.md §4.1: one push, kind p5, no incident and no ring window.
      expect(t.received).toEqual([{ topic_hash: topicHash, incident_id: null, message_id: "m_1", priority: 5, kind: "p5", ring_until: null }]);
      expect(t.statuses).toEqual([202]);

      // The relay dispatches it once, and not as an alarm.
      expect(t.dispatched).toHaveLength(1);
      expect(t.dispatched[0]).toMatchObject({ kind: "p5", incidentId: null, ringUntil: null, priority: 5, critical: false });

      // api.md §5.1: Time-Sensitive on iOS, with no alarm sound and no wake.
      expect(t.apnsBodies).toHaveLength(1);
      const aps = t.apnsBodies[0].aps as Record<string, unknown>;
      expect(aps).toMatchObject({ "interruption-level": "time-sensitive" });
      expect(aps).not.toHaveProperty("sound");
      expect(aps).not.toHaveProperty("content-available");
      expect(t.apnsBodies[0]).not.toHaveProperty("incident_id");

      // api.md §5.2: high priority on Android, with no incident to ring for.
      expect(t.fcmMessages).toHaveLength(1);
      expect(t.fcmMessages[0].android.priority).toBe("high");
      expect(t.fcmMessages[0].data).toEqual({ server: "", kind: "p5", priority: "5" });
    } finally { t.close(); }
  });

  it("still opens an incident and rings when the topic has Critical on", async () => {
    const t = setup(true);
    try {
      const response = await t.publish("db01 is down");

      expect(await response.json()).toMatchObject({ incident_id: "inc_1" });
      expect(t.received).toEqual([{ topic_hash: topicHash, incident_id: "inc_1", message_id: "m_1", priority: 5, kind: "open", ring_until: 1_060 }]);
      expect(t.statuses).toEqual([202]);
      expect(t.dispatched).toHaveLength(1);
      expect(t.dispatched[0]).toMatchObject({ kind: "open", incidentId: "inc_1", ringUntil: 1_060, critical: true });
      expect(t.apnsBodies[0].aps).toMatchObject({ sound: "alarm.caf", "content-available": 1, "interruption-level": "time-sensitive" });
      expect(t.fcmMessages[0].data).toEqual({ incident_id: "inc_1", server: "", kind: "open", priority: "5", ring_until: "1060" });
    } finally { t.close(); }
  });

  // The choice for the second use of kind p5. api.md §5.1 puts ring_until on "a
  // p5 that joins an open incident" and attaches the sound and the wake to a
  // priority-5 message "opening or joining an incident" on a critical topic. So
  // the join is forwarded with its incident and ring window, and the relay
  // dispatches it as critical. The phone is already ringing for this incident,
  // and the push tells it about the new message.
  it("forwards a priority 5 that joins an open incident, with the incident and its ring window", async () => {
    const t = setup(true);
    try {
      await t.publish("db01 is down");
      t.clock.value = 1_005;
      const response = await t.publish("cache01 is down");

      expect(await response.json()).toMatchObject({ id: "m_2", incident_id: "inc_1" });
      expect(t.received.map((push) => push.kind)).toEqual(["open", "p5"]);
      expect(t.received[1]).toEqual({ topic_hash: topicHash, incident_id: "inc_1", message_id: "m_2", priority: 5, kind: "p5", ring_until: 1_060 });
      expect(t.dispatched[1]).toMatchObject({ kind: "p5", incidentId: "inc_1", ringUntil: 1_060, critical: true });
      expect(t.apnsBodies[1]).toMatchObject({ incident_id: "inc_1", kind: "p5", ring_until: 1_060 });
      expect(t.apnsBodies[1].aps).toMatchObject({ sound: "alarm.caf", "content-available": 1 });
      expect(t.fcmMessages[1].data).toEqual({ incident_id: "inc_1", server: "", kind: "p5", priority: "5", ring_until: "1060" });
    } finally { t.close(); }
  });

  // The other half of that choice. The server marks a join to an acknowledged
  // incident as not critical, and api.md §4.1 has no field that says so. Sent as
  // it is, the relay would read it as a join to an open incident and ring a
  // phone whose owner already answered. So it is stored and not forwarded.
  it("does not forward a priority 5 that joins an acknowledged incident", async () => {
    const t = setup(true);
    try {
      await t.publish("db01 is down");
      t.clock.value = 1_010;
      t.incidents.acknowledge("acc_1", "inc_1");
      t.clock.value = 1_011;
      const response = await t.publish("cache01 is down");

      expect(await response.json()).toMatchObject({ id: "m_2", incident_id: "inc_1" });
      expect(t.serverDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE incident_id = 'inc_1'").get()).toEqual({ n: 2 });
      expect(t.received.map((push) => push.kind)).toEqual(["open"]);
      expect(t.dispatched).toHaveLength(1);
    } finally { t.close(); }
  });

  // api.md §4.2 names the cap p4_daily and never says a priority-5 message
  // counts against it. So a p5 on a topic with Critical off is not counted and
  // is not refused when the account has used its priority-4 quota.
  it("does not count a priority 5 on a topic with Critical off against p4_daily", async () => {
    const t = setup(false, "free");
    try {
      const day = Math.floor(Date.now() / 1000 / 86400) * 86400;
      t.relayDb.prepare("INSERT INTO relay_p4_usage(account_id,day_start,count) VALUES ('acc_phone',?,50)").run(day);

      await t.publish("disk is filling");

      expect(t.statuses).toEqual([202]);
      expect(t.dispatched).toHaveLength(1);
      expect(t.dispatched[0]).toMatchObject({ kind: "p5", critical: false });
      expect(t.relayDb.prepare("SELECT count FROM relay_p4_usage").all()).toEqual([{ count: 50 }]);
    } finally { t.close(); }
  });
});
