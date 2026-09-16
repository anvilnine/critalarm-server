import { createHash } from "node:crypto";
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
  });
});
