import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReads } from "../../tier/billing-reads.js";
import { api, entitlement, linkBillingId, listing, queue, scriptedFetch, tierOf, type Answer } from "../../tier/__tests__/store-fakes.js";
import { roundAfter } from "../schedule.js";
import { DAY, HOUR, T0, addAccount, addDevice, setup } from "./fakes.js";

// api.md §4.3 and §4.5 together: "The tier is the one §4.3 last wrote. A
// store read that fails lowers no tier, and a payment that is being retried is
// not an expiry, so neither stops a check."
//
// No test here writes the tier itself. The account starts on free, and every
// change of tier is made by the relay's own billing code: a store read, or an
// event on the webhook. The check then reads what that code left behind.

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

// The subscription's end date as the store last reported it, two hours into
// the first round.
const END = T0 + 2 * HOUR;
const N1 = roundAfter("dev_a", T0);
const revenueCat = { sharedSecret: "revenuecat-secret", entitlements: api.entitlements };

// A relay that reads the store. One device, on an account whose hosted tier
// was written by a read that worked, enrolled after that.
async function hostedByPurchase() {
  let answer: Answer | Error = listing(entitlement("ent_hosted", END * 1_000));
  const store = scriptedFetch(() => answer);
  let made: BillingReads | undefined;
  const harness = setup({
    config: { revenueCat },
    storeReads: (db, clock) => {
      made = new BillingReads({ db, clock, fetch: store.fetch, api, requestGapMs: 0 });
      return { mode: "on", reads: made };
    },
  });
  const reads = made;
  if (reads === undefined) throw new Error("the harness built no store reads");
  addAccount(harness.db, "acc_1", { tier: "free" });
  addDevice(harness.db, "dev_a", "acc_1");
  linkBillingId(harness.db, "acc_1", "acc_1");
  expect((await harness.api.enable("dev_a")).status).toBe(403);
  expect(await reads.read("acc_1", "webhook")).toEqual({ ok: true });
  expect(tierOf(harness.db, "acc_1")).toBe("hosted");
  expect((await harness.api.enable("dev_a")).status).toBe(200);

  let eventNumber = 0;
  // An event on the webhook, and the read it triggers.
  const deliver = async (event: Record<string, unknown>) => {
    eventNumber += 1;
    const response = await harness.app.request("/webhooks/revenuecat", {
      method: "POST",
      headers: { Authorization: "Bearer revenuecat-secret", "content-type": "application/json" },
      body: JSON.stringify({ api_version: "1.0", event: { id: `evt_${eventNumber}`, app_user_id: "acc_1", event_timestamp_ms: (harness.clock.now() + eventNumber) * 1_000, ...event } }),
    });
    expect(response.status).toBe(200);
    await reads.scan();
  };
  return { harness, reads, store, deliver, storeAnswers: (next: Answer | Error) => { answer = next; } };
}

const attemptsSent = (harness: ReturnType<typeof setup>) => harness.sender.sent.map((sent) => sent.push.attempt);

