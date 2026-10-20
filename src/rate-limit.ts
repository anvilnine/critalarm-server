import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { rateLimiter } from "hono-rate-limiter";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings, Variables } from "./index.js";
import { embeddedIpv4, ipv6Groups } from "./relay/address.js";

type Ctx = { Bindings: Bindings; Variables: Variables };

// Who may say what the client's address is (BEHIND_PROXY, README
// "Configuration"):
//
// - false: nobody. The socket peer is the client. The default, and right for
//   the shipped docker-compose.yml, which publishes the port directly.
// - "cloudflare": Cloudflare, through cf-connecting-ip, which Cloudflare
//   always overwrites. Nothing else is read. Right only when the origin
//   accepts connections from Cloudflare alone.
// - a number N: N proxies of your own sit in front, each appending the address
//   it saw to x-forwarded-for. The client is the Nth entry from the right.
//   Entries further left are whatever the client typed.
//
// Any value that is not an IP address falls back to the socket peer. The old
// boolean read cf-connecting-ip and then the LEFT-most x-forwarded-for hop, so
// a client that typed a new x-forwarded-for on every request never filled a
// bucket.
export type ProxyTrust = false | "cloudflare" | number;

export interface ClientIpSource {
  env?: unknown;
  req: { header(name: string): string | undefined };
}

export function clientIp(c: ClientIpSource, trust: ProxyTrust): string {
  const peer = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "anonymous";
  if (trust === false) return peer;
  if (trust === "cloudflare") {
    const cloudflare = c.req.header("cf-connecting-ip")?.trim();
    return cloudflare !== undefined && isIP(cloudflare) !== 0 ? cloudflare : peer;
  }
  const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter((hop) => hop !== "");
  const client = hops[hops.length - trust];
  return client !== undefined && isIP(client) !== 0 ? client : peer;
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
  trust: ProxyTrust = false,
): MiddlewareHandler<Ctx> {
  let inner: MiddlewareHandler<Ctx> | undefined;

  return (c, next) => {
    inner ??= rateLimiter<Ctx>({
      windowMs: 60_000,
      limit,
      standardHeaders: "draft-6",
      // An IPv6 client counts by its /64, the same as the relay's own limits.
      keyGenerator: (ctx) => clientKey(clientIp(ctx, trust)),
      ...(onLimit ? { handler: (ctx) => onLimit(ctx) } : {}),
    });
    return inner(c, next);
  };
}
