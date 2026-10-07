import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { Clock } from "../incident/types.js";
import type { ApnsTransport } from "../push/apns.js";
import { ApnsCheckSender, FcmCheckSender } from "../push/check.js";
import type { PushFetch, PushSender } from "../push/types.js";
import { notingAlarmPushes } from "./device-hooks.js";
import { CheckScheduler, startCheckScheduler, type CheckSenders } from "./scheduler.js";
import { CheckStore } from "./store.js";

// api.md §4.5. Whether this process sends weekly checks, and the pieces it
// needs when it does. A relay or a hosted server sends them unless
// WEEKLY_CHECKS=off. A self-hosted server never does: it holds no accounts and
// no packs, and its phones are checked by the relay they registered with.

export interface Checks {
  // False means nothing below does anything.
  readonly enabled: boolean;
  readonly scheduler?: CheckScheduler;
  // Wraps an alarm sender so the scan can tell when an alarm last went to a
  // device. With checks off it returns the sender it was given.
  noting(sender: PushSender): PushSender;
  // Starts the scan. Returns the function that stops it.
  start(intervalMs?: number): () => void;
}

export interface ChecksDependencies {
  db: Database.Database;
  clock: Clock;
  fetch: PushFetch;
  // The seam the tests replace.
  apnsTransport?: (authority: string) => ApnsTransport;
}

export function checksEnabled(config: Config): boolean {
  return (config.mode === "relay" || config.mode === "hosted") && config.weeklyChecks !== false;
}

export function createChecks(config: Config, deps: ChecksDependencies): Checks {
  if (!checksEnabled(config)) return { enabled: false, noting: (sender) => sender, start: () => () => {} };
  const apns = config.apns === undefined ? undefined : new ApnsCheckSender({ ...config.apns, clock: deps.clock, ...(deps.apnsTransport === undefined ? {} : { transport: deps.apnsTransport }) });
  const senders: CheckSenders = {
    ...(apns === undefined ? {} : { ios: apns }),
    ...(config.fcm === undefined ? {} : { android: new FcmCheckSender({ ...config.fcm, clock: deps.clock, fetch: deps.fetch }) }),
  };
  const store = new CheckStore(deps.db, deps.clock, undefined, config.packIncludes ?? {});
  const scheduler = new CheckScheduler(store, senders);
  return {
    enabled: true,
    scheduler,
    noting: (sender) => notingAlarmPushes(sender, deps.db, deps.clock),
    start: (intervalMs) => {
      const stop = startCheckScheduler(scheduler, intervalMs);
      return () => {
        stop();
        apns?.close();
      };
    },
  };
}