describe("the weekly check while the store cannot be read", () => {
  it("goes on being sent through a failed read, its four retries and a failed daily read, past the saved end date", async () => {
    const { harness, reads, store, storeAnswers } = await hostedByPurchase();
    await harness.scanAt(T0);
    expect(attemptsSent(harness)).toEqual([1]);

    // The store stops answering before the subscription's end date. The read
    // an expiry event asks for fails, and so do the retries at 1, 5, 15 and
    // 60 minutes.
    storeAnswers({ status: 503 });
    harness.clock.value = END + 1;
    const before = store.customers.length;
    reads.enqueue("acc_1");
    await reads.scan();
    for (const wait of [60, 300, 900, 3_600]) {
      harness.clock.value += wait;
      await reads.scan();
    }
    expect(store.customers.length).toBe(before + 5);
    expect(queue(harness.db)).toEqual([]);
    expect(tierOf(harness.db, "acc_1")).toBe("hosted");
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "waiting", reason: null });

    // The second and third pushes of the round still go out, with the daily
    // read failing between them.
    await harness.scanAt(T0 + 6 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);
    expect(await reads.read("acc_1", "sweep")).toEqual({ ok: false });
    await harness.scanAt(T0 + 18 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2, 3]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ opened_at: T0, attempts: 3, result: null, reason: null, closed_at: null }]);

    // And the next round opens on its day, a week of failed reads later.
    await harness.scanAt(T0 + DAY);
    for (let time = T0 + 2 * DAY; time < N1; time += DAY) {
      harness.clock.value = time;
      expect(await reads.read("acc_1", "sweep")).toEqual({ ok: false });
    }
    await harness.scanAt(N1);
    expect(attemptsSent(harness)).toEqual([1, 2, 3, 1]);
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, reason: null, misses: 1 });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_rounds WHERE reason = 'tier'").get()).toEqual({ n: 0 });
  });

  it("is not stopped by a network error, by a body that is not a list, or by a store that says it does not know a paying customer", async () => {
    const failures: (Answer | Error)[] = [new Error("connect ETIMEDOUT"), { status: 200, body: { nonsense: true } }, { status: 404 }, { status: 500 }];
    for (const failure of failures) {
      const { harness, reads, storeAnswers } = await hostedByPurchase();
      await harness.scanAt(T0);
      storeAnswers(failure);
      harness.clock.value = END + 1;
      expect(await reads.read("acc_1", "refresh")).toEqual({ ok: false });
      expect(tierOf(harness.db, "acc_1")).toBe("hosted");

      await harness.scanAt(T0 + 6 * HOUR);

      expect(attemptsSent(harness)).toEqual([1, 2]);
      expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 2, result: null, reason: null }]);
    }
  });

  it("enabling is not refused while reads fail past the end date", async () => {
    const { harness, reads, storeAnswers } = await hostedByPurchase();
    await harness.api.disable("dev_a");
    storeAnswers({ status: 503 });
    harness.clock.value = END + 1;
    expect(await reads.read("acc_1", "refresh")).toEqual({ ok: false });
    expect((await harness.api.enable("dev_a")).status).toBe(200);
  });

  it("the read that fails between planning a push and sending it stops nothing either", async () => {
    const { harness, reads, storeAnswers } = await hostedByPurchase();
    storeAnswers({ status: 503 });
    // Runs where a real sender fetches its provider token: after the tier was
    // read for the push coming due, before it is read again for the send.
    harness.sender.before = async () => { expect(await reads.read("acc_1", "webhook")).toEqual({ ok: false }); };
    await harness.scanAt(END + 1);
    expect(attemptsSent(harness)).toEqual([1]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: null }]);
  });
});

describe("the weekly check while a payment is being retried", () => {
  it("goes on being sent: the store still lists the entitlement, with an end date that has passed", async () => {
    const { harness, deliver, storeAnswers } = await hostedByPurchase();
    await harness.scanAt(T0);

    // The card failed at the renewal. The store keeps the entitlement on the
    // list while it retries, and its expiry is behind the relay's clock.
    storeAnswers(listing(entitlement("ent_hosted", END * 1_000)));
    harness.clock.value = END + HOUR;
    await deliver({ type: "BILLING_ISSUE", entitlement_ids: ["ent_hosted"], expiration_at_ms: END * 1_000, grace_period_expiration_at_ms: (END + 16 * DAY) * 1_000 });
    expect(tierOf(harness.db, "acc_1")).toBe("hosted");

    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2, 3]);
    await harness.scanAt(T0 + DAY);
    await harness.scanAt(N1);
    expect(attemptsSent(harness)).toEqual([1, 2, 3, 1]);
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, reason: null });
  });

  it("on a relay that does not read the store, an event that only reports a payment problem stops nothing", async () => {
    const harness = setup({ config: { revenueCat } });
    addAccount(harness.db, "acc_1", { tier: "free" });
    addDevice(harness.db, "dev_a", "acc_1");
    let eventNumber = 0;
    const deliver = async (event: Record<string, unknown>) => {
      eventNumber += 1;
      const response = await harness.app.request("/webhooks/revenuecat", {
        method: "POST",
        headers: { Authorization: "Bearer revenuecat-secret", "content-type": "application/json" },
        body: JSON.stringify({ api_version: "1.0", event: { id: `evt_${eventNumber}`, app_user_id: "acc_1", event_timestamp_ms: (harness.clock.now() + eventNumber) * 1_000, ...event } }),
      });
      expect(response.status).toBe(200);
    };
    await deliver({ type: "INITIAL_PURCHASE", entitlement_ids: ["ent_hosted"], expiration_at_ms: (T0 + 30 * DAY) * 1_000 });
    expect(tierOf(harness.db, "acc_1")).toBe("hosted");
    expect((await harness.api.enable("dev_a")).status).toBe(200);
    await harness.scanAt(T0);

    harness.clock.value = T0 + HOUR;
    await deliver({ type: "BILLING_ISSUE", entitlement_ids: ["ent_hosted"], expiration_at_ms: (T0 + 30 * DAY) * 1_000 });
    expect(tierOf(harness.db, "acc_1")).toBe("hosted");
    await harness.scanAt(T0 + 6 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);

    // The expiry itself is what ends it.
    harness.clock.value = T0 + 7 * HOUR;
    await deliver({ type: "EXPIRATION", entitlement_ids: ["ent_hosted"], expiration_at_ms: (T0 + 7 * HOUR) * 1_000 });
    expect(tierOf(harness.db, "acc_1")).toBe("free");
    await harness.scanAt(T0 + 18 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 2, result: "skipped", reason: "tier", closed_at: T0 + 18 * HOUR }]);
  });
});

