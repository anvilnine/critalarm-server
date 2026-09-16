import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createTierRouter } from "../router.js";

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_one', 'acc_1', ?, 'ios', 'one', 1)").run(createHash("sha256").update("dv_one").digest("hex"));
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_two', 'acc_1', ?, 'android', 'two', 1)").run(createHash("sha256").update("dv_two").digest("hex"));
  return { app: createTierRouter({ db, clock: { now: () => 1_000 }, ids: { account: () => "acc_unused", deviceToken: () => "dv_unused", accountJoinToken: () => "aj_unused" }, revenueCat: { sharedSecret: "revenuecat-secret", entitlements: { crit_relay: "relay", crit_hosted: "hosted" } } }), db };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    api_version: "1.0",
    event: {
      aliases: ["acc_1"],
      app_id: "app123",
      app_user_id: "acc_1",
      commission_percentage: 0.85,
      country_code: "US",
      currency: "USD",
      entitlement_id: "crit_relay",
      entitlement_ids: ["crit_relay"],
      environment: "PRODUCTION",
      event_timestamp_ms: 1_000_000,
      expiration_at_ms: 2_000_000,
      id: "webhook-event-id",
      is_family_share: false,
      original_app_user_id: "acc_1",
      original_transaction_id: "original-transaction-id",
      period_type: "NORMAL",
      presented_offering_id: "default",
      price: 4.99,
      price_in_purchased_currency: 4.99,
      product_id: "critalarm.relay",
      purchased_at_ms: 900_000,
      store: "APP_STORE",
      subscriber_attributes: {},
      takehome_percentage: 0.7,
      tax_percentage: 0.1,
      transaction_id: "transaction-id",
      type: "INITIAL_PURCHASE",
      ...overrides,
    },
  };
}

