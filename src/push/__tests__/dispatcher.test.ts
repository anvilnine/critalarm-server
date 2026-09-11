import { describe, expect, it } from "vitest";
import type { DeliveryEvent } from "../../domain-events.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { PushDispatcher } from "../dispatcher.js";
import type { PushDevice, PushResult, PushSender } from "../types.js";

function event(): DeliveryEvent {
  return {
    kind: "open",
    topicHash: "hash_prod",
    topic: "prod",
    incidentId: "inc_1",
    messageId: "m_1",
    priority: 5,
    maxRingS: 60,
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
  db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES ('acc_1', 'dev_ios', 'hash_prod')").run();
  db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES ('acc_1', 'dev_android', 'hash_prod')").run();
  db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES ('acc_1', 'dev_other', 'hash_other')").run();
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_cross','acc_2','hash_cross','ios','cross-token',1)").run();
  db.prepare("INSERT INTO subscriptions (account_id,device_id,topic_hash) VALUES ('acc_2','dev_cross','hash_prod')").run();
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
