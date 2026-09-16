import { z } from "zod";
import { authenticateAccountJoin, authenticateDevice, credentialHash } from "./auth.js";
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

export function registerDevice(deps: TierDependencies, input: z.infer<typeof registrationSchema>, bearer: string | undefined, accountContext?: AccountContext, joinBearer?: string): { deviceToken?: string; accountJoinToken?: string; accountId: string; tier: "free" | "relay" | "hosted" } {
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

  // api.md §4.2, joining an account that already exists. No account_join_token
  // comes back: the caller is holding the one it just presented.
  if (joinBearer !== undefined) {
    return deps.db.transaction(() => {
      const account = authenticateAccountJoin(deps.db, joinBearer);
      if (account === null) throw new Error("unauthorized");
      return { deviceToken: insertDeviceForAccount(deps, input, account.accountId, account.tier), accountId: account.accountId, tier: account.tier };
    })();
  }

  const accountId = deps.ids.account();
  const joinToken = deps.ids.accountJoinToken();
  const now = deps.clock.now();
  const token = deps.db.transaction(() => {
    deps.db.prepare("INSERT INTO accounts (id, tier, join_token_hash, created_at) VALUES (?, 'free', ?, ?)").run(accountId, credentialHash(joinToken), now);
    return insertDeviceForAccount(deps, input, accountId, "free");
  })();
  return { deviceToken: token, accountJoinToken: joinToken, accountId, tier: "free" };
}

// api.md §4.2, releasing a device. The account, its topics and its tk_ tokens
// stay, even when this was the last device, so the account is still joinable
// with aj_. device_tokens.incident_id is not a foreign key and nothing else
// sweeps those rows, so they go here.
export function deleteDevice(deps: TierDependencies, deviceIdValue: string): void {
  deps.db.transaction(() => {
    deps.db.prepare("DELETE FROM device_tokens WHERE device_id = ?").run(deviceIdValue);
    deps.db.prepare("DELETE FROM subscriptions WHERE device_id = ?").run(deviceIdValue);
    deps.db.prepare("DELETE FROM devices WHERE id = ?").run(deviceIdValue);
  })();
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
  deps.db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES (?, ?)").run(context.deviceId, topicHash);
}

// The account comes from the device row, not from a copy on the subscription, so
// a device whose account changed in a merge still deletes its own row. The old
// filter matched a stale account_id, deleted nothing, and the route still
// answered 204.
export function unsubscribeDevice(deps: TierDependencies, context: AccountContext, topicHash: string): void {
  deps.db.prepare("DELETE FROM subscriptions WHERE device_id = ? AND topic_hash = ? AND EXISTS (SELECT 1 FROM devices d WHERE d.id = subscriptions.device_id AND d.account_id = ?)").run(context.deviceId, topicHash, context.accountId);
}
