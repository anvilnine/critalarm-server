import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShadowReads } from "../billing-shadow.js";
import { createTierRouter } from "../router.js";
import { FakeClock, NOW, addAccount, api, database, entitlement, linkBillingId, listing, logged, quietLog, scriptedFetch, settle, tierOf, type Answer, type TestDatabase } from "./store-fakes.js";

// The step before reading is switched on: every write stays on the event path,
// and the read runs beside it and only logs.

let log: ReturnType<typeof quietLog>;
beforeEach(() => { log = quietLog(); });
afterEach(() => { vi.restoreAllMocks(); });

const FUTURE_MS = (NOW + 86_400) * 1_000;

// Everything a read could write to, as one comparable value.
function snapshot(db: TestDatabase) {
  return {
    accounts: db.prepare("SELECT id, tier FROM accounts ORDER BY id").all(),
    billing: db.prepare("SELECT * FROM account_billing_ids ORDER BY app_user_id").all(),
    packs: db.prepare("SELECT * FROM billing_packs").all(),
    grants: db.prepare("SELECT * FROM account_pack_grants").all(),
    reads: db.prepare("SELECT * FROM billing_reads").all(),
    events: db.prepare("SELECT * FROM billing_events ORDER BY event_id").all(),
    changes: db.prepare("SELECT account_id, from_tier, to_tier, reason, event_id FROM tier_changes ORDER BY changed_at, reason").all(),
  };
}

function setup(shadowed: boolean) {
  const db = database();
  addAccount(db, "acc_1");
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_one', 'acc_1', ?, 'ios', 'x', 1)").run(createHash("sha256").update("dv_one").digest("hex"));
  const clock = new FakeClock();
  const listed = new Map<string, Answer | Error>();
  const store = scriptedFetch((appUserId) => listed.get(appUserId) ?? { status: 404 });
  const app = createTierRouter({
    db,
    clock,
    ids: { account: () => "acc_unused", deviceToken: () => "dv_unused", accountJoinToken: () => "aj_unused" },
    revenueCat: { sharedSecret: "revenuecat-secret", entitlements: api.entitlements },
    ...(shadowed ? { storeReads: { mode: "shadow" as const, shadow: new ShadowReads({ db, clock, fetch: store.fetch, api }) } } : {}),
  });
  const deliver = async (event: Record<string, unknown>) => {
    const response = await app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer revenuecat-secret", "content-type": "application/json" }, body: JSON.stringify({ event }) });
    await settle();
    return response;
  };
  const refresh = () => app.request("/relay/v1/packs/refresh", { method: "POST", headers: { Authorization: "Bearer dv_one" } });
  return { db, clock, listed, store, deliver, refresh };
}

function shadowLines(spy: ReturnType<typeof quietLog>) {
  return logged(spy).filter((line) => line.event === "billing_shadow");
}

const events: Record<string, unknown>[] = [
  { id: "e1", app_user_id: "acc_1", type: "INITIAL_PURCHASE", event_timestamp_ms: 1_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS },
  { id: "e2", app_user_id: "acc_1", type: "RENEWAL", event_timestamp_ms: 2_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS },
  { id: "e2", app_user_id: "acc_1", type: "RENEWAL", event_timestamp_ms: 2_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS },
  { id: "e3", app_user_id: "acc_1", type: "BILLING_ISSUE", event_timestamp_ms: 3_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS },
  { id: "e0", app_user_id: "acc_1", type: "EXPIRATION", event_timestamp_ms: 500, entitlement_ids: ["ent_hosted"] },
  { id: "e4", app_user_id: "nobody", type: "INITIAL_PURCHASE", event_timestamp_ms: 4_000, entitlement_ids: ["ent_hosted"] },
  { id: "e5", app_user_id: "acc_1", type: "EXPIRATION", event_timestamp_ms: 5_000, entitlement_ids: ["ent_hosted"] },
];

