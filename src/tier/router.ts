import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { authenticateDevice, bearerFromHeader, joinBearerFromHeader } from "./auth.js";
import { capsFor } from "./caps.js";
import { CapError, deleteDevice, deviceUpdateSchema, registerDevice, registrationSchema, subscribeDevice, subscriptionSchema, unsubscribeDevice, updateDevice } from "./devices.js";
import { deleteDeviceTokens, putDeviceToken, tokenKindSchema, tokenSchema } from "./device-tokens.js";
import { applyRevenueCatEvent, parseRevenueCatEvent, resolveAccount } from "./revenuecat.js";
import { bearerSecretMatches } from "../bearer.js";
import { RollingLimit } from "./account-limit.js";
import { packsCheckedAt, packsFor } from "./packs.js";
import { namedCustomers, parseReadTrigger, queueReadsForEvent } from "./revenuecat-trigger.js";
import type { Tier, TierDependencies } from "./types.js";

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new z.ZodError([]);
  }
}

// api.md §4.2, the three sets of customer ids a refresh reads: the caller's own
// account id, every billing id already linked to that account, and the id of
// every account that was merged into it. All three come from the server's own
// rows. Nothing the caller sends chooses a customer.
function refreshIds(deps: TierDependencies, accountId: string): string[] {
  const ids = [accountId];
  const add = (id: string) => { if (!ids.includes(id)) ids.push(id); };
  const linked = deps.db.prepare("SELECT app_user_id FROM account_billing_ids WHERE account_id = ? ORDER BY app_user_id").all(accountId) as { app_user_id: string }[];
  for (const row of linked) add(row.app_user_id);
  // A merge keeps chains one hop long. The bound is here so a cycle written by
  // hand cannot spin forever.
  let frontier = [accountId];
  for (let hop = 0; hop < 8 && frontier.length > 0; hop += 1) {
    const marks = frontier.map(() => "?").join(", ");
    const merged = (deps.db.prepare(`SELECT id FROM accounts WHERE merged_into IN (${marks}) ORDER BY id`).all(...frontier) as { id: string }[]).map((row) => row.id).filter((id) => !ids.includes(id));
    for (const id of merged) add(id);
    frontier = merged;
  }
  return ids;
}

// Whether every one of those ids was read with success in this call. On a
// relay that does not read the store this is always false, and in the shadow
// step it is false too: the read runs and is logged, and nothing it found was
// written, so the answer below does not rest on it.
async function readStoreForAccount(deps: TierDependencies, accountId: string): Promise<boolean> {
  if (deps.storeReads === undefined) return false;
  const ids = refreshIds(deps, accountId);
  if (deps.storeReads.mode === "shadow") {
    for (const id of ids) await deps.storeReads.shadow.read(id, "refresh");
    return false;
  }
  let confirmed = true;
  for (const id of ids) {
    const outcome = await deps.storeReads.reads.read(id, "refresh");
    if (!outcome.ok) confirmed = false;
  }
  return confirmed;
}

