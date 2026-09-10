import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { makeRateLimiter } from "./rate-limit.js";

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

export type Bindings = {
  // Comma-separated list of origins the browser-facing routes accept.
  ALLOWED_ORIGINS: string;
  PORT?: string;
};

export type Variables = Record<string, never>;

const routes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Read per request rather than once at import, because on Node c.env is the
// process.env object handed in by server-node.ts.
const allowedOriginsCors: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = (c, next) => {
  const origins =
    c.env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return cors({
    origin: (origin) => (origins.includes(origin) ? origin : undefined),
    credentials: true,
  })(c, next);
};

// ---- Health ----------------------------------------------------------------

routes.get("/v1/health", (c) => c.json({ ok: true }));

// ---- Shared middleware -----------------------------------------------------

// Both are kept wired so the pattern stays exercised. S1 sets the real scopes
// and limits per docs/api.md: publish is far hotter than the /v1/ management
// routes and the two must not share a budget.
routes.use("/v1/*", allowedOriginsCors);
routes.use("/v1/*", makeRateLimiter(undefined, 120));

// ---- Mount -----------------------------------------------------------------

// One mount, at the root. Two paths to the same handler would give every rate
// limit, log line and health check two spellings.
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.route("/", routes);

// ---- 404 -------------------------------------------------------------------

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
