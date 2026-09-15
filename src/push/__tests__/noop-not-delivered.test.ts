import { describe, expect, it } from "vitest";
import type { DeliveryEvent } from "../../domain-events.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { PushDispatcher } from "../dispatcher.js";
import type { PushSender } from "../types.js";

// The noop sender used when a platform has no provider configured. It used to
// answer 204, which the dispatcher counts as a 2xx, so every push to a
// platform that could not be pushed to was booked as delivered. On the dev
// server, before FCM was configured, every Android push was counted and none
// were sent.
const noop: PushSender = { send: async () => ({ status: 501, stale: false }) };

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen, app_version) VALUES ('dev_1', 'acc_1', 'hash', 'android', 'push_token', 1, '1.0.0')").run();
  db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES ('acc_1', 'dev_1', 'hash_prod')").run();
  return db;
}

const event: DeliveryEvent = {
  kind: "open",
  topicHash: "hash_prod",
  topic: "prod",
  incidentId: "inc_1",
  messageId: "m_1",
  baseUrl: "https://alerts.example.com",
  priority: 5,
};

describe("a platform with no push provider", () => {
  it("does not count as delivered", async () => {
    const db = setup();
    const dispatcher = new PushDispatcher(db, { apns: noop, fcm: noop });

    const result = await dispatcher.dispatch([event]);

    expect(result.delivered).toBe(0);
  });

  it("a real 2xx from a real provider still counts", async () => {
    const db = setup();
    const sending: PushSender = { send: async () => ({ status: 200, stale: false }) };
    const dispatcher = new PushDispatcher(db, { apns: noop, fcm: sending });

    const result = await dispatcher.dispatch([event]);

    expect(result.delivered).toBe(1);
  });
});
