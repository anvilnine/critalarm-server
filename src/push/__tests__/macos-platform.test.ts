import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryEvent } from "../../domain-events.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { ApnsSender, type ApnsTransport, type ApnsTransportResponse } from "../apns.js";
import { PushDispatcher } from "../dispatcher.js";
import { FcmSender } from "../fcm.js";
import type { LiveActivityPush, LiveActivitySender, PushDevice, PushResult, PushSender } from "../types.js";

// api.md §5.1, contract 1.25.0. A Mac rings with the iOS alert, hears the
// state kinds as a background push, and is never sent a Live Activity push.
// iOS and Android do not change at all. One test per rule of the task, named
// for the rule, and one block that pins the iOS and Android wire byte for byte.

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

function event(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    kind: "open",
    topicHash: "hash_prod",
    topic: "prod",
    incidentId: "inc_1",
    messageId: "m_1",
    priority: 5,
    maxRingS: 60,
    ringUntil: 1_060,
    server: "https://alerts.example.com",
    title: "Database",
    body: "db01 is down",
    critical: true,
    ...overrides,
  };
}

const iphone: PushDevice = { id: "dev_ios", accountId: "acc_1", platform: "ios", pushToken: "aaaa0001" };
const mac: PushDevice = { id: "dev_mac", accountId: "acc_1", platform: "macos", pushToken: "aaaa0001" };

type Sent = { path: string; headers: Record<string, string>; body: string };

class FakeTransport implements ApnsTransport {
  readonly sent: Sent[] = [];
  constructor(private readonly reply: (sent: Sent) => ApnsTransportResponse = () => ({ status: 200, headers: {}, body: "" })) {}
  async send(path: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse> {
    const sent = { path, headers, body };
    this.sent.push(sent);
    return this.reply(sent);
  }
  close(): void {}
}

function apnsSender(transport: FakeTransport | ((authority: string) => FakeTransport), now = 1_000) {
  return new ApnsSender({
    teamId: "team_1",
    keyId: "key_1",
    privateKey,
    bundleId: "app.critalarm",
    environment: "production",
    clock: { now: () => now },
    transport: typeof transport === "function" ? transport : () => transport,
  });
}

// The headers in the order they are sent, with the provider token's value
// replaced: it is a signature, so it is checked for shape and then left out.
function wire(sent: Sent): { path: string; headers: [string, string][]; body: string } {
  expect(sent.headers.authorization).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/);
  return { path: sent.path, headers: Object.entries(sent.headers).map(([name, value]) => [name, name === "authorization" ? "bearer <jwt>" : value]), body: sent.body };
}

const alertHeaders = (collapseId: string, expiration: string): [string, string][] => [
  ["authorization", "bearer <jwt>"],
  ["apns-topic", "app.critalarm"],
  ["apns-push-type", "alert"],
  ["apns-priority", "10"],
  ["apns-collapse-id", collapseId],
  ["apns-expiration", expiration],
  ["content-type", "application/json"],
];

// The iOS wire as it was before 1.25.0, written out by hand. A Mac must get
// exactly these bytes, and an iPhone must keep getting them.
const iosGolden: { name: string; event: DeliveryEvent; wire: { path: string; headers: [string, string][]; body: string } }[] = [
  {
    name: "open on a critical topic",
    event: event(),
    wire: {
      path: "/3/device/aaaa0001",
      headers: alertHeaders("inc_1", "1060"),
      body: '{"aps":{"alert":{"title":"Crit Alarm","body":"Critical alert on prod — open to see details"},"interruption-level":"time-sensitive","mutable-content":1,"category":"INCIDENT","sound":"alarm.caf","content-available":1},"incident_id":"inc_1","server":"https://alerts.example.com","kind":"open","ring_until":1060}',
    },
  },
  {
    name: "repeat with relay_content full",
    event: event({ kind: "repeat", relayContent: "full" }),
    wire: {
      path: "/3/device/aaaa0001",
      headers: alertHeaders("inc_1", "1060"),
      body: '{"aps":{"alert":{"title":"Database","body":"db01 is down"},"interruption-level":"time-sensitive","category":"INCIDENT","sound":"alarm.caf","content-available":1},"incident_id":"inc_1","server":"https://alerts.example.com","kind":"repeat","ring_until":1060}',
    },
  },
  {
    name: "reopen",
    event: event({ kind: "reopen", ringUntil: 1_200 }),
    wire: {
      path: "/3/device/aaaa0001",
      headers: alertHeaders("inc_1", "1060"),
      body: '{"aps":{"alert":{"title":"Crit Alarm","body":"Critical alert on prod — open to see details"},"interruption-level":"time-sensitive","mutable-content":1,"category":"INCIDENT","sound":"alarm.caf","content-available":1},"incident_id":"inc_1","server":"https://alerts.example.com","kind":"reopen","ring_until":1200}',
    },
  },
  {
    name: "p4 with no incident",
    event: event({ kind: "p4", priority: 4, incidentId: null, messageId: "m_4", critical: false, ringUntil: null, maxRingS: 300 }),
    wire: {
      path: "/3/device/aaaa0001",
      headers: alertHeaders("m_4", "1300"),
      body: '{"aps":{"alert":{"title":"Crit Alarm","body":"Critical alert on prod — open to see details"},"interruption-level":"time-sensitive","mutable-content":1,"category":"INCIDENT"},"server":"https://alerts.example.com","kind":"p4"}',
    },
  },
  {
    name: "p5 on a topic whose switch is off",
    event: event({ kind: "p5", incidentId: null, messageId: "m_5", critical: false, ringUntil: null }),
    wire: {
      path: "/3/device/aaaa0001",
      headers: alertHeaders("m_5", "1060"),
      body: '{"aps":{"alert":{"title":"Crit Alarm","body":"Critical alert on prod — open to see details"},"interruption-level":"time-sensitive","mutable-content":1,"category":"INCIDENT"},"server":"https://alerts.example.com","kind":"p5"}',
    },
  },
];

