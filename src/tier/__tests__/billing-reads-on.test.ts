import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReads } from "../billing-reads.js";
import { createTierRouter } from "../router.js";
import { FakeClock, NOW, addAccount, api, billingRow, database, entitlement, linkBillingId, listing, logged, queue, quietLog, scriptedFetch, storedPacks, tierOf, type Answer, type TestDatabase } from "./store-fakes.js";

// api.md §4.3 with reading switched on. An event names customers and decides
// nothing. The store's own list decides the tier and the packs.

let log: ReturnType<typeof quietLog>;
beforeEach(() => { log = quietLog(); });
afterEach(() => { vi.restoreAllMocks(); });

const FUTURE_MS = (NOW + 86_400) * 1_000;
const PAST_MS = (NOW - 86_400) * 1_000;

function device(db: TestDatabase, id: string, accountId: string, token: string) {
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, ?, ?, 'ios', 'x', 1)").run(id, accountId, createHash("sha256").update(token).digest("hex"));
}

function setup() {
  const db = database();
  addAccount(db, "acc_1");
  device(db, "dev_one", "acc_1", "dv_one");
  const clock = new FakeClock();
  // What the store lists for each customer right now. A customer missing from
  // the map is one the store has never seen.
  const listed = new Map<string, Answer | Error>();
  const store = scriptedFetch((appUserId) => listed.get(appUserId) ?? { status: 404 });
  const reads = new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 });
  const app = createTierRouter({
    db,
    clock,
    ids: { account: () => "acc_unused", deviceToken: () => "dv_unused", accountJoinToken: () => "aj_unused" },
    revenueCat: { sharedSecret: "revenuecat-secret", entitlements: api.entitlements },
    storeReads: { mode: "on", reads },
  });
  let eventNumber = 0;
  const deliver = async (event: Record<string, unknown>) => {
    eventNumber += 1;
    const response = await app.request("/webhooks/revenuecat", {
      method: "POST",
      headers: { Authorization: "Bearer revenuecat-secret", "content-type": "application/json" },
      body: JSON.stringify({ api_version: "1.0", event: { id: `evt_${eventNumber}`, event_timestamp_ms: (NOW + eventNumber) * 1_000, ...event } }),
    });
    await reads.scan();
    return response;
  };
  const refresh = (token = "dv_one") => app.request("/relay/v1/packs/refresh", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  return { db, clock, listed, store, reads, app, deliver, refresh };
}

// An account that pays for the hosted tier and holds the pack, as one customer.
function paying(db: TestDatabase) {
  db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'acc_1'").run();
  linkBillingId(db, "acc_1", "acc_1", "hosted");
  db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('acc_1', 'pro', NULL)").run();
}

const PACK = [{ app_user_id: "acc_1", pack: "pro", expires_at: null }];

