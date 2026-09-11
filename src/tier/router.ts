import { Hono } from "hono";
import { z } from "zod";
import { authenticateDevice, bearerFromHeader } from "./auth.js";
import { capsFor } from "./caps.js";
import { CapError, deviceUpdateSchema, registerDevice, registrationSchema, subscribeDevice, subscriptionSchema, unsubscribeDevice, updateDevice } from "./devices.js";
import { applyRevenueCatEvent, parseRevenueCatEvent, sharedSecretMatches } from "./revenuecat.js";
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
      const registration = registerDevice(deps, input, bearerFromHeader(c.req.header("authorization")));
      const response = { account_id: registration.accountId, tier: registration.tier, caps: capsFor(registration.tier) };
      return c.json(registration.deviceToken === "" ? response : { device_token: registration.deviceToken, ...response }, registration.deviceToken === "" ? 200 : 201);
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
      if (error instanceof CapError) return c.json({ error: "cap", cap: error.cap }, 429);
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

  router.post("/webhooks/revenuecat", async (c) => {
    if (!sharedSecretMatches(c.req.header("authorization"), deps.revenueCat.sharedSecret)) return c.json({ error: "unauthorized" }, 401);
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