class RecordingSender implements PushSender {
  readonly deliveries: { device: PushDevice; event: DeliveryEvent }[] = [];
  constructor(private readonly result: PushResult = { status: 200, stale: false }) {}
  async send(device: PushDevice, delivery: DeliveryEvent): Promise<PushResult> {
    this.deliveries.push({ device, event: delivery });
    return this.result;
  }
}

class RecordingLiveActivity implements LiveActivitySender {
  readonly pushes: LiveActivityPush[] = [];
  async sendLiveActivity(push: LiveActivityPush): Promise<PushResult> {
    this.pushes.push(push);
    return { status: 200, stale: false };
  }
}

// One account with an iPhone, an Android phone and a Mac, all subscribed to
// prod, and an open incident. The Mac's alarm token is in the token list and
// its legacy column holds an older one, so a lookup by the wrong kind shows.
// The Mac also holds Live Activity rows it should never have been able to
// store, to show they are never used.
function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'hosted', 1)").run();
  db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','acc_1','prod','https://alerts.example.com','hash_prod',1,30,60,30,'none',1)").run();
  db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,last_message_at,updated_at,max_ring_s) VALUES ('inc_1','top_1','open',900,900,900,60)").run();
  db.prepare("INSERT INTO messages (id,topic_id,incident_id,title,body,priority,tags,markdown,created_at) VALUES ('m_1','top_1','inc_1','Database','db01 is down',5,'[]',0,1)").run();
  const device = db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_1', ?, ?, ?, 1)");
  device.run("dev_ios", "hash_ios", "ios", "ios-token");
  device.run("dev_android", "hash_android", "android", "android-token");
  device.run("dev_mac", "hash_mac", "macos", "mac-legacy");
  for (const id of ["dev_ios", "dev_android", "dev_mac"]) db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?, 'hash_prod')").run(id);
  const token = db.prepare("INSERT INTO device_tokens (device_id,kind,activity_id,incident_id,token,updated_at) VALUES (?,?,?,?,?,1)");
  token.run("dev_mac", "apns", "", null, "mac-token");
  token.run("dev_ios", "la_start", "", null, "start-ios");
  token.run("dev_ios", "la_update", "act_1", "inc_1", "update-ios");
  token.run("dev_mac", "la_start", "", null, "start-mac");
  token.run("dev_mac", "la_update", "act_m", "inc_1", "update-mac");
  return db;
}

function dispatcher(db: ReturnType<typeof setup>, apnsResult?: PushResult) {
  const apns = new RecordingSender(apnsResult);
  const fcm = new RecordingSender();
  const liveActivity = new RecordingLiveActivity();
  return { apns, fcm, liveActivity, dispatcher: new PushDispatcher(db, { apns, fcm, liveActivity }, { now: () => 2_000 }) };
}

const devicesOf = (sender: RecordingSender) => sender.deliveries.map((delivery) => [delivery.device.id, delivery.event.kind]);