describe("the webhook with reading switched on", () => {
  it("an expiry event for a pack leaves a hosted tier alone", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS)));

    const response = await deliver({ app_user_id: "acc_1", type: "EXPIRATION", entitlement_id: "ent_pack", entitlement_ids: ["ent_pack"], expiration_at_ms: PAST_MS });

    expect(response.status).toBe(200);
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", applied_seq: 1, checked_at: NOW });
    expect(storedPacks(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tier_changes").get()).toEqual({ count: 0 });
  });

  it("an expiry event for the tier leaves a pack alone", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_pack")));

    await deliver({ app_user_id: "acc_1", type: "EXPIRATION", entitlement_id: "ent_hosted", entitlement_ids: ["ent_hosted"], expiration_at_ms: PAST_MS });

    expect(tierOf(db, "acc_1")).toBe("free");
    expect(storedPacks(db)).toEqual(PACK);
    expect(db.prepare("SELECT from_tier, to_tier, reason, event_id FROM tier_changes").all()).toEqual([{ from_tier: "hosted", to_tier: "free", reason: "revenuecat read (webhook) for acc_1", event_id: null }]);
  });

  it("an event naming both writes both from one read", async () => {
    const { db, listed, store, deliver } = setup();
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack", FUTURE_MS)));

    await deliver({ app_user_id: "acc_1", type: "INITIAL_PURCHASE", entitlement_ids: ["ent_hosted", "ent_pack"], expiration_at_ms: FUTURE_MS });

    expect(store.customers).toEqual(["acc_1"]);
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: NOW + 86_400 }]);
    expect(billingRow(db, "acc_1")).toMatchObject({ account_id: "acc_1", entitled_tier: "hosted", read_seq: 1, applied_seq: 1 });
  });

  it("an event with a past expiry decides nothing while the store still lists the entitlement", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack")));

    await deliver({ app_user_id: "acc_1", type: "RENEWAL", entitlement_ids: ["ent_hosted"], expiration_at_ms: PAST_MS });

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual(PACK);
  });

  it("an entitlement the store lists with an expiry already passed does not count", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_hosted", PAST_MS), entitlement("ent_pack", PAST_MS)));

    await deliver({ app_user_id: "acc_1", type: "RENEWAL", entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS });

    expect(tierOf(db, "acc_1")).toBe("free");
    expect(storedPacks(db)).toEqual([]);
  });

  it("a billing problem during the grace period keeps the tier and the pack", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack", FUTURE_MS)));

    await deliver({ app_user_id: "acc_1", type: "BILLING_ISSUE", entitlement_ids: ["ent_hosted", "ent_pack"], expiration_at_ms: FUTURE_MS, grace_period_expiration_at_ms: FUTURE_MS });

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: NOW + 86_400 }]);
  });

  it("a refund removes what the store no longer lists", async () => {
    const { db, listed, deliver } = setup();
    linkBillingId(db, "acc_1", "acc_1", "free");
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('acc_1', 'pro', NULL)").run();
    listed.set("acc_1", listing());

    await deliver({ app_user_id: "acc_1", type: "CANCELLATION", entitlement_ids: ["ent_pack"], expiration_at_ms: null, cancel_reason: "CUSTOMER_SUPPORT" });

    expect(storedPacks(db)).toEqual([]);
    expect(tierOf(db, "acc_1")).toBe("free");
  });

  it("a cancelled renewal changes nothing while the entitlement is still listed", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack")));

    await deliver({ app_user_id: "acc_1", type: "CANCELLATION", entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS });

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual(PACK);
  });

  it("a transfer reads the side that lost the purchase and the side that gained it", async () => {
    const { db, listed, store, deliver } = setup();
    paying(db);
    addAccount(db, "acc_2");
    listed.set("acc_1", listing());
    listed.set("acc_2", listing(entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack")));

    // No app_user_id at all: the two arrays are enough.
    const response = await deliver({ type: "TRANSFER", transferred_from: ["acc_1"], transferred_to: ["acc_2"] });

    expect(response.status).toBe(200);
    expect([...store.customers].sort()).toEqual(["acc_1", "acc_2"]);
    expect(tierOf(db, "acc_1")).toBe("free");
    expect(tierOf(db, "acc_2")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_2", pack: "pro", expires_at: null }]);
  });

  it("an event for a customer with no account is logged and dropped", async () => {
    const { db, store, deliver } = setup();

    const response = await deliver({ app_user_id: "nobody_we_know", type: "INITIAL_PURCHASE", entitlement_ids: ["ent_hosted"] });

    expect(response.status).toBe(200);
    expect(store.customers).toEqual([]);
    expect(queue(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_billing_ids").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT event_id, app_user_id, account_id, applied FROM billing_events").all()).toEqual([{ event_id: "evt_1", app_user_id: "nobody_we_know", account_id: null, applied: 0 }]);
    expect(logged(log)).toContainEqual({ event: "billing_event_unresolved", event_id: "evt_1", app_user_id: "nobody_we_know" });
  });

  it("an event naming no customer at all is refused", async () => {
    const { deliver, store } = setup();
    expect((await deliver({ type: "TRANSFER" })).status).toBe(400);
    expect((await deliver({ type: "TRANSFER", transferred_from: [], transferred_to: [] })).status).toBe(400);
    expect((await deliver({ app_user_id: "acc_1" })).status).toBe(400);
    expect(store.customers).toEqual([]);
  });

  it("still demands the shared secret", async () => {
    const { app, store } = setup();
    const response = await app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer wrong", "content-type": "application/json" }, body: JSON.stringify({ event: { id: "e", app_user_id: "acc_1", type: "RENEWAL" } }) });
    expect(response.status).toBe(401);
    expect(store.customers).toEqual([]);
  });

  it("an event id it has already seen triggers nothing", async () => {
    const { app, db, listed, store, reads } = setup();
    listed.set("acc_1", listing(entitlement("ent_relay", FUTURE_MS)));
    const send = () => app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer revenuecat-secret", "content-type": "application/json" }, body: JSON.stringify({ event: { id: "evt_same", app_user_id: "acc_1", type: "RENEWAL" } }) });

    expect((await send()).status).toBe(200);
    await reads.scan();
    expect((await send()).status).toBe(200);
    await reads.scan();

    expect(store.customers).toEqual(["acc_1"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM billing_events").get()).toEqual({ count: 1 });
  });

  it("the event's own entitlements decide nothing when the store lists none", async () => {
    const { db, listed, deliver } = setup();
    listed.set("acc_1", listing());

    await deliver({ app_user_id: "acc_1", type: "INITIAL_PURCHASE", entitlement_id: "ent_hosted", entitlement_ids: ["ent_hosted", "ent_pack"], expiration_at_ms: FUTURE_MS });

    expect(tierOf(db, "acc_1")).toBe("free");
    expect(storedPacks(db)).toEqual([]);
  });

  it("an expiry that arrives after a renewal changes nothing the list does not show", async () => {
    const { db, listed, deliver } = setup();
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS)));

    await deliver({ app_user_id: "acc_1", type: "RENEWAL", event_timestamp_ms: (NOW + 500) * 1_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS });
    await deliver({ app_user_id: "acc_1", type: "EXPIRATION", event_timestamp_ms: (NOW - 500) * 1_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: PAST_MS });

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", applied_seq: 2 });
  });

  it("links a customer who bought only a pack, on the first event that resolves", async () => {
    const { db, listed, deliver } = setup();
    listed.set("acc_1", listing(entitlement("ent_pack")));

    await deliver({ app_user_id: "acc_1", type: "NON_RENEWING_PURCHASE", entitlement_ids: ["ent_pack"] });

    expect(billingRow(db, "acc_1")).toMatchObject({ account_id: "acc_1", entitled_tier: "free", applied_seq: 1 });
    expect(storedPacks(db)).toEqual(PACK);
    expect(tierOf(db, "acc_1")).toBe("free");
  });

  it("lands on the surviving account when the customer id belongs to a merged one", async () => {
    const { db, listed, deliver } = setup();
    addAccount(db, "acc_old");
    db.prepare("UPDATE accounts SET merged_into = 'acc_1' WHERE id = 'acc_old'").run();
    listed.set("acc_old", listing(entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack")));

    await deliver({ app_user_id: "acc_old", type: "RENEWAL" });

    expect(billingRow(db, "acc_old")).toMatchObject({ account_id: "acc_1", entitled_tier: "hosted" });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(tierOf(db, "acc_old")).toBe("free");
  });

  it("keeps the highest tier across an account's customers when one of them lapses", async () => {
    const { db, listed, deliver } = setup();
    db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'acc_1'").run();
    linkBillingId(db, "rc_a", "acc_1", "hosted");
    linkBillingId(db, "rc_b", "acc_1", "relay");
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('rc_b', 'pro', NULL)").run();
    listed.set("rc_a", listing());
    listed.set("rc_b", listing(entitlement("ent_relay", FUTURE_MS), entitlement("ent_pack")));

    await deliver({ app_user_id: "rc_a", type: "EXPIRATION" });

    expect(tierOf(db, "acc_1")).toBe("relay");
    expect(storedPacks(db)).toEqual([{ app_user_id: "rc_b", pack: "pro", expires_at: null }]);
  });

  it("a failed read after an event leaves a hosted tier and a pack as they were, and queues a retry", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", { status: 500 });

    const response = await deliver({ app_user_id: "acc_1", type: "EXPIRATION", entitlement_ids: ["ent_hosted", "ent_pack"], expiration_at_ms: PAST_MS });

    expect(response.status).toBe(200);
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual(PACK);
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", applied_seq: 0, checked_at: null });
    expect(queue(db)).toEqual([{ app_user_id: "acc_1", due_at: NOW + 60, attempts: 1, dirty: 0 }]);
  });
});

describe("an entitlement the configuration does not name", () => {
  it("is logged, and the read may still raise a tier and add a pack", async () => {
    const { db, listed, deliver } = setup();
    listed.set("acc_1", listing(entitlement("ent_mystery"), entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack")));

    await deliver({ app_user_id: "acc_1", type: "INITIAL_PURCHASE" });

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual(PACK);
    expect(logged(log)).toContainEqual({ event: "billing_unknown_entitlement", app_user_id: "acc_1", entitlement_id: "ent_mystery" });
  });

  it("may not lower a tier or remove a pack", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_mystery")));

    await deliver({ app_user_id: "acc_1", type: "PRODUCT_CHANGE" });

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual(PACK);
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", applied_seq: 1 });
  });

  it("does not hold a tier up once its own expiry has passed", async () => {
    const { db, listed, deliver } = setup();
    paying(db);
    listed.set("acc_1", listing(entitlement("ent_mystery", PAST_MS)));

    await deliver({ app_user_id: "acc_1", type: "EXPIRATION" });

    expect(tierOf(db, "acc_1")).toBe("free");
    expect(storedPacks(db)).toEqual([]);
  });
});

describe("POST /relay/v1/packs/refresh with reading switched on", () => {
  it("links a first purchase that has no billing row and no webhook yet", async () => {
    const { db, listed, store, refresh } = setup();
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS), entitlement("ent_pack")));

    const response = await refresh();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      confirmed: true,
      checked_at: NOW,
      tier: "hosted",
      caps: { devices: 5, critical_topics: null, p4_daily: 1000, history_days: 90 },
      packs: [{ id: "pro", expires_at: null }],
    });
    expect(store.customers).toEqual(["acc_1"]);
    expect(billingRow(db, "acc_1")).toMatchObject({ account_id: "acc_1", entitled_tier: "hosted", read_seq: 1, applied_seq: 1 });
  });

  it("answers confirmed with nothing for a customer the store has never seen, and writes no row", async () => {
    const { db, store, refresh } = setup();

    const response = await refresh();

    expect(await response.json()).toEqual({ confirmed: true, checked_at: null, tier: "free", caps: { devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 }, packs: [] });
    expect(store.customers).toEqual(["acc_1"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_billing_ids").get()).toEqual({ count: 0 });
    expect(queue(db)).toEqual([]);
  });

  it("writes no row for a customer the store knows who holds nothing live", async () => {
    const { db, listed, refresh } = setup();
    listed.set("acc_1", listing());

    expect(await (await refresh()).json()).toMatchObject({ confirmed: true, checked_at: null, packs: [] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_billing_ids").get()).toEqual({ count: 0 });
  });

  it("reads the account's own id, every linked billing id and every account merged into it", async () => {
    const { db, listed, store, refresh } = setup();
    linkBillingId(db, "rc_linked", "acc_1", "free");
    addAccount(db, "acc_old");
    db.prepare("UPDATE accounts SET merged_into = 'acc_1' WHERE id = 'acc_old'").run();
    addAccount(db, "acc_stranger");
    linkBillingId(db, "rc_stranger", "acc_stranger", "hosted");
    listed.set("acc_old", listing(entitlement("ent_pack")));
    listed.set("rc_linked", listing(entitlement("ent_relay", FUTURE_MS)));

    const body = await (await refresh()).json() as Record<string, unknown>;

    expect([...store.customers].sort()).toEqual(["acc_1", "acc_old", "rc_linked"]);
    expect(body).toMatchObject({ confirmed: true, tier: "relay", packs: [{ id: "pro", expires_at: null }] });
    expect(billingRow(db, "acc_old")).toMatchObject({ account_id: "acc_1" });
  });

  it("answers unconfirmed and keeps what the account held when one read fails", async () => {
    const { db, listed, refresh } = setup();
    paying(db);
    linkBillingId(db, "rc_linked", "acc_1", "free");
    listed.set("acc_1", new Error("connect ETIMEDOUT"));
    listed.set("rc_linked", listing());

    const body = await (await refresh()).json();

    expect(body).toEqual({ confirmed: false, checked_at: NOW, tier: "hosted", caps: { devices: 5, critical_topics: null, p4_daily: 1000, history_days: 90 }, packs: [{ id: "pro", expires_at: null }] });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual(PACK);
  });

  it("reports a pack held by grant when the store lists none, and still says the store was read", async () => {
    const { db, listed, refresh } = setup();
    db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', NULL, 'test', 1)").run();
    listed.set("acc_1", listing());

    expect(await (await refresh()).json()).toMatchObject({ confirmed: true, checked_at: null, packs: [{ id: "pro", expires_at: null }] });
  });
});
