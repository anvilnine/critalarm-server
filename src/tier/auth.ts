import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountContext, Tier } from "./types.js";

type DeviceRow = { id: string; account_id: string; device_token_hash: string };
type AccountRow = { id: string; tier: Tier; join_token_hash: string };

export function credentialHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerFromHeader(header: string | undefined): string | undefined {
  const match = /^Bearer (dv_[A-Za-z0-9_-]+)$/.exec(header ?? "");
  return match?.[1];
}

// api.md §4.2. aj_ authorises one thing: attaching a new device to the account
// that minted it. It is account-scoped, so there is no device to resolve here.
export function joinBearerFromHeader(header: string | undefined): string | undefined {
  const match = /^Bearer (aj_[A-Za-z0-9_-]+)$/.exec(header ?? "");
  return match?.[1];
}

export function authenticateAccountJoin(db: Database.Database, bearer: string | undefined): { accountId: string; tier: Tier } | null {
  if (bearer === undefined || !/^aj_[A-Za-z0-9_-]+$/.test(bearer)) return null;
  const hash = credentialHash(bearer);
  const row = db.prepare("SELECT id, tier, join_token_hash FROM accounts WHERE join_token_hash = ?").get(hash) as AccountRow | undefined;
  if (row === undefined) return null;
  const supplied = Buffer.from(hash, "hex");
  const stored = Buffer.from(row.join_token_hash, "hex");
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return null;
  return { accountId: row.id, tier: row.tier };
}

export function authenticateDevice(db: Database.Database, bearer: string | undefined): AccountContext | null {
  if (bearer === undefined || !/^dv_[A-Za-z0-9_-]+$/.test(bearer)) return null;
  const hash = credentialHash(bearer);
  const row = db.prepare("SELECT id, account_id, device_token_hash FROM devices WHERE device_token_hash = ?").get(hash) as DeviceRow | undefined;
  if (row === undefined) return null;
  const supplied = Buffer.from(hash, "hex");
  const stored = Buffer.from(row.device_token_hash, "hex");
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return null;
  return { accountId: row.account_id, deviceId: row.id };
}
