import type { Clock } from "../incident/types.js";

// A rolling window per key, counted on the injected clock. The publish limiter
// (src/rate-limit.ts) keys on the client address, and POST
// /relay/v1/packs/refresh is limited per account (api.md §4.2), so it has this
// instead. In memory, like that one: the server is one process.
export class RollingLimit {
  private readonly seen = new Map<string, number[]>();

  constructor(private readonly clock: Clock, private readonly limit: number, private readonly windowS: number) {}

  // True when the call is allowed, and then it counts. A refused call does not
  // count, so hammering the route does not push the window out.
  allow(key: string): boolean {
    const now = this.clock.now();
    const recent = (this.seen.get(key) ?? []).filter((at) => at > now - this.windowS);
    if (recent.length >= this.limit) {
      this.seen.set(key, recent);
      return false;
    }
    recent.push(now);
    this.seen.set(key, recent);
    if (this.seen.size > 10_000) this.forget(now);
    return true;
  }

  private forget(now: number): void {
    for (const [key, times] of this.seen) {
      if (times.every((at) => at <= now - this.windowS)) this.seen.delete(key);
    }
  }
}