export function createTierRouter(deps: TierDependencies): Hono {
  const router = new Hono();
  const packs = (accountId: string) => packsFor(deps.db, deps.clock, accountId, deps.packIncludes);
  // api.md §4.2: 6 requests per 60 seconds per account.
  const refreshLimit = new RollingLimit(deps.clock, 6, 60);

  router.post("/relay/v1/devices", async (c) => {
    try {
      const input = registrationSchema.parse(await requestJson(c.req.raw));
      const authorization = c.req.header("authorization");
      const bearer = bearerFromHeader(authorization);
      const joinBearer = joinBearerFromHeader(authorization);
      if (authorization !== undefined && bearer === undefined && joinBearer === undefined) return c.json({ error: "unauthorized" }, 401);
      const context = bearer === undefined ? undefined : authenticateDevice(deps.db, bearer);
      if (bearer !== undefined && context === null) return c.json({ error: "unauthorized" }, 401);
      const registration = registerDevice(deps, input, bearer, context ?? undefined, joinBearer);
      const response = { account_id: registration.accountId, tier: registration.tier, caps: capsFor(registration.tier), packs: packs(registration.accountId) };
      if (registration.deviceToken === undefined) return c.json(response, 200);
      const join = registration.accountJoinToken === undefined ? {} : { account_join_token: registration.accountJoinToken };
      return c.json({ device_token: registration.deviceToken, ...join, ...response }, 201);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      if (error instanceof CapError) return c.json({ error: "cap", cap: error.cap }, 429);
      if (error instanceof Error && error.message === "unauthorized") return c.json({ error: "unauthorized" }, 401);
      throw error;
    }
  });

  router.patch("/relay/v1/devices/:deviceId", async (c) => {
    try {
      const input = deviceUpdateSchema.parse(await requestJson(c.req.raw));
      const bearer = bearerFromHeader(c.req.header("authorization"));
      const context = authenticateDevice(deps.db, bearer);
      if (context === null) return c.json({ error: "unauthorized" }, 401);
      if (context.deviceId !== c.req.param("deviceId")) return c.json({ error: "not found" }, 404);
      const account = updateDevice(deps, c.req.param("deviceId"), input, bearer);
      if (account === null) return c.json({ error: "not found" }, 404);
      return c.json({ account_id: account.account_id, tier: account.tier, caps: capsFor(account.tier), packs: packs(account.account_id) });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      throw error;
    }
  });

  // api.md §4.2. 401 for a wrong or another device's token, 404 for a device_id
  // the server has never issued.
  router.delete("/relay/v1/devices/:deviceId", (c) => {
    const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
    if (context === null) return c.json({ error: "unauthorized" }, 401);
    const target = c.req.param("deviceId");
    if (target !== context.deviceId) {
      const known = deps.db.prepare("SELECT 1 FROM devices WHERE id = ?").get(target);
      if (known === undefined) return c.json({ error: "not found" }, 404);
      return c.json({ error: "unauthorized" }, 401);
    }
    deleteDevice(deps, context.deviceId);
    return c.body(null, 204);
  });

  router.post("/relay/v1/devices/:deviceId/subscriptions", async (c) => {
    try {
      const input = subscriptionSchema.parse(await requestJson(c.req.raw));
      const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
      if (context === null) return c.json({ error: "unauthorized" }, 401);
      if (context.deviceId !== c.req.param("deviceId")) return c.json({ error: "not found" }, 404);
      subscribeDevice(deps, context, input.topic_hash);
      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      if (error instanceof Error && error.message === "not found") return c.json({ error: "not found" }, 404);
      throw error;
    }
  });

  router.delete("/relay/v1/devices/:deviceId/subscriptions/:topicHash", (c) => {
    try {
      const topicHash = subscriptionSchema.shape.topic_hash.parse(c.req.param("topicHash"));
      const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
      if (context === null) return c.json({ error: "unauthorized" }, 401);
      if (context.deviceId !== c.req.param("deviceId")) return c.json({ error: "not found" }, 404);
      unsubscribeDevice(deps, context, topicHash);
      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      throw error;
    }
  });

  router.post("/relay/v1/devices/:deviceId/tokens", async (c) => {
    try {
      const input = tokenSchema.parse(await requestJson(c.req.raw));
      const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
      if (context === null) return c.json({ error: "unauthorized" }, 401);
      if (context.deviceId !== c.req.param("deviceId")) return c.json({ error: "not found" }, 404);
      putDeviceToken(deps, context.deviceId, input);
      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      throw error;
    }
  });

  const deleteToken = (c: Context) => {
    try {
      const kind = tokenKindSchema.parse(c.req.param("kind"));
      const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
      if (context === null) return c.json({ error: "unauthorized" }, 401);
      if (context.deviceId !== c.req.param("deviceId")) return c.json({ error: "not found" }, 404);
      deleteDeviceTokens(deps, context.deviceId, kind, c.req.param("activityId"));
      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      throw error;
    }
  };
  router.delete("/relay/v1/devices/:deviceId/tokens/:kind", deleteToken);
  router.delete("/relay/v1/devices/:deviceId/tokens/:kind/:activityId", deleteToken);

  // api.md §4.2. Answers from what the relay holds and never calls the store.
  router.get("/relay/v1/packs", (c) => {
    const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
    if (context === null) return c.json({ error: "unauthorized" }, 401);
    return c.json({ packs: packs(context.accountId), checked_at: packsCheckedAt(deps.db, context.accountId) });
  });

  // api.md §4.2. Reads the store inside the request. `confirmed` describes
  // that read and nothing else: tier, caps and packs are what the account
  // holds when the call returns, from every source.
  router.post("/relay/v1/packs/refresh", async (c) => {
    const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
    if (context === null) return c.json({ error: "unauthorized" }, 401);
    if (!refreshLimit.allow(context.accountId)) return c.json({ code: 42901, http: 429, error: "rate limited" }, 429);
    const confirmed = await readStoreForAccount(deps, context.accountId);
    const account = deps.db.prepare("SELECT tier FROM accounts WHERE id = ?").get(context.accountId) as { tier: Tier } | undefined;
    // The account was erased while the store was being read.
    if (account === undefined) return c.json({ error: "unauthorized" }, 401);
    return c.json({ confirmed, checked_at: packsCheckedAt(deps.db, context.accountId), tier: account.tier, caps: capsFor(account.tier), packs: packs(context.accountId) });
  });

  // api.md §4.3. No secret means no route: an empty one used to match a request
  // that carried no Authorization header at all, which let anyone set any
  // account's tier.
  const revenueCatSecret = deps.revenueCat?.sharedSecret ?? "";
  if (revenueCatSecret !== "") router.post("/webhooks/revenuecat", async (c) => {
    if (!bearerSecretMatches(c.req.header("authorization"), revenueCatSecret)) return c.json({ error: "unauthorized" }, 401);
    try {
      const body = await requestJson(c.req.raw);
      // Reading switched on: the event only names the customers to read. The
      // 200 goes out once the reads are queued, not once they have run.
      if (deps.storeReads?.mode === "on") {
        queueReadsForEvent(deps, deps.storeReads.reads, parseReadTrigger(body));
        deps.storeReads.reads.wake();
        return c.body(null, 200);
      }
      const event = parseRevenueCatEvent(body);
      applyRevenueCatEvent(deps, event);
      // The shadow step. The event has been applied exactly as above, and the
      // read beside it is not waited for.
      if (deps.storeReads?.mode === "shadow") {
        const shadow = deps.storeReads.shadow;
        for (const appUserId of namedCustomers(event.event)) {
          if (resolveAccount(deps, appUserId) !== null) void shadow.read(appUserId, "webhook");
        }
      }
      return c.body(null, 200);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      throw error;
    }
  });

  return router;
}
