import type Database from "better-sqlite3";
import type { Config, ReadsSetting } from "../config.js";
import type { Clock } from "../incident/types.js";
import { BillingReads, DEFAULT_REQUEST_GAP_MS } from "./billing-reads.js";
import { ShadowReads } from "./billing-shadow.js";
import type { StoreReadConfig } from "./entitlement-read.js";
import { reconcileAccount, reconcileAll, startReconcileSweep, type ReconcileDependencies } from "./reconcile.js";
import type { StoreReads } from "./types.js";

// api.md §4.3, "A relay that does not read the store". Reading needs two
// things: the RevenueCat API key and the REVENUECAT_READS setting. This file is
// the one place that turns those two into which path runs.
//
//   key missing            off, whatever the setting says
//   key set, off or unset  off: events are applied to the tier directly and
//                          the reconcile sweep runs as it always has
//   key set, shadow        the same writes as off, plus a logged read beside
//                          each one
//   key set, on            the fenced read is the only writer

export function readsMode(config: Config): ReadsSetting {
  if (config.revenueCatApi === undefined) return "off";
  return config.revenueCatReads ?? "off";
}

// One warning, for a relay or a hosted server that has no key. A self-hosted
// server mounts no billing route and will never have a key, so it is told
// nothing.
export function readsWarning(config: Config): { asked: ReadsSetting; reason: string } | undefined {
  if ((config.mode ?? "relay") === "selfhosted") return undefined;
  if (config.revenueCatApi !== undefined) return undefined;
  return { asked: config.revenueCatReads ?? "off", reason: "REVENUECAT_SECRET_API_KEY is not set, so the store is not read and no purchase gives or removes a pack" };
}

export interface BillingOptions {
  db: Database.Database;
  clock: Clock;
  fetch: typeof globalThis.fetch;
  warn?: (message: string, detail: Record<string, unknown>) => void;
  requestGapMs?: number;
  readTimeoutMs?: number;
}

export interface Billing {
  mode: ReadsSetting;
  // What the tier router needs. Absent when the store is not read.
  storeReads?: StoreReads;
  // Starts the daily read and, with reading on, the scan of queued reads.
  // Returns the function that stops both.
  start(): () => void;
  // One pass over every linked customer, on whichever path is switched on.
  sweep(): Promise<void>;
  // A merge has just given this account billing ids it did not hold.
  afterMerge(accountId: string): Promise<void>;
}

// Daily, the same as the reconcile sweep.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
// How often the queue is looked at for a retry that has come due. A webhook
// does not wait for this: it wakes the scan itself.
const SCAN_INTERVAL_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export function createBilling(config: Config, options: BillingOptions): Billing {
  const { db, clock, fetch } = options;
  const warning = readsWarning(config);
  if (warning !== undefined) (options.warn ?? ((message, detail) => { console.warn(message, detail); }))("revenuecat_reads_off", warning);

  const mode = readsMode(config);
  const gap = options.requestGapMs ?? DEFAULT_REQUEST_GAP_MS;
  // The reconcile sweep's own dependencies, built exactly as main.ts built
  // them before this file existed.
  const reconcile: ReconcileDependencies = {
    db,
    clock,
    fetch,
    ...(config.revenueCatApi === undefined ? {} : { revenueCatApi: config.revenueCatApi }),
    ...(options.requestGapMs === undefined ? {} : { requestGapMs: options.requestGapMs }),
  };

  if (mode === "off" || config.revenueCatApi === undefined) {
    return {
      mode: "off",
      start: () => startReconcileSweep(reconcile),
      sweep: () => reconcileAll(reconcile),
      afterMerge: (accountId) => reconcileAccount(reconcile, accountId),
    };
  }

  const api: StoreReadConfig = { ...config.revenueCatApi, packEntitlements: config.revenueCatPackEntitlements ?? {} };
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const linked = (accountId?: string): string[] => {
    const rows = accountId === undefined
      ? db.prepare("SELECT app_user_id FROM account_billing_ids ORDER BY app_user_id").all()
      : db.prepare("SELECT app_user_id FROM account_billing_ids WHERE account_id = ? ORDER BY app_user_id").all(accountId);
    return (rows as { app_user_id: string }[]).map((row) => row.app_user_id);
  };
  const each = async (appUserIds: string[], read: (appUserId: string) => Promise<unknown>): Promise<void> => {
    for (const [index, appUserId] of appUserIds.entries()) {
      if (index > 0 && gap > 0) await sleep(gap);
      await read(appUserId);
    }
  };
  const daily = (run: () => Promise<void>): () => void => {
    const guarded = () => { void run().catch((error: unknown) => { console.error("revenuecat daily read failed", error); }); };
    guarded();
    const timer = setInterval(guarded, SWEEP_INTERVAL_MS);
    return () => { clearInterval(timer); };
  };

  if (mode === "shadow") {
    const shadow = new ShadowReads({ db, clock, fetch, api, readTimeoutMs });
    // The reconcile sweep first, untouched, so every write is the one it would
    // have made. Then one logged read for each customer.
    const sweep = async () => {
      await reconcileAll(reconcile);
      await each(linked(), (appUserId) => shadow.read(appUserId, "sweep"));
    };
    return {
      mode,
      storeReads: { mode, shadow },
      start: () => daily(sweep),
      sweep,
      afterMerge: async (accountId) => {
        await reconcileAccount(reconcile, accountId);
        await each(linked(accountId), (appUserId) => shadow.read(appUserId, "sweep"));
      },
    };
  }

  const reads = new BillingReads({ db, clock, fetch, api, requestGapMs: gap, readTimeoutMs });
  const sweep = () => each(linked(), (appUserId) => reads.read(appUserId, "sweep"));
  return {
    mode,
    storeReads: { mode, reads },
    start: () => {
      // Whatever a process that died left queued runs first.
      reads.wake();
      const scanner = setInterval(() => { reads.wake(); }, SCAN_INTERVAL_MS);
      const stopDaily = daily(sweep);
      return () => { clearInterval(scanner); stopDaily(); };
    },
    sweep,
    afterMerge: (accountId) => each(linked(accountId), (appUserId) => reads.read(appUserId, "sweep")),
  };
}
