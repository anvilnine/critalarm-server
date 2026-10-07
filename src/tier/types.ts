import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { Clock } from "../incident/types.js";
import type { BillingReads } from "./billing-reads.js";
import type { ShadowReads } from "./billing-shadow.js";
import type { PackIncludes } from "./packs.js";

export type Tier = "free" | "relay" | "hosted";

export interface AccountContext {
  accountId: string;
  deviceId: string;
}

export interface Caps {
  devices: number;
  critical_topics: number | null;
  p4_daily: number;
  history_days: number;
}

export interface TierIds {
  account(): string;
  deviceToken(): string;
  accountJoinToken(): string;
}

export interface RevenueCatConfig {
  sharedSecret: string;
  entitlements: Record<string, Tier>;
}

export interface TierDependencies {
  db: Database.Database;
  clock: Clock;
  ids: TierIds;
  // Absent when the operator configured no shared secret. The RevenueCat
  // webhook is then not mounted at all, rather than mounted with a secret that
  // an empty Authorization header matches.
  revenueCat?: RevenueCatConfig;
  // api.md §4.3. Absent means the relay does not read the store: every event
  // is applied to the tier directly and no purchase gives or removes a pack.
  storeReads?: StoreReads;
  // Packs the configuration attaches to a tier. Absent means none.
  packIncludes?: PackIncludes;
}

// `on`: the read is the only writer of the tier and the packs, and an event
// only triggers it. `shadow`: every write stays on the event path, and the
// read runs beside it and logs what it would have written.
export type StoreReads =
  | { mode: "on"; reads: BillingReads }
  | { mode: "shadow"; shadow: ShadowReads };

export type TierRouter = Hono;
