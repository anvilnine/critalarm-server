import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import { Counters } from "./counters.js";
import { bearerSecretMatches } from "../bearer.js";

// api.md §4.4. Internal, not public, never cached. Mounted only in relay and
// hosted modes, so a self-hosted server answers the app's plain 404. Without a
// STATS_KEY the route is not mounted at all.
export function createStatsRouter(db: Database.Database, clock: Clock, statsKey: string): Hono {
  const router = new Hono();
  const counters = new Counters(db, clock);
  router.get("/relay/v1/internal/stats", (c) => {
    if (!bearerSecretMatches(c.req.header("authorization"), statsKey)) return c.json({ error: "unauthorized" }, 401);
    const by = c.req.query("by");
    if (by !== undefined && by !== "key") return c.json({ error: "invalid request" }, 400);
    c.header("cache-control", "no-store");
    return c.json(counters.read({ byKey: by === "key" }));
  });
  return router;
}
