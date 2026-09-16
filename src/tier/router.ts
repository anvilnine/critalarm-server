import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { authenticateDevice, bearerFromHeader, joinBearerFromHeader } from "./auth.js";
import { capsFor } from "./caps.js";
import { CapError, deleteDevice, deviceUpdateSchema, registerDevice, registrationSchema, subscribeDevice, subscriptionSchema, unsubscribeDevice, updateDevice } from "./devices.js";
import { deleteDeviceTokens, putDeviceToken, tokenKindSchema, tokenSchema } from "./device-tokens.js";
import { applyRevenueCatEvent, parseRevenueCatEvent } from "./revenuecat.js";
import { bearerSecretMatches } from "../bearer.js";
import type { TierDependencies } from "./types.js";

async function requestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new z.ZodError([]);
  }
}

export function createTierRouter(deps: TierDependencies): Hono {
  const router = new Hono();

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
      const response = { account_id: registration.accountId, tier: registration.tier, caps: capsFor(registration.tier) };
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
      return c.json({ account_id: account.account_id, tier: account.tier, caps: capsFor(account.tier) });
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

  // api.md §4.3. No secret means no route: an empty one used to match a request
  // that carried no Authorization header at all, which let anyone set any
  // account's tier.
  const revenueCatSecret = deps.revenueCat?.sharedSecret ?? "";
  if (revenueCatSecret !== "") router.post("/webhooks/revenuecat", async (c) => {
    if (!bearerSecretMatches(c.req.header("authorization"), revenueCatSecret)) return c.json({ error: "unauthorized" }, 401);
    try {
      applyRevenueCatEvent(deps, parseRevenueCatEvent(await requestJson(c.req.raw)));
      return c.body(null, 200);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return c.json({ error: "invalid request" }, 400);
      throw error;
    }
  });

  return router;
}
