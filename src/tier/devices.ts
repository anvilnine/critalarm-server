import { z } from "zod";
import { authenticateDevice, credentialHash } from "./auth.js";
import { setAlarmToken } from "./device-tokens.js";
import { capsFor } from "./caps.js";
import { sweepDeviceIntoTopics } from "./subscriptions.js";
import type { AccountContext, TierDependencies } from "./types.js";

const deviceId = z.string().regex(/^dev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const registrationSchema = z.object({
  device_id: deviceId,
  platform: z.enum(["ios", "android"]),
  push_token: z.string().min(1),
  app_version: z.string().min(1),
});
export const deviceUpdateSchema = z.object({
  push_token: z.string().min(1),
  app_version: z.string().min(1),
});
export const subscriptionSchema = z.object({
  topic_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

type DeviceAccountRow = { account_id: string; tier: "free" | "relay" | "hosted" };

export class CapError extends Error {
  constructor(readonly cap: "devices" | "p4_daily") {
    super("cap");
  }
}

export function accountForContext(deps: TierDependencies, context: AccountContext): DeviceAccountRow | null {
  const account = deps.db.prepare("SELECT devices.account_id, accounts.tier FROM devices JOIN accounts ON accounts.id = devices.account_id WHERE devices.id = ? AND devices.account_id = ?").get(context.deviceId, context.accountId) as DeviceAccountRow | undefined;
  return account ?? null;
}

function insertDeviceForAccount(deps: TierDependencies, input: z.infer<typeof registrationSchema>, accountId: string, tier: "free" | "relay" | "hosted"): string {
  const count = deps.db.prepare("SELECT COUNT(*) AS count FROM devices WHERE account_id = ?").get(accountId) as { count: number };
  if (count.count >= capsFor(tier).devices) throw new CapError("devices");
  const token = deps.ids.deviceToken();
  deps.db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, app_version, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.device_id, accountId, credentialHash(token), input.platform, input.push_token, input.app_version, deps.clock.now());
  setAlarmToken(deps.db, deps.clock, input.device_id, input.platform, input.push_token);
  sweepDeviceIntoTopics(deps.db, accountId, input.device_id);
  return token;
}

export function registerDevice(deps: TierDependencies, input: z.infer<typeof registrationSchema>, bearer: string | undefined, accountContext?: AccountContext): { deviceToken?: string; accountId: string; tier: "free" | "relay" | "hosted" } {
  const existing = deps.db.prepare("SELECT id FROM devices WHERE id = ?").get(input.device_id) as { id: string } | undefined;
  if (existing !== undefined) {
    const account = updateDevice(deps, input.device_id, input, bearer, input.platform);
    if (account === null) throw new Error("unauthorized");
    return { accountId: account.account_id, tier: account.tier };
  }

  if (accountContext !== undefined) {
    return deps.db.transaction(() => {
      const account = accountForContext(deps, accountContext);
      if (account === null) throw new Error("unauthorized");
      return { deviceToken: insertDeviceForAccount(deps, input, account.account_id, account.tier), accountId: account.account_id, tier: account.tier };
    })();
  }

  const accountId = deps.ids.account();
  const now = deps.clock.now();
  const token = deps.db.transaction(() => {
    deps.db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', ?)").run(accountId, now);
    return insertDeviceForAccount(deps, input, accountId, "free");
  })();
  return { deviceToken: token, accountId, tier: "free" };
}

export function updateDevice(deps: TierDependencies, deviceIdValue: string, input: z.infer<typeof deviceUpdateSchema>, bearer: string | undefined, platform?: "ios" | "android"): DeviceAccountRow | null {
  const context = authenticateDevice(deps.db, bearer);
  if (context === null) return null;
  if (context.deviceId !== deviceIdValue) return null;
  deps.db.prepare("UPDATE devices SET push_token = ?, app_version = ?, last_seen = ?, platform = COALESCE(?, platform) WHERE id = ?").run(input.push_token, input.app_version, deps.clock.now(), platform ?? null, deviceIdValue);
  const device = deps.db.prepare("SELECT platform FROM devices WHERE id = ?").get(deviceIdValue) as { platform: "ios" | "android" } | undefined;
  if (device !== undefined) setAlarmToken(deps.db, deps.clock, deviceIdValue, device.platform, input.push_token);
  return accountForContext(deps, context);
}

export function subscribeDevice(deps: TierDependencies, context: AccountContext, topicHash: string): void {
  const account = accountForContext(deps, context);
  if (account === null) throw new Error("not found");
  const existing = deps.db.prepare("SELECT 1 FROM subscriptions WHERE device_id = ? AND topic_hash = ?").get(context.deviceId, topicHash);
  if (existing !== undefined) return;
  deps.db.prepare("INSERT INTO subscriptions (account_id, device_id, topic_hash) VALUES (?, ?, ?)").run(context.accountId, context.deviceId, topicHash);
}

export function unsubscribeDevice(deps: TierDependencies, context: AccountContext, topicHash: string): void {
  deps.db.prepare("DELETE FROM subscriptions WHERE account_id = ? AND device_id = ? AND topic_hash = ?").run(context.accountId, context.deviceId, topicHash);
}
