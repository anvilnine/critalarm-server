import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReads } from "../billing-reads.js";
import { createTierRouter } from "../router.js";
import { FakeClock, NOW, api, billingRow, database, entitlement, listing, queue, quietLog, scriptedFetch, storedPacks, tierOf, type Answer } from "./store-fakes.js";

// api.md §4.3: "When a read fails, nothing changes. A failed read never lowers
// a tier and never removes a pack." A pack the store gave carries the end date
// the store last reported. A renewal moves that date on the store's side, and
// the relay only learns the new one from a read. So a read that fails around a
// renewal leaves an old date behind, and that date alone must end nothing.

beforeEach(() => { quietLog(); });
afterEach(() => { vi.restoreAllMocks(); });

const END = NOW + 3_600;
const RENEWED = END + 30 * 86_400;
const DEVICE = { device_id: "dev_123e4567-e89b-12d3-a456-426614174000", platform: "ios", push_token: "apns-token", app_version: "1.0.0" } as const;
const CAPS = { devices: 5, critical_topics: null, p4_daily: 1000, history_days: 90 };
const HELD = [{ id: "pro", expires_at: END }];

// One registered device on an account that pays for the hosted tier and holds
// the pack until END, both written by a read that worked.
async function paying() {
  const db = database();
  const clock = new FakeClock();
  let answer: Answer | Error = listing(entitlement("ent_hosted", END * 1_000), entitlement("ent_pack", END * 1_000));
  const store = scriptedFetch(() => answer);
  const reads = new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 });
  const app = createTierRouter({
    db,
    clock,
    ids: { account: () => "acc_1", deviceToken: () => "dv_one", accountJoinToken: () => "aj_one" },
    revenueCat: { sharedSecret: "revenuecat-secret", entitlements: api.entitlements },
    storeReads: { mode: "on", reads },
  });
  const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method,
    headers: { Authorization: "Bearer dv_one", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (response: Response | Promise<Response>) => (await response).json() as Promise<Record<string, unknown>>;

  expect((await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(DEVICE) })).status).toBe(201);
  // The app's customer id is the account id, so this read links the purchase.
  expect(await reads.read("acc_1", "webhook")).toEqual({ ok: true });
  expect(tierOf(db, "acc_1")).toBe("hosted");
  expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: END }]);

  return {
    db,
    clock,
    store,
    reads,
    storeAnswers: (next: Answer | Error) => { answer = next; },
    register: () => json(send("POST", "/relay/v1/devices", DEVICE)),
    patch: () => json(send("PATCH", `/relay/v1/devices/${DEVICE.device_id}`, { push_token: "apns-token-2", app_version: "1.0.1" })),
    packs: () => json(send("GET", "/relay/v1/packs")),
    refresh: () => json(send("POST", "/relay/v1/packs/refresh")),
  };
}

