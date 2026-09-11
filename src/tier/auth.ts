import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountContext } from "./types.js";

type DeviceRow = { id: string; account_id: string; device_token_hash: string };

export function credentialHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerFromHeader(header: string | undefined): string | undefined {
  const match = /^Bearer (dv_[A-Za-z0-9_-]+)$/.exec(header ?? "");
  return match?.[1];
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
