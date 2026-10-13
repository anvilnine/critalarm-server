import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { rateLimiter } from "hono-rate-limiter";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings, Variables } from "./index.js";
import { embeddedIpv4, ipv6Groups } from "./relay/address.js";

type Ctx = { Bindings: Bindings; Variables: Variables };

// Only a configured proxy is allowed to say who the client is. Without
// BEHIND_PROXY the forwarded headers are ignored and the socket peer is the key.
//
// Behind Cloudflare, prefer cf-connecting-ip. Cloudflare APPENDS to
// x-forwarded-for instead of replacing it, so the left-most hop is whatever the
// client typed, and a client that changes it every request never fills a bucket.
// Cloudflare always overwrites cf-connecting-ip and a client cannot reach
// through it. With no such header, fall back to the forwarded hops, so a
// self-hoster behind a plain nginx still gets per-client limiting.
export interface ClientIpSource {
  env?: unknown;
  req: { header(name: string): string | undefined };
}

export function clientIp(c: ClientIpSource, behindProxy: boolean): string {
  if (!behindProxy) return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "anonymous";
  const cloudflare = c.req.header("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "anonymous";
}

// The key a per-client limit counts on. An IPv4 address stands for itself. An
// IPv6 address stands for its /64, because one home or one rented host holds a
// whole /64 and could otherwise pick a new address for every call. An
// IPv4-mapped IPv6 address counts as its IPv4. Anything that is not an address
// (a header a caller typed) is hashed, so no key grows past 64 characters.
export function clientKey(address: string): string {
  const text = address.trim();
  const family = isIP(text);
  if (family === 4) return text;
  if (family === 6) {
    const groups = ipv6Groups(text);
    if (groups !== undefined) {
      if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return embeddedIpv4(groups).join(".");
      return `v6:${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}`;
    }
  }
  return `h:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
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
