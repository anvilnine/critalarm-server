import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { createBilling, readsMode, readsWarning } from "../billing-startup.js";
import { FakeClock, NOW, addAccount, api, billingRow, database, entitlement, linkBillingId, listing, logged, queue, quietLog, scriptedFetch, storedPacks, tierOf, type Answer } from "./store-fakes.js";

let log: ReturnType<typeof quietLog>;
beforeEach(() => { log = quietLog(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const base = { BASE_URL: "https://alerts.example.com", DATA_DIR: "/tmp", ALLOW_NOOP_PUSH: "true" };
const key = { REVENUECAT_SECRET_API_KEY: "sk-fake-not-a-real-key", REVENUECAT_PROJECT_ID: "proj_fake", REVENUECAT_ENTITLEMENTS: "ent_relay=relay,ent_hosted=hosted", REVENUECAT_PACK_ENTITLEMENTS: "ent_pack=pro" };
const settings = [undefined, "off", "shadow", "on"] as const;

function config(extra: NodeJS.ProcessEnv) {
  return loadConfig({ ...base, ...extra });
}

function withSetting(setting: (typeof settings)[number]): NodeJS.ProcessEnv {
  return setting === undefined ? {} : { REVENUECAT_READS: setting };
}

describe("which path runs", () => {
  it("is off whatever the setting says when the API key is missing", () => {
    for (const mode of ["relay", "hosted", "selfhosted"]) {
      for (const setting of settings) expect(readsMode(config({ MODE: mode, ...withSetting(setting) }))).toBe("off");
    }
  });

  it("is the setting when the key is present, and off when the setting is unset", () => {
    expect(readsMode(config({ MODE: "relay", ...key }))).toBe("off");
    expect(readsMode(config({ MODE: "relay", ...key, REVENUECAT_READS: "off" }))).toBe("off");
    expect(readsMode(config({ MODE: "relay", ...key, REVENUECAT_READS: "shadow" }))).toBe("shadow");
    expect(readsMode(config({ MODE: "relay", ...key, REVENUECAT_READS: "on" }))).toBe("on");
  });
});

describe("the startup warning about a missing API key", () => {
  it("is one warning in relay and hosted mode, whatever the setting", () => {
    for (const mode of ["relay", "hosted"]) {
      for (const setting of settings) {
        const warn = vi.fn();
        createBilling(config({ MODE: mode, ...withSetting(setting) }), { db: database(), clock: new FakeClock(), fetch: scriptedFetch(() => ({ status: 500 })).fetch, warn });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("revenuecat_reads_off", { asked: setting ?? "off", reason: "REVENUECAT_SECRET_API_KEY is not set, so the store is not read and no purchase gives or removes a pack" });
      }
    }
  });

  it("is nothing at all in self-hosted mode", () => {
    for (const setting of settings) {
      const warn = vi.fn();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      createBilling(config({ MODE: "selfhosted", ...withSetting(setting) }), { db: database(), clock: new FakeClock(), fetch: scriptedFetch(() => ({ status: 500 })).fetch, warn });
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(readsWarning(config({ MODE: "selfhosted", ...withSetting(setting) }))).toBeUndefined();
    }
  });

  it("is nothing when the key is present", () => {
    for (const setting of settings) expect(readsWarning(config({ MODE: "relay", ...key, ...withSetting(setting) }))).toBeUndefined();
  });
});

function billing(setting: (typeof settings)[number], withKey = true) {
  const db = database();
  addAccount(db, "acc_1", "hosted");
  linkBillingId(db, "acc_1", "acc_1", "hosted");
  const clock = new FakeClock();
  const listed = new Map<string, Answer | Error>();
  const store = scriptedFetch((appUserId) => listed.get(appUserId) ?? { status: 404 });
  const warn = vi.fn();
  const made = createBilling(config({ MODE: "relay", ...(withKey ? key : {}), ...withSetting(setting) }), { db, clock, fetch: store.fetch, warn, requestGapMs: 0 });
  return { db, clock, listed, store, made };
}

describe("createBilling", () => {
  it("hands the router nothing when reading is off, so the event path is the only path", () => {
    expect(billing(undefined).made.storeReads).toBeUndefined();
    expect(billing("off").made.storeReads).toBeUndefined();
    expect(billing("on", false).made.storeReads).toBeUndefined();
    expect(billing("shadow", false).made.storeReads).toBeUndefined();
    expect(billing("shadow").made.storeReads?.mode).toBe("shadow");
    expect(billing("on").made.storeReads?.mode).toBe("on");
  });

  it("with no key starts no timer and sends no request, whatever the setting", () => {
    for (const setting of settings) {
      vi.useFakeTimers();
      const { made, store } = billing(setting, false);
      const before = vi.getTimerCount();
      const stop = made.start();
      expect(vi.getTimerCount()).toBe(before);
      expect(store.customers).toEqual([]);
      stop();
      vi.useRealTimers();
    }
  });

  // An entitlement the tier map does not name is where the two paths differ:
  // the reconcile sweep changes nothing for that customer, and the read path
  // may still raise. That difference is how these tests tell which one ran.
  const raised = () => listing(entitlement("ent_mystery"), entitlement("ent_pack"), entitlement("ent_hosted"));

  it("off: the daily read is the reconcile sweep as it was, and gives no pack", async () => {
    const { db, listed, made, store } = billing("off");
    db.prepare("UPDATE account_billing_ids SET entitled_tier = 'relay' WHERE app_user_id = 'acc_1'").run();
    db.prepare("UPDATE accounts SET tier = 'relay' WHERE id = 'acc_1'").run();
    listed.set("acc_1", raised());

    await made.sweep();

    expect(store.customers).toEqual(["acc_1"]);
    expect(tierOf(db, "acc_1")).toBe("relay");
    expect(storedPacks(db)).toEqual([]);
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "relay", read_seq: 0, applied_seq: 0, checked_at: null });
    expect(logged(log).some((line) => line.event === "reconcile_unknown_entitlement" && line.app_user_id === "acc_1")).toBe(true);
  });

  it("off: the daily read still corrects a tier the way it did, and queues nothing", async () => {
    const { db, listed, made } = billing("off");
    listed.set("acc_1", listing(entitlement("ent_relay")));

    await made.sweep();

    expect(tierOf(db, "acc_1")).toBe("relay");
    expect(storedPacks(db)).toEqual([]);
    expect(queue(db)).toEqual([]);
  });

  it("shadow: the daily read writes what the reconcile sweep writes, then logs a shadow line for every customer", async () => {
    const { db, listed, made, store } = billing("shadow");
    listed.set("acc_1", listing(entitlement("ent_relay"), entitlement("ent_pack")));

    await made.sweep();

    // The reconcile sweep does not know the pack identifier, so it changes
    // nothing here, exactly as it would with reading off.
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([]);
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", read_seq: 0, applied_seq: 0, checked_at: null });
    expect(queue(db)).toEqual([]);
    expect(store.customers).toEqual(["acc_1", "acc_1"]);
    expect(logged(log).filter((line) => line.event === "billing_shadow")).toEqual([{
      event: "billing_shadow", app_user_id: "acc_1", trigger: "sweep", status: 200,
      entitlement_ids: ["ent_relay", "ent_pack"], unknown_ids: [], read_tier: "relay", read_packs: ["pro"], stored_tier: "hosted", agrees: false,
    }]);
  });

  it("on: the daily read goes through the fenced read for every linked customer, and the reconcile sweep does not run", async () => {
    const { db, listed, made, store } = billing("on");
    addAccount(db, "acc_2");
    linkBillingId(db, "rc_2", "acc_2");
    db.prepare("UPDATE account_billing_ids SET entitled_tier = 'relay' WHERE app_user_id = 'acc_1'").run();
    db.prepare("UPDATE accounts SET tier = 'relay' WHERE id = 'acc_1'").run();
    listed.set("acc_1", raised());
    listed.set("rc_2", listing(entitlement("ent_pack")));

    await made.sweep();

    expect(store.customers).toEqual(["acc_1", "rc_2"]);
    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(billingRow(db, "acc_1")).toMatchObject({ entitled_tier: "hosted", read_seq: 1, applied_seq: 1, checked_at: NOW });
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }, { app_user_id: "rc_2", pack: "pro", expires_at: null }]);
    expect(logged(log).some((line) => line.event === "reconcile_unknown_entitlement" || line.event === "tier_drift")).toBe(false);
  });

  it("on: a daily read that fails for everyone lowers nobody", async () => {
    const { db, listed, made } = billing("on");
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('acc_1', 'pro', NULL)").run();
    listed.set("acc_1", { status: 401 });

    await made.sweep();

    expect(tierOf(db, "acc_1")).toBe("hosted");
    expect(storedPacks(db)).toEqual([{ app_user_id: "acc_1", pack: "pro", expires_at: null }]);
  });

  it("on: start runs the queue left by a process that died, and stop clears every timer", async () => {
    vi.useFakeTimers();
    const { db, listed, made, store } = billing("on");
    db.prepare("INSERT INTO billing_reads (app_user_id, due_at, attempts, dirty) VALUES ('acc_1', ?, 0, 0)").run(NOW - 5);
    listed.set("acc_1", listing(entitlement("ent_hosted")));
    const before = vi.getTimerCount();

    const stop = made.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(store.customers.length).toBeGreaterThan(0);
    expect(queue(db)).toEqual([]);
    expect(vi.getTimerCount()).toBeGreaterThan(before);
    stop();
    expect(vi.getTimerCount()).toBe(before);
  });

  it("after a merge, reads the surviving account's customers on the path that is switched on", async () => {
    for (const setting of ["off", "shadow", "on"] as const) {
      const { db, listed, made, store } = billing(setting);
      addAccount(db, "acc_other", "hosted");
      linkBillingId(db, "rc_other", "acc_other", "hosted");
      listed.set("acc_1", listing(entitlement("ent_hosted"), entitlement("ent_pack")));

      await made.afterMerge("acc_1");

      expect(store.customers.every((customer) => customer === "acc_1")).toBe(true);
      expect(store.customers.length).toBeGreaterThan(0);
      expect(storedPacks(db)).toEqual(setting === "on" ? [{ app_user_id: "acc_1", pack: "pro", expires_at: null }] : []);
      expect(tierOf(db, "acc_1")).toBe("hosted");
    }
  });
});
