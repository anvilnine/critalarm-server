import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReads } from "../billing-reads.js";
import { createTierRouter } from "../router.js";
import type { StoreReads } from "../types.js";
import { FakeClock, NOW, addAccount, api, database, entitlement, linkBillingId, listing, manualFetch, quietLog, scriptedFetch, settle, tierOf, type TestDatabase } from "./store-fakes.js";

beforeEach(() => { quietLog(); });
afterEach(() => { vi.restoreAllMocks(); });

function device(db: TestDatabase, id: string, accountId: string, token: string) {
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, ?, ?, 'ios', 'x', 1)").run(id, accountId, createHash("sha256").update(token).digest("hex"));
}

function setup(build?: (db: TestDatabase, clock: FakeClock) => StoreReads) {
  const db = database();
  addAccount(db, "acc_1");
  addAccount(db, "acc_2");
  device(db, "dev_one", "acc_1", "dv_one");
  device(db, "dev_one_b", "acc_1", "dv_one_b");
  device(db, "dev_two", "acc_2", "dv_two");
  const clock = new FakeClock();
  const storeReads = build?.(db, clock);
  const app = createTierRouter({
    db,
    clock,
    ids: { account: () => "acc_unused", deviceToken: () => "dv_unused", accountJoinToken: () => "aj_unused" },
    revenueCat: { sharedSecret: "revenuecat-secret", entitlements: api.entitlements },
    ...(storeReads === undefined ? {} : { storeReads }),
  });
  const get = (token?: string) => app.request("/relay/v1/packs", { headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });
  const refresh = (token?: string) => app.request("/relay/v1/packs/refresh", { method: "POST", headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });
  return { db, clock, app, get, refresh };
}

describe("GET /relay/v1/packs", () => {
  it("needs a device token", async () => {
    const { get } = setup();
    expect((await get()).status).toBe(401);
    expect((await get("dv_nobody")).status).toBe(401);
    expect((await get("aj_not_a_device_token")).status).toBe(401);
  });

  it("is an empty list and a null checked_at for an account that holds nothing", async () => {
    const { get } = setup();
    const response = await get("dv_one");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ packs: [], checked_at: null });
  });

  it("reports the account's packs to every device on it, and not to another account", async () => {
    const { db, get } = setup();
    linkBillingId(db, "rc_1", "acc_1");
    db.prepare("UPDATE account_billing_ids SET checked_at = ? WHERE app_user_id = 'rc_1'").run(NOW - 40);
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('rc_1', 'pro', ?)").run(NOW + 900);

    const expected = { packs: [{ id: "pro", expires_at: NOW + 900 }], checked_at: NOW - 40 };
    expect(await (await get("dv_one")).json()).toEqual(expected);
    expect(await (await get("dv_one_b")).json()).toEqual(expected);
    expect(await (await get("dv_two")).json()).toEqual({ packs: [], checked_at: null });
  });

  it("stops reporting a pack once the clock passes its end, with no write in between", async () => {
    const { db, clock, get } = setup();
    db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', ?, 'test', 1)").run(NOW + 10);
    expect(await (await get("dv_one")).json()).toEqual({ packs: [{ id: "pro", expires_at: NOW + 10 }], checked_at: null });
    clock.value = NOW + 10;
    expect(await (await get("dv_one")).json()).toEqual({ packs: [], checked_at: null });
  });

  it("never calls the store, even with reading switched on", async () => {
    const store = scriptedFetch(() => listing(entitlement("ent_pack")));
    const { get } = setup((db, clock) => ({ mode: "on", reads: new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 }) }));
    await get("dv_one");
    expect(store.customers).toEqual([]);
  });
});

describe("POST /relay/v1/packs/refresh", () => {
  it("needs a device token", async () => {
    const { refresh } = setup();
    expect((await refresh()).status).toBe(401);
    expect((await refresh("dv_nobody")).status).toBe(401);
  });

  it("on a relay that does not read the store is always unconfirmed, and reports what the account holds", async () => {
    const { db, refresh } = setup();
    db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'acc_1'").run();
    db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', NULL, 'test', 1)").run();

    const response = await refresh("dv_one");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ confirmed: false, checked_at: null, tier: "hosted", caps: { devices: 5, critical_topics: null, p4_daily: 1000, history_days: 90 }, packs: [{ id: "pro", expires_at: null }] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_billing_ids").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM billing_reads").get()).toEqual({ count: 0 });
  });

  it("allows 6 calls in 60 seconds per account, then answers 429 in the publish limiter's shape", async () => {
    const { clock, refresh } = setup();
    for (let call = 0; call < 6; call += 1) {
      clock.value = NOW + call;
      expect((await refresh(call % 2 === 0 ? "dv_one" : "dv_one_b")).status).toBe(200);
    }
    clock.value = NOW + 10;
    const limited = await refresh("dv_one");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: 42901, http: 429, error: "rate limited" });

    // Another account is counted on its own.
    expect((await refresh("dv_two")).status).toBe(200);

    // The window rolls: the first call leaves it 60 seconds after it was made.
    clock.value = NOW + 59;
    expect((await refresh("dv_one")).status).toBe(429);
    clock.value = NOW + 60;
    expect((await refresh("dv_one")).status).toBe(200);
    expect((await refresh("dv_one")).status).toBe(429);
  });

  it("does not read the store for a call the limit refused", async () => {
    const store = scriptedFetch(() => ({ status: 404 }));
    const { refresh } = setup((db, clock) => ({ mode: "on", reads: new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 }) }));
    for (let call = 0; call < 8; call += 1) await refresh("dv_one");
    expect(store.customers).toHaveLength(6);
  });

  it("waits for the one more read when a read is already running, so its answer is not older than the call", async () => {
    const store = manualFetch();
    let reads: BillingReads | undefined;
    const { db, refresh } = setup((database_, clock) => {
      reads = new BillingReads({ db: database_, clock, fetch: store.fetch, api, requestGapMs: 0 });
      return { mode: "on", reads };
    });
    linkBillingId(db, "acc_1", "acc_1");

    // A read from some other trigger is out when the refresh arrives.
    const earlier = reads?.read("acc_1", "sweep");
    await settle();
    let answered = false;
    const response = Promise.resolve(refresh("dv_one")).then((value) => { answered = true; return value; });
    await settle();
    expect(store.pending).toHaveLength(1);

    store.pending[0]?.answer(listing());
    await earlier;
    await settle();
    // The earlier read is written, and the refresh has still not answered.
    expect(answered).toBe(false);
    expect(store.pending).toHaveLength(2);

    store.pending[1]?.answer(listing(entitlement("ent_hosted"), entitlement("ent_pack")));
    expect(await (await response).json()).toMatchObject({ confirmed: true, tier: "hosted", packs: [{ id: "pro", expires_at: null }] });
    expect(tierOf(db, "acc_1")).toBe("hosted");
  });
});