describe("rule 5: a Mac's alarm pushes are the iOS alert, through the APNs sender", () => {
  it("the APNs sender sends a macos device exactly the iOS headers and payload for every ringing kind", async () => {
    for (const golden of iosGolden) {
      const transport = new FakeTransport();
      const sender = apnsSender(transport);
      await sender.send(iphone, golden.event);
      await sender.send(mac, golden.event);
      expect(transport.sent).toHaveLength(2);
      expect(transport.sent[1]).toEqual(transport.sent[0]);
      expect(wire(transport.sent[1]!)).toEqual(golden.wire);
    }
  });

  it("the dispatcher hands a Mac's alarm to the APNs sender with its apns token, and nothing to FCM", async () => {
    const db = setup();
    const { apns, fcm, dispatcher: push } = dispatcher(db);
    const open = event();

    await push.dispatch([open]);

    expect(apns.deliveries).toEqual([
      { device: { id: "dev_ios", accountId: "acc_1", platform: "ios", pushToken: "ios-token" }, event: open },
      { device: { id: "dev_mac", accountId: "acc_1", platform: "macos", pushToken: "mac-token" }, event: open },
    ]);
    expect(devicesOf(fcm)).toEqual([["dev_android", "open"]]);
  });

  it("remembers the Apple host that rang a Mac and hands it to the next push, as for an iPhone", async () => {
    const db = setup();
    const environment = () => db.prepare("SELECT id, apns_environment FROM devices ORDER BY id").all();
    const { dispatcher: first } = dispatcher(db, { status: 200, stale: false, apnsEnvironment: "sandbox" });

    await first.dispatch([event()]);

    expect(environment()).toEqual([
      { id: "dev_android", apns_environment: null },
      { id: "dev_ios", apns_environment: "sandbox" },
      { id: "dev_mac", apns_environment: "sandbox" },
    ]);
    const second = dispatcher(db, { status: 200, stale: false, apnsEnvironment: "sandbox" });
    await second.dispatcher.dispatch([event({ kind: "repeat" })]);
    expect(second.apns.deliveries.find((delivery) => delivery.device.id === "dev_mac")?.device.apnsEnvironment).toBe("sandbox");
  });

  it("drops a Mac's token when APNs says it is gone, as for an iPhone", async () => {
    const db = setup();
    const { dispatcher: push } = dispatcher(db, { status: 410, stale: true });

    await push.dispatch([event()]);

    expect(db.prepare("SELECT id, push_token FROM devices ORDER BY id").all()).toEqual([
      { id: "dev_android", push_token: "android-token" },
      { id: "dev_ios", push_token: "" },
      { id: "dev_mac", push_token: "mac-legacy" },
    ]);
    expect(db.prepare("SELECT device_id, kind, token FROM device_tokens WHERE kind IN ('apns', 'fcm') ORDER BY device_id").all()).toEqual([]);
  });

  it("never sends a Live Activity push for a macos device, even when a row exists, on open, ack, reopen, close or expire", async () => {
    for (const kind of ["open", "ack", "reopen", "close", "expire"] as const) {
      const db = setup();
      const { liveActivity, dispatcher: push } = dispatcher(db);
      await push.dispatch([event({ kind })]);
      expect(liveActivity.pushes.map((sent) => sent.token)).toEqual([kind === "open" ? "start-ios" : "update-ios"]);
    }
  });
});

describe("rule 6: the state kinds reach a Mac as an APNs background push", () => {
  for (const kind of ["ack", "close", "expire"] as const) {
    it(`the dispatcher sends ${kind} to the Mac and the Android phone, and no state push to the iPhone`, async () => {
      const db = setup();
      const { apns, fcm, dispatcher: push } = dispatcher(db);

      await push.dispatch([event({ kind, ringUntil: null })]);

      expect(devicesOf(apns)).toEqual([["dev_mac", kind]]);
      expect(devicesOf(fcm)).toEqual([["dev_android", kind]]);
    });

    it(`the APNs sender builds the §5.1 background push for ${kind} on a Mac, and nothing else`, async () => {
      const transport = new FakeTransport();
      // relay_content full, a ring_until and a title are all on the event, and
      // none of them may reach the push.
      await apnsSender(transport, 5_000).send(mac, event({ kind, relayContent: "full", ringUntil: 1_060, incidentId: "inc_9a8b7c" }));

      expect(transport.sent).toHaveLength(1);
      expect(wire(transport.sent[0]!)).toEqual({
        path: "/3/device/aaaa0001",
        headers: [
          ["authorization", "bearer <jwt>"],
          ["apns-topic", "app.critalarm"],
          ["apns-push-type", "background"],
          ["apns-priority", "5"],
          ["apns-collapse-id", "inc_9a8b7c"],
          ["apns-expiration", "5060"],
          ["content-type", "application/json"],
        ],
        body: `{"aps":{"content-available":1},"incident_id":"inc_9a8b7c","server":"https://alerts.example.com","kind":"${kind}"}`,
      });
    });
  }

  it("a background push to a Mac finds the other Apple host the way an alert does", async () => {
    const hosts: string[] = [];
    const transports = new Map<string, FakeTransport>();
    const sender = apnsSender((authority) => {
      const created = new FakeTransport(() => {
        hosts.push(authority);
        return authority.includes("sandbox") ? { status: 200, headers: {}, body: "" } : { status: 400, headers: {}, body: '{"reason":"BadDeviceToken"}' };
      });
      transports.set(authority, created);
      return created;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await sender.send(mac, event({ kind: "ack", ringUntil: null }));
      expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "sandbox" });
      expect(hosts).toEqual(["https://api.push.apple.com", "https://api.sandbox.push.apple.com"]);
    } finally { warn.mockRestore(); }
  });
});

