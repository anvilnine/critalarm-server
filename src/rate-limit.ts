import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Context, Env, Next } from "hono";
import type { Clock } from "./incident/types.js";
import { embeddedIpv4, ipv6Groups } from "./relay/address.js";

// The body of every 429 in the ntfy shape (api.md §1.8).
export const RATE_LIMITED = { code: 42901, http: 429, error: "rate limited" } as const;

// Every limit in the server is one of the two classes below, counted on the
// injected clock and kept in memory. The server is one process, so a restart
// clears them. The publish limiter and the account-creation limit key on the
// client address (clientIp, clientKey); the refresh and cancel-reason limits
// key on the account.

// A rolling window per key. `allowed` only looks and `record` counts, so a
// call that another limit turns away is not charged to this one. `allow` does
// both. A refused call is never counted, so hammering a route does not push
// the window out.
export class RollingLimit {
  private readonly hits = new Map<string, number[]>();
  private sweptAt = 0;

  constructor(private readonly clock: Clock, private readonly limit: number, private readonly windowS: number, private readonly sweepAbove = 10_000) {}

  private live(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((at) => at > now - this.windowS);
  }

  allowed(key: string): boolean {
    const now = this.clock.now();
    // Drop idle keys once per window so the table follows the traffic, and
    // again (at most once a second) while the table holds more than
    // `sweepAbove` keys, so a flood of addresses cannot grow it for a window.
    if (now - this.sweptAt >= this.windowS || (this.hits.size > this.sweepAbove && now !== this.sweptAt)) {
      this.sweptAt = now;
      for (const [other, times] of this.hits) if (!times.some((at) => at > now - this.windowS)) this.hits.delete(other);
    }
    return this.live(key, now).length < this.limit;
  }

  record(key: string): void {
    const now = this.clock.now();
    this.hits.set(key, [...this.live(key, now), now]);
  }

  // True when the call is allowed, and then it counts.
  allow(key: string): boolean {
    if (!this.allowed(key)) return false;
    this.record(key);
    return true;
  }
}

// A count per key for the current UTC day. At 00:00 UTC every count starts
// again from zero. The table holds at most `maxKeys` keys (100_000): once it is
// full a new key is refused and a known key keeps its count, so a flood of
// addresses cannot grow memory, and the limit fails closed for new addresses
// until midnight.
export class DailyLimit {
  private day = -1;
  private readonly counts = new Map<string, number>();

  constructor(private readonly clock: Clock, private readonly limit: number, private readonly maxKeys = 100_000) {}

  private roll(): void {
    const day = Math.floor(this.clock.now() / 86_400);
    if (day !== this.day) {
      this.day = day;
      this.counts.clear();
    }
  }

  allowed(key: string): boolean {
    this.roll();
    const count = this.counts.get(key);
    if (count === undefined) return this.counts.size < this.maxKeys;
    return count < this.limit;
  }

  record(key: string): void {
    this.roll();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

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

// The publish limiter: 30 requests per rolling 60 seconds per client address
// by default (api.md §1.8). One instance is one bucket, so the routes that
// share an instance share the window: POST /{topic}, POST /v1/topics/{name}/send
// and POST /v1/test all take the instance createApp builds. Each call to
// makeRateLimiter builds a bucket of its own.
export type PublishLimiter = <E extends Env>(c: Context<E>, next: Next) => Promise<Response | void>;

export function makeRateLimiter(
  limit = 30,
  trust: ProxyTrust = false,
  clock: Clock = { now: () => Math.floor(Date.now() / 1000) },
): PublishLimiter {
  const window = new RollingLimit(clock, limit, 60);
  return async (c, next) => {
    // An IPv6 client counts by its /64, the same as the relay's own limits.
    if (!window.allow(clientKey(clientIp(c, trust)))) return c.json(RATE_LIMITED, 429);
    await next();
  };
}
