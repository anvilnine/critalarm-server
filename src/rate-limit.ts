import { rateLimiter } from "hono-rate-limiter";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings, Variables } from "./index.js";

type Ctx = { Bindings: Bindings; Variables: Variables };

// Client IP behind Coolify/Traefik comes in via x-forwarded-for. Take the
// left-most hop (the original client). Only trustworthy behind a reverse proxy
// that sets the header — fine for the self-hosted dev box.
function clientIp(c: Context<Ctx>, behindProxy: boolean): string {
  if (!behindProxy) return "anonymous";
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "anonymous";
}

// 30 requests / 60s per IP by default, in-memory store. Each call builds its
// own limiter (and its own counter store), so /check/* and /mcp rate-limit
// independently, matching the original per-app Cloudflare limiters.
//
// The limiter is built on the first request rather than at import. Every call
// site here runs at module scope (`routes.use(...)` at the top level), and the
// default memory store starts a cleanup timer in its constructor. Workers
// rejects a script that sets a timer in global scope, and it rejects it at
// upload with "Disallowed operation called within global scope", so the whole
// deploy fails rather than one route.
//
// Caveat on Workers: the counter lives in one isolate's memory, and Cloudflare
// runs many isolates. The effective cap is therefore per isolate, not global,
// which is looser than the same code on a single Node process. Cloudflare's
// native Rate Limiting binding is the real fix. See STATUS.md.
export function makeRateLimiter(
  onLimit?: (c: Context<Ctx>) => Response | Promise<Response>,
  limit = 30,
  behindProxy = false,
): MiddlewareHandler<Ctx> {
  let inner: MiddlewareHandler<Ctx> | undefined;

  return (c, next) => {
    inner ??= rateLimiter<Ctx>({
      windowMs: 60_000,
      limit,
      standardHeaders: "draft-6",
      keyGenerator: (ctx) => clientIp(ctx, behindProxy),
      ...(onLimit ? { handler: (ctx) => onLimit(ctx) } : {}),
    });
    return inner(c, next);
  };
}