describe("the shadow step", () => {
  it("leaves every write exactly as it is with reading off, event for event", async () => {
    const off = setup(false);
    const shadow = setup(true);
    // The store disagrees with the events on purpose. Nothing it says may land.
    shadow.listed.set("acc_1", listing(entitlement("ent_relay", FUTURE_MS), entitlement("ent_pack")));

    for (const event of events) {
      const expected = await off.deliver(event);
      const actual = await shadow.deliver(event);
      expect(actual.status).toBe(expected.status);
      expect(snapshot(shadow.db)).toEqual(snapshot(off.db));
    }
    expect(tierOf(shadow.db, "acc_1")).toBe("free");
    expect(shadow.store.customers.length).toBeGreaterThan(0);
    expect(off.store.customers).toEqual([]);
  });

  it("still refuses an event with no app_user_id, as the event path does", async () => {
    const { deliver, store } = setup(true);
    expect((await deliver({ id: "t1", type: "TRANSFER", transferred_from: ["acc_1"], transferred_to: ["acc_1"] })).status).toBe(400);
    expect(store.customers).toEqual([]);
  });

  it("logs one line per read with the fields a person needs before the switch", async () => {
    const { listed, deliver } = setup(true);
    listed.set("acc_1", listing(entitlement("ent_hosted", FUTURE_MS)));

    await deliver({ id: "e1", app_user_id: "acc_1", type: "INITIAL_PURCHASE", event_timestamp_ms: 1_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS });

    expect(shadowLines(log)).toEqual([{
      event: "billing_shadow",
      app_user_id: "acc_1",
      trigger: "webhook",
      status: 200,
      entitlement_ids: ["ent_hosted"],
      unknown_ids: [],
      read_tier: "hosted",
      read_packs: [],
      stored_tier: "hosted",
      agrees: true,
    }]);
  });

  it("shows the identifiers exactly as the store returned them, and says when the two paths disagree", async () => {
    const { db, listed, deliver } = setup(true);
    // The store answers with an identifier the tier map does not name.
    listed.set("acc_1", listing(entitlement("entl_internal_1a2b", FUTURE_MS), entitlement("ent_pack")));

    await deliver({ id: "e1", app_user_id: "acc_1", type: "INITIAL_PURCHASE", event_timestamp_ms: 1_000, entitlement_ids: ["ent_relay"], expiration_at_ms: FUTURE_MS });

    expect(tierOf(db, "acc_1")).toBe("relay");
    expect(shadowLines(log)).toEqual([{
      event: "billing_shadow", app_user_id: "acc_1", trigger: "webhook", status: 200,
      entitlement_ids: ["entl_internal_1a2b", "ent_pack"], unknown_ids: ["entl_internal_1a2b"],
      read_tier: "relay", read_packs: ["pro"], stored_tier: "relay", agrees: true,
    }]);

    listed.set("acc_1", listing());
    await deliver({ id: "e2", app_user_id: "acc_1", type: "RENEWAL", event_timestamp_ms: 2_000, entitlement_ids: ["ent_relay"], expiration_at_ms: FUTURE_MS });
    expect(shadowLines(log)[1]).toMatchObject({ read_tier: "free", stored_tier: "relay", agrees: false });
  });

  it("logs what the store answers for a customer it has never seen, from a refresh, and answers unconfirmed", async () => {
    const { db, refresh } = setup(true);
    const before = snapshot(db);

    const response = await refresh();

    expect(await response.json()).toEqual({ confirmed: false, checked_at: null, tier: "free", caps: { devices: 5, critical_topics: 2, p4_daily: 50, history_days: 7 }, packs: [] });
    expect(shadowLines(log)).toEqual([{ event: "billing_shadow", app_user_id: "acc_1", trigger: "refresh", status: 404, entitlement_ids: [], unknown_ids: [], read_tier: "free", read_packs: [], stored_tier: "free", agrees: true }]);
    expect(snapshot(db)).toEqual(before);
  });

  it("logs a failed read with its status and writes nothing", async () => {
    const { db, listed, refresh } = setup(true);
    db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'acc_1'").run();
    linkBillingId(db, "acc_1", "acc_1", "hosted");
    listed.set("acc_1", { status: 401 });
    const before = snapshot(db);

    await refresh();

    expect(shadowLines(log)).toEqual([{ event: "billing_shadow", app_user_id: "acc_1", trigger: "refresh", status: 401, reason: "status", entitlement_ids: [], unknown_ids: [], read_tier: null, read_packs: [], stored_tier: "hosted", agrees: null }]);
    expect(snapshot(db)).toEqual(before);
    expect(tierOf(db, "acc_1")).toBe("hosted");
  });

  it("does not let a read that throws reach the request", async () => {
    const { listed, deliver, refresh } = setup(true);
    listed.set("acc_1", new Error("boom"));
    expect((await deliver({ id: "e1", app_user_id: "acc_1", type: "RENEWAL", event_timestamp_ms: 1_000, entitlement_ids: ["ent_hosted"], expiration_at_ms: FUTURE_MS })).status).toBe(200);
    expect((await refresh()).status).toBe(200);
    expect(shadowLines(log).map((line) => line.status)).toEqual([null, null]);
  });
});
