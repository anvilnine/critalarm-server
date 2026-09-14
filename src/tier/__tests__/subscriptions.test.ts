import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createTierRouter } from "../router.js";

const firstHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const secondHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'free', 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_one', 'acc_1', ?, 'ios', 'one', 1)").run(createHash("sha256").update("dv_one").digest("hex"));
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_two', 'acc_1', ?, 'android', 'two', 1)").run(createHash("sha256").update("dv_two").digest("hex"));
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_other', 'acc_2', ?, 'ios', 'other', 1)").run(createHash("sha256").update("dv_other").digest("hex"));
  return { app: createTierRouter({ db, clock: { now: () => 1_000 }, ids: { account: () => "acc_unused", deviceToken: () => "dv_unused" }, revenueCat: { sharedSecret: "secret", entitlements: {} } }), db };
}

function subscribe(app: ReturnType<typeof createTierRouter>, deviceId: string, token: string, topicHash: string) {
  return app.request(`/relay/v1/devices/${deviceId}/subscriptions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ topic_hash: topicHash }) });
}

describe("device subscriptions", () => {
  it("creates, idempotently repeats, and deletes a subscription", async () => {
    const { app, db } = setup();

    expect((await subscribe(app, "dev_one", "dv_one", firstHash)).status).toBe(204);
    expect((await subscribe(app, "dev_one", "dv_one", firstHash)).status).toBe(204);
    expect(db.prepare("SELECT account_id, device_id, topic_hash FROM subscriptions").all()).toEqual([{ account_id: "acc_1", device_id: "dev_one", topic_hash: firstHash }]);
    const deletion = await app.request(`/relay/v1/devices/dev_one/subscriptions/${firstHash}`, { method: "DELETE", headers: { Authorization: "Bearer dv_one" } });
    expect(deletion.status).toBe(204);
    expect(db.prepare("SELECT * FROM subscriptions").all()).toEqual([]);
  });

  it("counts distinct topic hashes across the account before applying the critical topic cap", async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES ('acc_1', 'dev_one', ?)").run(firstHash);

    expect((await subscribe(app, "dev_two", "dv_two", secondHash)).status).toBe(204);
    const response = await subscribe(app, "dev_two", "dv_two", "f".repeat(64));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "cap", cap: "critical_topics" });
    expect(db.prepare("SELECT topic_hash FROM subscriptions ORDER BY topic_hash").all()).toEqual([{ topic_hash: firstHash }, { topic_hash: secondHash }]);
  });

  it("allows a second device on the same account to subscribe to an existing topic hash", async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES ('acc_1', 'dev_one', ?)").run(firstHash);

    const response = await subscribe(app, "dev_two", "dv_two", firstHash);

    expect(response.status).toBe(204);
    expect(db.prepare("SELECT device_id, topic_hash FROM subscriptions ORDER BY device_id").all()).toEqual([{ device_id: "dev_one", topic_hash: firstHash }, { device_id: "dev_two", topic_hash: firstHash }]);
  });

  it("does not let a device token manage another device subscriptions", async () => {
    const { app, db } = setup();

    const response = await subscribe(app, "dev_other", "dv_one", firstHash);

    expect(response.status).toBe(404);
    expect(db.prepare("SELECT * FROM subscriptions").all()).toEqual([]);
  });

  it("rejects malformed topic hashes", async () => {
    const { app, db } = setup();

    const response = await subscribe(app, "dev_one", "dv_one", "not-a-topic-hash");

    expect(response.status).toBe(400);
    expect(db.prepare("SELECT * FROM subscriptions").all()).toEqual([]);
  });
});

it.each(["relay", "hosted"])("%s null critical topic cap allows more than two topics", async tier => {
  const { app, db } = setup();
  db.prepare("UPDATE accounts SET tier = ? WHERE id = 'acc_1'").run(tier);
  for (let i = 0; i < 10; i++) {
    expect((await subscribe(app, "dev_one", "dv_one", i.toString(16).repeat(64))).status).toBe(204);
  }
});
