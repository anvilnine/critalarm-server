import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { Clock } from "../incident/types.js";

export type Tier = "free" | "relay" | "hosted";

export interface AccountContext {
  accountId: string;
  deviceId: string;
}

export interface Caps {
  devices: number;
  critical_topics: number | null;
  p4_daily: number;
  history_incidents: number | null;
  history_days: number;
}

export interface TierIds {
  account(): string;
  deviceToken(): string;
}

export interface RevenueCatConfig {
  sharedSecret: string;
  entitlements: Record<string, Tier>;
}

export interface TierDependencies {
  db: Database.Database;
  clock: Clock;
  ids: TierIds;
  revenueCat: RevenueCatConfig;
}

export type TierRouter = Hono;
