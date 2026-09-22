import { describe, expect, it, vi } from "vitest";
import type { DeliveryEvent } from "../../domain-events.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { PushDispatcher } from "../dispatcher.js";
import type { LiveActivityPush, LiveActivitySender, PushDevice, PushResult, PushSender } from "../types.js";

function event(): DeliveryEvent {
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
  };
}

class RecordingSender implements PushSender {
  readonly deliveries: { device: PushDevice; event: DeliveryEvent }[] = [];

  constructor(private readonly result: PushResult) {}

  async send(device: PushDevice, delivery: DeliveryEvent): Promise<PushResult> {
    this.deliveries.push({ device, event: delivery });
    return this.result;
  }
}

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'hosted', 1)").run();
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'hosted', 1)").run();
  db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','acc_1','prod','https://alerts.example.com','hash_prod',1,30,60,30,'none',1)").run();
  db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_2','acc_2','prod','https://alerts.example.com','hash_prod',1,30,60,30,'none',1)").run();
  db.prepare("INSERT INTO messages (id,topic_id,incident_id,title,body,priority,tags,markdown,created_at) VALUES ('m_1','top_1',NULL,'Database','db01 is down',5,'[]',0,1)").run();
  db.prepare(
    "INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_ios', 'acc_1', 'hash_ios', 'ios', 'ios-token', 1)",
  ).run();
  db.prepare(
    "INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_android', 'acc_1', 'hash_android', 'android', 'android-token', 1)",
  ).run();
  db.prepare(
    "INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_other', 'acc_1', 'hash_other', 'ios', 'other-token', 1)",
  ).run();
  db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_ios', 'hash_prod')").run();
  db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_android', 'hash_prod')").run();
  db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_other', 'hash_other')").run();
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_cross','acc_2','hash_cross','ios','cross-token',1)").run();
  db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_cross','hash_prod')").run();
  return db;
}