describe("a store pack whose saved end date has passed", () => {
  it("is still listed on registration, on GET /relay/v1/packs and on a refresh when the read failed", async () => {
    const { db, clock, storeAnswers, register, patch, packs, refresh } = await paying();
    // The store renews the pack, and from here on it cannot be read.
    storeAnswers({ status: 503 });
    clock.value = END + 10;

    expect(await packs()).toEqual({ packs: HELD, checked_at: NOW });
    expect(await register()).toMatchObject({ account_id: "acc_1", tier: "hosted", packs: HELD });
    expect(await patch()).toMatchObject({ account_id: "acc_1", tier: "hosted", packs: HELD });
    expect(await refresh()).toEqual({ confirmed: false, checked_at: NOW, tier: "hosted", caps: CAPS, packs: HELD });
    // And after the failed read, on every surface again.
    expect(await packs()).toEqual({ packs: HELD, checked_at: NOW });
    expect(await register()).toMatchObject({ packs: HELD });

    // Nothing but the queue moved.
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: END }]);
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", checked_at: NOW, applied_seq: 1 });
    expect(queue(db)).toEqual([{ app_user_id: "acc_1", due_at: END + 10 + 60, attempts: 1, dirty: 0 }]);
  });

  it("is still listed when a network error is what failed the read", async () => {
    const { clock, storeAnswers, packs, refresh } = await paying();
    storeAnswers(new Error("connect ETIMEDOUT"));
    clock.value = END + 10;

    expect(await refresh()).toMatchObject({ confirmed: false, packs: HELD });
    expect(await packs()).toEqual({ packs: HELD, checked_at: NOW });
  });

  it("is still listed after the retries fail at 1, 5, 15 and 60 minutes and the daily read fails too", async () => {
    const { db, clock, store, reads, storeAnswers, register, packs } = await paying();
    storeAnswers({ status: 503 });
    clock.value = END + 10;
    const before = store.customers.length;

    // The read an expiry event asks for, then the four retries.
    reads.enqueue("acc_1");
    await reads.scan();
    for (const wait of [60, 300, 900, 3_600]) {
      expect(queue(db)).toMatchObject([{ app_user_id: "acc_1", due_at: clock.value + wait }]);
      clock.value += wait;
      await reads.scan();
      expect(await packs()).toEqual({ packs: HELD, checked_at: NOW });
    }
    expect(store.customers.length).toBe(before + 5);
    // The retries are used up and nothing is queued.
    expect(queue(db)).toEqual([]);

    // A day on, the daily read of every known customer fails as well.
    clock.value += 86_400;
    expect(await reads.read("acc_1", "sweep")).toEqual({ ok: false });

    expect(await packs()).toEqual({ packs: HELD, checked_at: NOW });
    expect(await register()).toMatchObject({ tier: "hosted", packs: HELD });
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: END }]);
  });

  it("is gone once a read succeeds and the store no longer lists the entitlement", async () => {
    const { db, clock, storeAnswers, register, packs, refresh } = await paying();
    storeAnswers({ status: 503 });
    clock.value = END + 10;
    expect(await refresh()).toMatchObject({ confirmed: false, packs: HELD });

    // The store answers again. The tier is still paid for, the pack is not.
    storeAnswers(listing(entitlement("ent_hosted", RENEWED * 1_000)));
    clock.value = END + 20;

    expect(await refresh()).toEqual({ confirmed: true, checked_at: END + 20, tier: "hosted", caps: CAPS, packs: [] });
    expect(await packs()).toEqual({ packs: [], checked_at: END + 20 });
    expect(await register()).toMatchObject({ tier: "hosted", packs: [] });
    expect(storedPacks(db)).toEqual([]);
    expect(queue(db)).toEqual([]);
  });

  it("gets its new end date when a read succeeds and the store lists the renewal", async () => {
    const { db, clock, storeAnswers, register, packs, refresh } = await paying();
    storeAnswers({ status: 503 });
    clock.value = END + 10;
    expect(await refresh()).toMatchObject({ confirmed: false, packs: HELD });

    storeAnswers(listing(entitlement("ent_hosted", RENEWED * 1_000), entitlement("ent_pack", RENEWED * 1_000)));
    clock.value = END + 20;

    const renewed = [{ id: "pro", expires_at: RENEWED }];
    expect(await refresh()).toEqual({ confirmed: true, checked_at: END + 20, tier: "hosted", caps: CAPS, packs: renewed });
    expect(await packs()).toEqual({ packs: renewed, checked_at: END + 20 });
    expect(await register()).toMatchObject({ packs: renewed });
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: RENEWED }]);
  });

  it("is not removed by a store that answers 404 for the customer, because that read counts as failed", async () => {
    const { db, clock, storeAnswers, packs, refresh } = await paying();
    storeAnswers({ status: 404 });
    clock.value = END + 10;

    expect(await refresh()).toMatchObject({ confirmed: false, tier: "hosted", packs: HELD });
    expect(await packs()).toEqual({ packs: HELD, checked_at: NOW });
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: END }]);
  });
});

describe("an operator grant", () => {
  it("ends on its date on every surface, with no read of the store", async () => {
    const { db, clock, store, reads, storeAnswers, register, patch, packs } = await paying();
    // The store pack goes first, by a read, so only the grant is left.
    storeAnswers(listing(entitlement("ent_hosted")));
    expect(await reads.read("acc_1", "sweep")).toEqual({ ok: true });
    db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', ?, 'test', 1)").run(NOW + 500);
    const granted = [{ id: "pro", expires_at: NOW + 500 }];
    const readsSoFar = store.customers.length;

    clock.value = NOW + 499;
    expect(await packs()).toEqual({ packs: granted, checked_at: NOW });
    expect(await register()).toMatchObject({ packs: granted });

    clock.value = NOW + 500;
    expect(await packs()).toEqual({ packs: [], checked_at: NOW });
    expect(await register()).toMatchObject({ packs: [] });
    expect(await patch()).toMatchObject({ packs: [] });
    expect(store.customers.length).toBe(readsSoFar);
  });
});