function webhook(app: ReturnType<typeof createTierRouter>, body: unknown, secret = "revenuecat-secret") {
  return app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("RevenueCat webhook", () => {
  it("rejects missing or wrong shared secrets", async () => {
    const { app } = setup();

    const missing = await app.request("/webhooks/revenuecat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event()) });
    const wrong = await webhook(app, event(), "wrong-secret");

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  // An empty secret is defined, so it passed the startup check, and then the
  // sha256 of "" matched the sha256 of a request with no Authorization header.
  it("is not mounted when the shared secret is empty or unset", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const ids = { account: () => "acc_unused", deviceToken: () => "dv_unused", accountJoinToken: () => "aj_unused" };
    const empty = createTierRouter({ db, clock: { now: () => 1_000 }, ids, revenueCat: { sharedSecret: "", entitlements: {} } });
    const unset = createTierRouter({ db, clock: { now: () => 1_000 }, ids });

    const unauthenticated = await empty.request("/webhooks/revenuecat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event()) });
    const guessed = await empty.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer ", "content-type": "application/json" }, body: JSON.stringify(event()) });

    expect([unauthenticated.status, guessed.status]).toEqual([404, 404]);
    expect((await unset.request("/webhooks/revenuecat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event()) })).status).toBe(404);
    expect((await unset.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: `dev_${randomUUID()}`, platform: "ios", push_token: "p", app_version: "1.0.0" }) })).status).toBe(201);
    db.close();
  });

  it("rejects malformed webhook bodies", async () => {
    const { app } = setup();

    const response = await app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer revenuecat-secret", "content-type": "application/json" }, body: "not-json" });

    expect(response.status).toBe(400);
  });

  it("selects the account from event app_user_id and applies an active mapped entitlement to every device", async () => {
    const { app, db } = setup();

    const response = await webhook(app, event());

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT id, tier FROM accounts").all()).toEqual([{ id: "acc_1", tier: "relay" }]);
    expect(db.prepare("SELECT devices.id, accounts.tier FROM devices JOIN accounts ON accounts.id = devices.account_id ORDER BY devices.id").all()).toEqual([{ id: "dev_one", tier: "relay" }, { id: "dev_two", tier: "relay" }]);
  });

  it("returns an expired entitlement account to free", async () => {
    const { app, db } = setup();
    db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'acc_1'").run();

    const response = await webhook(app, event({ type: "EXPIRATION", expiration_at_ms: 900_000 }));

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "free" });
  });

  it("accepts events for unknown accounts without creating one", async () => {
    const { app, db } = setup();

    const response = await webhook(app, event({ app_user_id: "acc_unknown", original_app_user_id: "acc_unknown", aliases: ["acc_unknown"] }));

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT id FROM accounts ORDER BY id").all()).toEqual([{ id: "acc_1" }]);
    // Logged, so a support question about it has an answer, but not applied.
    expect(db.prepare("SELECT app_user_id, account_id, applied FROM billing_events").all()).toEqual([
      { app_user_id: "acc_unknown", account_id: null, applied: 0 },
    ]);
  });

  it("writes a tier_changes row naming the event behind every change", async () => {
    const { app, db } = setup();

    await webhook(app, event());
    await webhook(app, event({ id: "expiry-event", type: "EXPIRATION", expiration_at_ms: 900_000, event_timestamp_ms: 2_000_000 }));

    expect(db.prepare("SELECT account_id, from_tier, to_tier, event_id FROM tier_changes ORDER BY changed_at, rowid").all()).toEqual([
      { account_id: "acc_1", from_tier: "free", to_tier: "relay", event_id: "webhook-event-id" },
      { account_id: "acc_1", from_tier: "relay", to_tier: "free", event_id: "expiry-event" },
    ]);
  });

  it("applies the same event once however many times it is delivered", async () => {
    const { app, db } = setup();

    expect((await webhook(app, event())).status).toBe(200);
    db.prepare("UPDATE accounts SET tier = 'free' WHERE id = 'acc_1'").run();
    expect((await webhook(app, event())).status).toBe(200);

    // The repeat did not run again, so it did not put the tier back.
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "free" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM billing_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tier_changes").get()).toEqual({ count: 1 });
  });

  it("ignores an event older than the last one applied for that billing id", async () => {
    const { app, db } = setup();

    await webhook(app, event({ id: "renewal", type: "RENEWAL", event_timestamp_ms: 5_000_000, expiration_at_ms: 9_000_000 }));
    const late = await webhook(app, event({ id: "stale-expiry", type: "EXPIRATION", event_timestamp_ms: 4_000_000, expiration_at_ms: 900_000 }));

    expect(late.status).toBe(200);
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "relay" });
    expect(db.prepare("SELECT event_id, applied FROM billing_events ORDER BY event_at").all()).toEqual([
      { event_id: "stale-expiry", applied: 0 },
      { event_id: "renewal", applied: 1 },
    ]);
    expect(db.prepare("SELECT last_event_at FROM account_billing_ids WHERE app_user_id = 'acc_1'").get()).toEqual({ last_event_at: 5_000 });
  });

  it("resolves two billing ids on one account and keeps the tier at the highest live one", async () => {
    const { app, db } = setup();
    // What a merge leaves behind: two subscriptions, one account.
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, entitled_tier) VALUES ('rc_a', 'acc_1', 1, 'free')").run();
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, entitled_tier) VALUES ('rc_b', 'acc_1', 1, 'free')").run();

    await webhook(app, event({ id: "a-buys-relay", app_user_id: "rc_a", entitlement_id: "crit_relay", entitlement_ids: ["crit_relay"] }));
    await webhook(app, event({ id: "b-buys-hosted", app_user_id: "rc_b", entitlement_id: "crit_hosted", entitlement_ids: ["crit_hosted"] }));

    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "hosted" });

    // rc_b lapses. rc_a is still paying for relay, so the account lands on relay
    // rather than free.
    const expiry = await webhook(app, event({ id: "b-expires", app_user_id: "rc_b", type: "EXPIRATION", expiration_at_ms: 900_000, event_timestamp_ms: 2_000_000 }));

    expect(expiry.status).toBe(200);
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "relay" });
    expect(db.prepare("SELECT app_user_id, entitled_tier FROM account_billing_ids ORDER BY app_user_id").all()).toEqual([
      { app_user_id: "rc_a", entitled_tier: "relay" },
      { app_user_id: "rc_b", entitled_tier: "free" },
    ]);
  });

  it("does not downgrade on a billing problem that has not lapsed yet", async () => {
    const { app, db } = setup();
    await webhook(app, event());

    const issue = await webhook(app, event({ id: "billing-issue", type: "BILLING_ISSUE", event_timestamp_ms: 2_000_000, expiration_at_ms: 9_000_000 }));

    expect(issue.status).toBe(200);
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "relay" });
  });

  it("lands a late event for a merged account on the account that absorbed it", async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_2', 'free', 1)").run();
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, entitled_tier) VALUES ('rc_old', 'acc_1', 1, 'free')").run();
    db.prepare("UPDATE accounts SET merged_into = 'acc_2' WHERE id = 'acc_1'").run();

    await webhook(app, event({ id: "late-purchase", app_user_id: "rc_old" }));

    expect(db.prepare("SELECT id, tier FROM accounts ORDER BY id").all()).toEqual([
      { id: "acc_1", tier: "free" },
      { id: "acc_2", tier: "relay" },
    ]);
    expect(db.prepare("SELECT account_id FROM account_billing_ids WHERE app_user_id = 'rc_old'").get()).toEqual({ account_id: "acc_2" });
  });
});