describe("PushDispatcher", () => {
  it("selects only subscriptions for the delivery topic and sends each platform its complete device and event", async () => {
    const db = setup();
    const apns = new RecordingSender({ status: 200, stale: false });
    const fcm = new RecordingSender({ status: 200, stale: false });
    const dispatcher = new PushDispatcher(db, { apns, fcm });
    const delivery = event();

    await dispatcher.dispatch([delivery]);

    expect(apns.deliveries).toEqual([
      {
        device: { id: "dev_ios", accountId: "acc_1", platform: "ios", pushToken: "ios-token" },
        event: delivery,
      },
    ]);
    expect(fcm.deliveries).toEqual([
      {
        device: { id: "dev_android", accountId: "acc_1", platform: "android", pushToken: "android-token" },
        event: delivery,
      },
    ]);
  });

  it("does not deliver a same-hash event to another hosted account", async () => {
    const db = setup(); const apns = new RecordingSender({ status: 200, stale: false }); const fcm = new RecordingSender({ status: 200, stale: false });
    await new PushDispatcher(db, { apns, fcm }).dispatch([event()]);
    expect(apns.deliveries.map((delivery) => delivery.device.id)).toEqual(["dev_ios"]);
  });

  // acc_1 and acc_2 both own a topic called prod, so both hold the same
  // topic_hash. A relayed push carries a message_id from the pushing server
  // (api.md §4.1), which has no row here, and that used to drop the account
  // filter and ring every account subscribed to the hash.
  it("rings only the account the relay named when the message is not stored here", async () => {
    const db = setup(); const apns = new RecordingSender({ status: 200, stale: false }); const fcm = new RecordingSender({ status: 200, stale: false });
    await new PushDispatcher(db, { apns, fcm }).dispatch([{ ...event(), messageId: "m_remote", accountId: "acc_1" }]);
    expect(apns.deliveries.map((delivery) => delivery.device.id)).toEqual(["dev_ios"]);
    expect(fcm.deliveries.map((delivery) => delivery.device.id)).toEqual(["dev_android"]);
  });

  it("rings only the other account when the relay names that one", async () => {
    const db = setup(); const apns = new RecordingSender({ status: 200, stale: false }); const fcm = new RecordingSender({ status: 200, stale: false });
    await new PushDispatcher(db, { apns, fcm }).dispatch([{ ...event(), messageId: "m_remote", accountId: "acc_2" }]);
    expect(apns.deliveries.map((delivery) => delivery.device.id)).toEqual(["dev_cross"]);
    expect(fcm.deliveries).toEqual([]);
  });

  it("sends nothing and logs when the owning account cannot be established", async () => {
    const db = setup(); const apns = new RecordingSender({ status: 200, stale: false }); const fcm = new RecordingSender({ status: 200, stale: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await new PushDispatcher(db, { apns, fcm }).dispatch([{ ...event(), messageId: "m_remote" }]);
      expect([result, apns.deliveries, fcm.deliveries]).toEqual([{ delivered: 0 }, [], []]);
      expect(log).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  it("clears only the stale APNs token while preserving Android and unrelated subscriptions", async () => {
    const db = setup();
    const apns = new RecordingSender({ status: 410, stale: true });
    const fcm = new RecordingSender({ status: 404, stale: true });
    const dispatcher = new PushDispatcher(db, { apns, fcm });

    await dispatcher.dispatch([event()]);

    expect(
      db.prepare("SELECT id, push_token FROM devices ORDER BY id").all(),
    ).toEqual([
      { id: "dev_android", push_token: "android-token" },
      { id: "dev_cross", push_token: "cross-token" },
      { id: "dev_ios", push_token: "" },
      { id: "dev_other", push_token: "other-token" },
    ]);
    expect(
      db.prepare("SELECT device_id, topic_hash FROM subscriptions ORDER BY device_id").all(),
    ).toEqual([
      { device_id: "dev_android", topic_hash: "hash_prod" },
      { device_id: "dev_cross", topic_hash: "hash_prod" },
      { device_id: "dev_ios", topic_hash: "hash_prod" },
      { device_id: "dev_other", topic_hash: "hash_other" },
    ]);
  });
});

class RecordingLiveActivity implements LiveActivitySender {
  readonly pushes: LiveActivityPush[] = [];

  constructor(private readonly result: PushResult = { status: 200, stale: false }) {}

  async sendLiveActivity(push: LiveActivityPush): Promise<PushResult> {
    this.pushes.push(push);
    return this.result;
  }
}

function liveActivitySetup() {
  const db = setup();
  db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,last_message_at,max_ring_s) VALUES ('inc_1','top_1','open',900,900,60)").run();
  db.prepare("UPDATE messages SET incident_id = 'inc_1' WHERE id = 'm_1'").run();
  db.prepare("INSERT INTO device_tokens (device_id,kind,activity_id,incident_id,token,updated_at) VALUES ('dev_ios','la_start','',NULL,'start-ios',1)").run();
  db.prepare("INSERT INTO device_tokens (device_id,kind,activity_id,incident_id,token,updated_at) VALUES ('dev_other','la_start','',NULL,'start-other',1)").run();
  db.prepare("INSERT INTO device_tokens (device_id,kind,activity_id,incident_id,token,updated_at) VALUES ('dev_ios','la_update','act_1','inc_1','update-ios',1)").run();
  return db;
}

function dispatcherFor(db: ReturnType<typeof liveActivitySetup>, liveActivity: RecordingLiveActivity) {
  const apns = new RecordingSender({ status: 200, stale: false });
  const fcm = new RecordingSender({ status: 200, stale: false });
  return { apns, fcm, dispatcher: new PushDispatcher(db, { apns, fcm, liveActivity }, { now: () => 2_000 }) };
}

describe("Live Activity selection", () => {
  it("rings the alarm and starts an activity on open, using only start tokens of subscribed devices", async () => {
    const db = liveActivitySetup();
    const liveActivity = new RecordingLiveActivity();
    const { apns, fcm, dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([event()]);

    expect(apns.deliveries.map((delivery) => delivery.device.id)).toEqual(["dev_ios"]);
    expect(fcm.deliveries.map((delivery) => delivery.device.id)).toEqual(["dev_android"]);
    expect(liveActivity.pushes).toEqual([
      {
        token: "start-ios",
        event: "start",
        incidentId: "inc_1",
        topic: "prod",
        server: "https://alerts.example.com",
        state: "open",
        title: "Critical alert on prod",
        openedAt: 900,
      },
    ]);
  });

  it("sends no Live Activity push on a repeat", async () => {
    const db = liveActivitySetup();
    const liveActivity = new RecordingLiveActivity();
    const { apns, dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([{ ...event(), kind: "repeat" }]);

    expect(apns.deliveries).toHaveLength(1);
    expect(liveActivity.pushes).toEqual([]);
  });

  // api.md §5.2. The ack reaches Android as a data-only push so a second phone
  // stops ringing. iOS hears the same thing as a Live Activity update.
  it("updates the activity and tells Android, without ringing iOS, on ack", async () => {
    const db = liveActivitySetup();
    db.prepare("UPDATE incidents SET state = 'acked', acked_at = 1000 WHERE id = 'inc_1'").run();
    const liveActivity = new RecordingLiveActivity();
    const { apns, fcm, dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([{ ...event(), kind: "ack" }]);

    expect(apns.deliveries).toEqual([]);
    expect(fcm.deliveries.map((delivery) => delivery.device.id)).toEqual(["dev_android"]);
    expect(liveActivity.pushes).toEqual([
      expect.objectContaining({ token: "update-ios", event: "update", state: "acked", openedAt: 900 }),
    ]);
  });

  it("rings the alarm and updates the activity on reopen", async () => {
    const db = liveActivitySetup();
    const liveActivity = new RecordingLiveActivity();
    const { apns, dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([{ ...event(), kind: "reopen" }]);

    expect(apns.deliveries).toHaveLength(1);
    expect(liveActivity.pushes).toEqual([
      expect.objectContaining({ token: "update-ios", event: "update", state: "open" }),
    ]);
  });

  it("ends the activity on close and on expire, without ringing iOS", async () => {
    const db = liveActivitySetup();
    db.prepare("UPDATE incidents SET state = 'closed', closed_at = 1000 WHERE id = 'inc_1'").run();
    const liveActivity = new RecordingLiveActivity();
    const { apns, dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([{ ...event(), kind: "close" }]);
    db.prepare("UPDATE incidents SET state = 'expired' WHERE id = 'inc_1'").run();
    await dispatcher.dispatch([{ ...event(), kind: "expire" }]);

    expect(apns.deliveries).toEqual([]);
    expect(liveActivity.pushes.map((push) => [push.event, push.state])).toEqual([
      ["end", "closed"],
      ["end", "expired"],
    ]);
  });

  it("carries the real title only when the topic relays full content", async () => {
    const db = liveActivitySetup();
    const liveActivity = new RecordingLiveActivity();
    const { dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([{ ...event(), relayContent: "full" }]);

    expect(liveActivity.pushes[0]?.title).toBe("Database");
  });

  it("prefers the alarm token from the token list over the legacy device column", async () => {
    const db = liveActivitySetup();
    db.prepare("INSERT INTO device_tokens (device_id,kind,activity_id,incident_id,token,updated_at) VALUES ('dev_ios','apns','',NULL,'apns-listed',1)").run();
    const liveActivity = new RecordingLiveActivity();
    const { apns, dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([event()]);

    expect(apns.deliveries.map((delivery) => delivery.device.pushToken)).toEqual(["apns-listed"]);
  });

  it("drops a Live Activity token APNs reports gone", async () => {
    const db = liveActivitySetup();
    const liveActivity = new RecordingLiveActivity({ status: 410, stale: true });
    const { dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([event()]);

    expect(db.prepare("SELECT token FROM device_tokens ORDER BY token").all()).toEqual([
      { token: "start-other" },
      { token: "update-ios" },
    ]);
  });

  it("falls back to the event kind and the clock when the incident is not stored locally", async () => {
    const db = liveActivitySetup();
    db.prepare("DELETE FROM incidents WHERE id = 'inc_1'").run();
    const liveActivity = new RecordingLiveActivity();
    const { dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([event()]);

    expect(liveActivity.pushes).toEqual([
      expect.objectContaining({ event: "start", state: "open", openedAt: 2_000 }),
    ]);
  });
});

// Both kinds of iOS build are on the founder's phone at once: a Debug build
// holds a sandbox token and the TestFlight build holds a production one. The
// sender works out which Apple host answered; these check the dispatcher hands
// it what it knows and writes back what it learned.
describe("per-device APNs environment", () => {
  function environmentOf(db: ReturnType<typeof setup>, deviceId: string) {
    return (db.prepare("SELECT apns_environment FROM devices WHERE id = ?").get(deviceId) as { apns_environment: string | null }).apns_environment;
  }

  it("starts every iOS device unknown, so a database from before this change guesses nothing", () => {
    const db = setup();
    expect(environmentOf(db, "dev_ios")).toBe(null);
  });

  it("remembers the host that rang an iOS device whose environment was unknown", async () => {
    const db = setup();
    const apns = new RecordingSender({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    const fcm = new RecordingSender({ status: 200, stale: false });

    await new PushDispatcher(db, { apns, fcm }).dispatch([event()]);

    expect(environmentOf(db, "dev_ios")).toBe("sandbox");
  });

  it("passes the remembered host to the sender, so the second push does not guess again", async () => {
    const db = setup();
    db.prepare("UPDATE devices SET apns_environment = 'sandbox' WHERE id = 'dev_ios'").run();
    const apns = new RecordingSender({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    const fcm = new RecordingSender({ status: 200, stale: false });

    await new PushDispatcher(db, { apns, fcm }).dispatch([event()]);

    expect(apns.deliveries[0]!.device.apnsEnvironment).toBe("sandbox");
  });

  it("corrects the remembered host when the device moves from a Debug build to a TestFlight build", async () => {
    const db = setup();
    db.prepare("UPDATE devices SET apns_environment = 'sandbox' WHERE id = 'dev_ios'").run();
    const apns = new RecordingSender({ status: 200, stale: false, apnsEnvironment: "production" });
    const fcm = new RecordingSender({ status: 200, stale: false });

    await new PushDispatcher(db, { apns, fcm }).dispatch([event()]);

    expect(environmentOf(db, "dev_ios")).toBe("production");
  });

  // A token both hosts refused is a bad token, not a bad guess. Writing down
  // whichever host happened to be tried last would send the next push there for
  // no reason.
  it("remembers nothing when the token was refused on the host that answered", async () => {
    const db = setup();
    const apns = new RecordingSender({ status: 400, stale: false, apnsEnvironment: "sandbox" });
    const fcm = new RecordingSender({ status: 200, stale: false });

    await new PushDispatcher(db, { apns, fcm }).dispatch([event()]);

    expect(environmentOf(db, "dev_ios")).toBe(null);
  });

  it("leaves an Android device alone, because FCM has no environments", async () => {
    const db = setup();
    const apns = new RecordingSender({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    const fcm = new RecordingSender({ status: 200, stale: false });

    await new PushDispatcher(db, { apns, fcm }).dispatch([event()]);

    expect(environmentOf(db, "dev_android")).toBe(null);
  });

  it("tells the Live Activity sender which host the device is on", async () => {
    const db = liveActivitySetup();
    db.prepare("UPDATE devices SET apns_environment = 'sandbox' WHERE id = 'dev_ios'").run();
    const liveActivity = new RecordingLiveActivity();
    const { dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([event()]);

    expect(liveActivity.pushes[0]!.apnsEnvironment).toBe("sandbox");
  });

  it("tells the Live Activity sender nothing when the host is still unknown", async () => {
    const db = liveActivitySetup();
    const liveActivity = new RecordingLiveActivity();
    const { dispatcher } = dispatcherFor(db, liveActivity);

    await dispatcher.dispatch([event()]);

    expect(liveActivity.pushes[0]!.apnsEnvironment).toBeUndefined();
  });

  // The alarm push runs before the Live Activity push in the same dispatch, so
  // what the alarm learned is already on the row the activity reads.
  it("uses the host the alarm push just learned for the activity that follows it", async () => {
    const db = liveActivitySetup();
    const liveActivity = new RecordingLiveActivity();
    const apns = new RecordingSender({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    const fcm = new RecordingSender({ status: 200, stale: false });

    await new PushDispatcher(db, { apns, fcm, liveActivity }, { now: () => 2_000 }).dispatch([event()]);

    expect(liveActivity.pushes[0]!.apnsEnvironment).toBe("sandbox");
  });
});

// api.md §5.2. ack, close and expire are the three state kinds. They go to
// Android devices only, as data, and they never reach the iOS alarm sender.
describe("state kinds to Android", () => {
  for (const kind of ["ack", "close", "expire"] as const) {
    it(`sends ${kind} to the Android device and to no iOS alarm`, async () => {
      const db = setup();
      const apns = new RecordingSender({ status: 200, stale: false });
      const fcm = new RecordingSender({ status: 200, stale: false });

      await new PushDispatcher(db, { apns, fcm }).dispatch([{ ...event(), kind }]);

      expect(apns.deliveries).toEqual([]);
      expect(fcm.deliveries.map((delivery) => [delivery.device.id, delivery.event.kind])).toEqual([["dev_android", kind]]);
    });
  }
});