describe("rule 9: what a Mac adds to pushes_delivered", () => {
  it("counts a Mac's accepted alarm and state pushes like any APNs 2xx", async () => {
    const db = setup();
    expect(await dispatcher(db).dispatcher.dispatch([event()])).toEqual({ delivered: 3 });
    expect(await dispatcher(db).dispatcher.dispatch([event({ kind: "ack", ringUntil: null })])).toEqual({ delivered: 2 });
  });

  it("counts nothing for a Mac push APNs refused", async () => {
    const db = setup();
    // The APNs sender answers 410 for both the iPhone and the Mac. Only the
    // Android push is delivered.
    expect(await dispatcher(db, { status: 410, stale: true }).dispatcher.dispatch([event()])).toEqual({ delivered: 1 });
    const again = setup();
    expect(await dispatcher(again, { status: 500, stale: false }).dispatcher.dispatch([event({ kind: "close", ringUntil: null })])).toEqual({ delivered: 1 });
  });
});

describe("iOS and Android unchanged", () => {
  it("an iPhone gets the iOS headers and payload byte for byte", async () => {
    for (const golden of iosGolden) {
      const transport = new FakeTransport();
      await apnsSender(transport).send(iphone, golden.event);
      expect(transport.sent.map(wire)).toEqual([golden.wire]);
    }
  });

  it("an iPhone hears state only through its Live Activity, with the same push as before", async () => {
    const db = setup();
    db.prepare("DELETE FROM devices WHERE id = 'dev_mac'").run();
    for (const [kind, action, state] of [["ack", "update", "open"], ["close", "end", "open"], ["expire", "end", "open"]] as const) {
      const { apns, fcm, liveActivity, dispatcher: push } = dispatcher(db);
      await push.dispatch([event({ kind, ringUntil: null })]);
      expect(apns.deliveries).toEqual([]);
      expect(devicesOf(fcm)).toEqual([["dev_android", kind]]);
      expect(liveActivity.pushes).toEqual([{ token: "update-ios", event: action, incidentId: "inc_1", topic: "prod", server: "https://alerts.example.com", state, title: "Critical alert on prod", openedAt: 900 }]);
    }
    const { liveActivity, dispatcher: push } = dispatcher(db);
    await push.dispatch([event()]);
    expect(liveActivity.pushes).toEqual([{ token: "start-ios", event: "start", incidentId: "inc_1", topic: "prod", server: "https://alerts.example.com", state: "open", title: "Critical alert on prod", openedAt: 900 }]);
  });

  it("an Android phone gets the same FCM message as before, for an alarm and for a state kind", async () => {
    const bodies: string[] = [];
    const sender = new FcmSender({
      projectId: "crit-alarm-project",
      clientEmail: "push@crit-alarm-project.iam.gserviceaccount.com",
      privateKey: rsa.privateKey,
      tokenUrl: "https://oauth.example.test/token",
      clock: { now: () => 1_000 },
      fetch: async (request) => {
        if (request.url === "https://oauth.example.test/token") return Response.json({ access_token: "access_1", expires_in: 3_600 });
        bodies.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    const android: PushDevice = { id: "dev_android", accountId: "acc_1", platform: "android", pushToken: "android-token" };

    await sender.send(android, event());
    await sender.send(android, event({ kind: "ack", ringUntil: null }));

    expect(bodies).toEqual([
      '{"message":{"token":"android-token","android":{"priority":"high","collapse_key":"inc_1","ttl":"60s"},"data":{"incident_id":"inc_1","server":"https://alerts.example.com","kind":"open","priority":"5","ring_until":"1060"}}}',
      '{"message":{"token":"android-token","android":{"priority":"high","collapse_key":"inc_1","ttl":"60s"},"data":{"incident_id":"inc_1","server":"https://alerts.example.com","kind":"ack"}}}',
    ]);
  });
});