describe("the weekly check when a read that works says the subscription is gone", () => {
  it("stops at the next push that comes due, and goes on with no new PUT when a read lists it again", async () => {
    const { harness, reads, deliver, storeAnswers } = await hostedByPurchase();
    await harness.scanAt(T0);
    // Failed reads first: nothing changes.
    storeAnswers({ status: 503 });
    harness.clock.value = END + 1;
    expect(await reads.read("acc_1", "webhook")).toEqual({ ok: false });
    await harness.scanAt(T0 + 6 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);

    // The store answers again and no longer lists the entitlement.
    storeAnswers(listing());
    harness.clock.value = T0 + 7 * HOUR;
    await deliver({ type: "EXPIRATION", entitlement_ids: ["ent_hosted"], expiration_at_ms: END * 1_000 });
    expect(tierOf(harness.db, "acc_1")).toBe("free");
    // Still enrolled, and the open round is not closed by the read.
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "tier", misses: 0, last_sent_at: T0 + 6 * HOUR });
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 2, result: null, closed_at: null }]);

    await harness.scanAt(T0 + 18 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 2, result: "skipped", reason: "tier", closed_at: T0 + 18 * HOUR }]);
    expect((await harness.api.enable("dev_a")).status).toBe(403);

    // The round due while lapsed is written as skipped.
    await harness.scanAt(N1);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ opened_at: N1, attempts: 0, result: "skipped", reason: "tier" });

    // The customer pays again. The read raises the tier and nothing else is
    // asked of the device.
    storeAnswers(listing(entitlement("ent_hosted", (N1 + 30 * DAY) * 1_000)));
    harness.clock.value = N1 + DAY;
    await deliver({ type: "RENEWAL", entitlement_ids: ["ent_hosted"], expiration_at_ms: (N1 + 30 * DAY) * 1_000 });
    expect(tierOf(harness.db, "acc_1")).toBe("hosted");
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, reason: null, next_due_at: N1 + 7 * DAY });

    await harness.scanAt(N1 + 7 * DAY);
    expect(attemptsSent(harness)).toEqual([1, 2, 1]);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ opened_at: N1 + 7 * DAY, attempts: 1, result: null });
  });

  it("an expiry of the pro pack does not stop the check of a hosted account", async () => {
    const { harness, deliver, storeAnswers } = await hostedByPurchase();
    storeAnswers(listing(entitlement("ent_hosted", END * 1_000), entitlement("ent_pack", END * 1_000)));
    await deliver({ type: "INITIAL_PURCHASE", entitlement_ids: ["ent_pack"], expiration_at_ms: END * 1_000 });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM billing_packs").get()).toEqual({ n: 1 });
    await harness.scanAt(T0);

    storeAnswers(listing(entitlement("ent_hosted", (T0 + 30 * DAY) * 1_000)));
    harness.clock.value = END + 1;
    await deliver({ type: "EXPIRATION", entitlement_ids: ["ent_pack"], expiration_at_ms: END * 1_000 });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM billing_packs").get()).toEqual({ n: 0 });

    await harness.scanAt(T0 + 6 * HOUR);
    expect(attemptsSent(harness)).toEqual([1, 2]);
  });

  it("a pack the store still lists gets a lapsed account no check", async () => {
    const { harness, deliver, storeAnswers } = await hostedByPurchase();
    await harness.scanAt(T0);
    storeAnswers(listing(entitlement("ent_pack", null)));
    harness.clock.value = END + 1;
    await deliver({ type: "EXPIRATION", entitlement_ids: ["ent_hosted"], expiration_at_ms: END * 1_000 });
    expect(tierOf(harness.db, "acc_1")).toBe("free");
    expect(harness.db.prepare("SELECT pack FROM billing_packs").all()).toEqual([{ pack: "pro" }]);

    await harness.scanAt(T0 + 6 * HOUR);
    expect(attemptsSent(harness)).toEqual([1]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ result: "skipped", reason: "tier" }]);
  });
});
