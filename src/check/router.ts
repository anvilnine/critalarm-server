import { Hono } from "hono";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import { authenticateDevice, bearerFromHeader } from "../tier/auth.js";
import { holdsPack, packRequired, type PackIncludes } from "../tier/packs.js";
import type { AccountContext } from "../tier/types.js";
import { CHECK_PACK, type CheckStore } from "./store.js";

// api.md §4.5, the four weekly check routes. Each takes the device's own dv_
// and reaches that one device's data. Another device's token answers 404, as
// on every device route, including another device on the same account.
//
// No response here carries a check_id. The only place one appears is the path
// of the receipt route, where the caller sent it.

export interface CheckRouterDependencies {
  db: Database.Database;
  clock: Clock;
  store: CheckStore;
  packIncludes?: PackIncludes;
}

const DEFAULT_ROUNDS_LIMIT = 20;
const MAX_ROUNDS_LIMIT = 200;

export function createCheckRouter(deps: CheckRouterDependencies): Hono {
  const router = new Hono();

  // The caller's own device, or the response that says why not.
  const own = (c: Context): AccountContext | Response => {
    const context = authenticateDevice(deps.db, bearerFromHeader(c.req.header("authorization")));
    if (context === null) return c.json({ error: "unauthorized" }, 401);
    if (context.deviceId !== c.req.param("deviceId")) return c.json({ error: "not found" }, 404);
    return context;
  };

  router.put("/relay/v1/devices/:deviceId/check", async (c) => {
    const context = own(c);
    if (context instanceof Response) return context;
    const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
    if (body === null || typeof body !== "object" || typeof body.enabled !== "boolean") return c.json({ error: "invalid request" }, 400);
    if (body.enabled) {
      if (!holdsPack(deps.db, deps.clock, context.accountId, CHECK_PACK, deps.packIncludes)) return packRequired(CHECK_PACK);
      deps.store.enable(context.deviceId);
    } else {
      deps.store.disable(context.deviceId);
    }
    return c.json(deps.store.view(context.deviceId, context.accountId));
  });

  router.get("/relay/v1/devices/:deviceId/check", (c) => {
    const context = own(c);
    if (context instanceof Response) return context;
    return c.json(deps.store.view(context.deviceId, context.accountId));
  });

  // Both fields of the body are optional notes, and neither can cause an
  // error, so a body that is missing or is not JSON is read as no notes.
  router.post("/relay/v1/devices/:deviceId/checks/:checkId/receipt", async (c) => {
    const context = own(c);
    if (context instanceof Response) return context;
    const body = await c.req.json().catch(() => null) as unknown;
    const notes = typeof body === "object" && body !== null ? body as { attempt?: unknown; received_at?: unknown } : {};
    const answer = deps.store.receipt(context.deviceId, context.accountId, c.req.param("checkId"), notes);
    if (answer === null) return c.json({ error: "not found" }, 404);
    return c.json(answer);
  });

  // Answers whether or not the account holds the pack today.
  router.get("/relay/v1/devices/:deviceId/checks", (c) => {
    const context = own(c);
    if (context instanceof Response) return context;
    const limit = c.req.query("limit");
    if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1)) return c.json({ error: "invalid request" }, 400);
    return c.json(deps.store.rounds(context.deviceId, limit === undefined ? DEFAULT_ROUNDS_LIMIT : Math.min(Number(limit), MAX_ROUNDS_LIMIT)));
  });

  return router;
}
