import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import type { Clock, DeliveryEvent, IdGenerator } from "./incident/types.js";
import { IncidentService } from "./incident/service.js";
import { createIngressRouter } from "./ingress/router.js";
import { createTierRouter } from "./tier/router.js";
import { createV1Router } from "./v1/router.js";
export type Bindings = { ALLOWED_ORIGINS: string; PORT?: string };
export type Variables = Record<string, never>;

// The Hono app. Right now it serves GET /v1/health and a JSON 404.
//
// Everything mounts at the ROOT, because that is where docs/api.md puts it: the
// ntfy-compatible publish and poll handlers answer at /{topic}, and the Crit
// Alarm surface at /v1/. There is no /api prefix and there must not be one, or
// every URL in the contract, the docs and the integration examples is wrong.
//
// S0 and S1 add the real handlers.
//
// Runs on plain Node via src/server-node.ts. One long-lived process, because the
// incident repeat loop is a timer scan over database rows.

export interface AppDependencies { config: Config; db: Database.Database; clock: Clock; ids: IdGenerator; dispatch(events: readonly DeliveryEvent[]): Promise<void>; }
export function createApp(deps: AppDependencies): Hono {
  const app = new Hono(); const incidents = new IncidentService(deps.db, deps.clock, deps.ids);
  app.get("/v1/health", c => c.json({ ok: true }));
  app.route("/", createTierRouter({ db: deps.db, clock: deps.clock, ids: { account: () => `acc_${crypto.randomUUID()}`, deviceToken: () => `dv_${crypto.randomUUID()}` }, revenueCat: { sharedSecret: deps.config.revenueCat?.sharedSecret ?? "", entitlements: deps.config.revenueCat?.entitlements ?? {} } }));
  app.route("/", createV1Router({ ...deps, incidents })); app.route("/", createIngressRouter({ ...deps, incidents, behindProxy: deps.config.behindProxy })); app.notFound(c => c.json({ error: "Not found" }, 404)); return app;
}
