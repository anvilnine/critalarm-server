import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayRouter } from "../router.js";
import { RelayClient, relayKeyHash } from "../client.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { DeliveryEvent } from "../../incident/types.js";
import { ApnsSender } from "../../push/apns.js";
import type { ApnsTransport } from "../../push/apns.js";
import { FcmSender } from "../../push/fcm.js";
import { PushDispatcher } from "../../push/dispatcher.js";

// api.md §4.1 and §5. The relay takes a push of kind p5 and builds the push the
// contract describes for it, on both platforms.

const remoteHash = "a".repeat(64);
const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const fcmKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

function seed() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc_1','hosted',1)").run();
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_ios','acc_1','h1','ios','ios-token',1)").run();
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_and','acc_1','h2','android','android-token',1)").run();
  for (const id of ["dev_ios", "dev_and"]) db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?,?)").run(id, remoteHash);
  db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at) VALUES ('rly_1','https://alerts.example.com','1',?,1)").run(relayKeyHash("rk_test"));
  return db;
}

function pushBody(overrides: Record<string, unknown>) {
  return JSON.stringify({ topic_hash: remoteHash, incident_id: "inc_remote", message_id: "m_remote", priority: 5, kind: "p5", ring_until: 1_060, ...overrides });
}

function send(app: ReturnType<typeof createRelayRouter>, body: string) {
  return app.request("/relay/v1/push", { method: "POST", headers: { Authorization: "Bearer rk_test", "content-type": "application/json" }, body });
}

describe("relay push kind p5", () => {
  it("accepts p5 and dispatches it with the incident and ring window", async () => {
    const db = seed();
    try {
      const events: DeliveryEvent[] = [];
      const app = createRelayRouter(db, async (event) => { events.push(event); }, new Counters(db, { now: () => 1 }));

      expect((await send(app, pushBody({}))).status).toBe(202);

      expect(events.map((event) => ({ kind: event.kind, incidentId: event.incidentId, ringUntil: event.ringUntil, critical: event.critical }))).toEqual([
        { kind: "p5", incidentId: "inc_remote", ringUntil: 1_060, critical: true },
      ]);
    } finally { db.close(); }
  });

  it("accepts p5 for a topic with the switch off and keeps it quiet", async () => {
    const db = seed();
    try {
      const events: DeliveryEvent[] = [];
      const app = createRelayRouter(db, async (event) => { events.push(event); }, new Counters(db, { now: () => 1 }));

      expect((await send(app, pushBody({ incident_id: null, ring_until: null }))).status).toBe(202);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "p5", incidentId: null, ringUntil: null, critical: false });
    } finally { db.close(); }
  });

  it("still answers 400 to an unknown kind", async () => {
    const db = seed();
    try {
      const app = createRelayRouter(db, async () => {}, new Counters(db, { now: () => 1 }));
      expect((await send(app, pushBody({ kind: "p6" }))).status).toBe(400);
    } finally { db.close(); }
  });

  it("does not count p5 as an alarm", async () => {
    const db = seed();
    try {
      const app = createRelayRouter(db, async () => {}, new Counters(db, { now: () => 1 }));
      expect((await send(app, pushBody({}))).status).toBe(202);
      expect(db.prepare("SELECT COUNT(*) AS n FROM counters WHERE metric IN ('alarms_rung','incidents_opened')").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("builds the APNs and FCM pushes the contract describes", async () => {
    const db = seed();
    try {
      const apnsBodies: Record<string, unknown>[] = [];
      const transport: ApnsTransport = { send: async (_path, _headers, body) => { apnsBodies.push(JSON.parse(body) as Record<string, unknown>); return { status: 200, headers: {}, body: "" }; }, close: () => {} };
      const apns = new ApnsSender({ teamId: "t", keyId: "k", privateKey: apnsKey, bundleId: "app.critalarm", environment: "production", clock: { now: () => 1_000 }, transport: () => transport });
      const fcmData: Record<string, string>[] = [];
      const fcm = new FcmSender({
        projectId: "p", clientEmail: "p@p.iam.gserviceaccount.com", privateKey: fcmKey, tokenUrl: "https://oauth.example.test/token", clock: { now: () => 1_000 },
        fetch: async (request) => {
          if (request.url === "https://oauth.example.test/token") return Response.json({ access_token: "a", expires_in: 3_600 });
          fcmData.push(((await request.json()) as { message: { data: Record<string, string> } }).message.data);
          return new Response(null, { status: 200 });
        },
      });
      const dispatcher = new PushDispatcher(db, { apns, fcm });
      const app = createRelayRouter(db, async (event) => dispatcher.dispatch([event]), new Counters(db, { now: () => 1 }));

      await send(app, pushBody({}));
      await send(app, pushBody({ incident_id: null, ring_until: null }));

      const aps = apnsBodies.map((body) => body.aps as Record<string, unknown>);
      // Joined an open incident: the alarm sound and the wake, and the window.
      expect(apnsBodies[0]).toMatchObject({ incident_id: "inc_remote", kind: "p5", ring_until: 1_060 });
      expect(aps[0]).toMatchObject({ sound: "alarm.caf", "content-available": 1, "interruption-level": "time-sensitive" });
      // Switch off: no incident, no window, no sound, no wake.
      expect(apnsBodies[1]).not.toHaveProperty("incident_id");
      expect(apnsBodies[1]).not.toHaveProperty("ring_until");
      expect(apnsBodies[1]).toMatchObject({ kind: "p5" });
      expect(aps[1]).not.toHaveProperty("sound");
      expect(aps[1]).not.toHaveProperty("content-available");

      expect(fcmData[0]).toEqual({ incident_id: "inc_remote", server: "", kind: "p5", priority: "5", ring_until: "1060" });
      expect(fcmData[1]).toEqual({ server: "", kind: "p5", priority: "5" });
    } finally { db.close(); }
  });

  it("takes a p5 forwarded by a self-hosted server's relay client", async () => {
    const db = seed();
    const clientDb = openDatabase(":memory:");
    migrate(clientDb);
    try {
      const events: DeliveryEvent[] = [];
      const app = createRelayRouter(db, async (event) => { events.push(event); }, new Counters(db, { now: () => 1 }));
      clientDb.prepare("INSERT INTO relay_client_credentials (relay_url, relay_key, created_at) VALUES ('https://relay.test','rk_test',1)").run();
      const client = new RelayClient({ db: clientDb, relayUrl: "https://relay.test", baseUrl: "https://alerts.example.com", relayContent: "none", fetch: async (request) => app.request(request) });

      await client.forward([{ kind: "p5", topicHash: remoteHash, topic: "prod", incidentId: "inc_remote", messageId: "m_remote", priority: 5, maxRingS: 60, ringUntil: 1_060, server: "https://alerts.example.com", title: "T", body: "B", critical: true }]);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "p5", incidentId: "inc_remote", ringUntil: 1_060 });
    } finally { db.close(); clientDb.close(); }
  });
});
