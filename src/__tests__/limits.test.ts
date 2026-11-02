import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { DailyLimit, makeRateLimiter, RollingLimit } from "../rate-limit.js";

class FakeClock {
  constructor(public value = 1_000) {}
  now(): number { return this.value; }
}

describe("RollingLimit", () => {
  it("refuses the call over the limit and lets the window roll", () => {
    const clock = new FakeClock(1_000);
    const limit = new RollingLimit(clock, 3, 60);
    expect([1, 2, 3].map(() => limit.allow("k"))).toEqual([true, true, true]);
    expect(limit.allow("k")).toBe(false);
    clock.value = 1_059;
    expect(limit.allow("k")).toBe(false);
    clock.value = 1_060; // the first three calls are exactly 60 s old and have left the window
    expect(limit.allow("k")).toBe(true);
  });

  it("does not count a refused call, so hammering does not push the window out", () => {
    const clock = new FakeClock(1_000);
    const limit = new RollingLimit(clock, 1, 60);
    expect(limit.allow("k")).toBe(true);
    for (let at = 1_001; at < 1_060; at += 1) { clock.value = at; expect(limit.allow("k")).toBe(false); }
    clock.value = 1_060;
    expect(limit.allow("k")).toBe(true);
  });

  it("keeps a bucket per key, and allowed() looks without counting", () => {
    const limit = new RollingLimit(new FakeClock(), 1, 60);
    expect(limit.allowed("a")).toBe(true);
    expect(limit.allowed("a")).toBe(true);
    limit.record("a");
    expect(limit.allowed("a")).toBe(false);
    expect(limit.allowed("b")).toBe(true);
  });
});

describe("RollingLimit memory", () => {
  it("sweeps idle keys once the table is over its size, before the next window sweep is due", () => {
    const clock = new FakeClock(1_000);
    const limit = new RollingLimit(clock, 1, 60, 3);
    const table = (limit as unknown as { hits: Map<string, number[]> }).hits;
    limit.allow("first"); // the window sweep runs here, at 1_000
    clock.value = 1_030;
    for (const key of ["a", "b", "c", "d"]) limit.allow(key);
    clock.value = 1_060; // "first" has left the window and goes; a..d are still live
    limit.allowed("x");
    expect(table.size).toBe(4);
    clock.value = 1_091; // a..d have left the window; the next window sweep is not due until 1_120
    limit.allowed("x");
    expect(table.size).toBe(0);
  });
});

describe("DailyLimit", () => {
  const MIDNIGHT = 20_000 * 86_400;

  it("trips at the limit and starts again at 00:00 UTC", () => {
    const clock = new FakeClock(MIDNIGHT + 86_399 - 100);
    const limit = new DailyLimit(clock, 2);
    for (let i = 0; i < 2; i += 1) { expect(limit.allowed("k")).toBe(true); limit.record("k"); }
    expect(limit.allowed("k")).toBe(false);
    expect(limit.allowed("other")).toBe(true);
    clock.value = MIDNIGHT + 86_399;
    expect(limit.allowed("k")).toBe(false);
    clock.value = MIDNIGHT + 86_400;
    expect(limit.allowed("k")).toBe(true);
  });
});

describe("publish limiter", () => {
  function app(clock: FakeClock) {
    const server = new Hono();
    server.use("*", makeRateLimiter(30, false, clock));
    server.get("/", (c) => c.text("ok"));
    return server;
  }

  it("lets 30 calls through in 60 s, answers 42901 on the 31st and rolls with the clock", async () => {
    const clock = new FakeClock(1_000);
    const server = app(clock);
    for (let i = 0; i < 30; i += 1) expect((await server.request("/")).status).toBe(200);
    const over = await server.request("/");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ code: 42901, http: 429, error: "rate limited" });
    clock.value = 1_059;
    expect((await server.request("/")).status).toBe(429);
    clock.value = 1_060;
    expect((await server.request("/")).status).toBe(200);
  });
});

describe("DailyLimit table cap", () => {
  const MIDNIGHT = 20_000 * 86_400;

  it("refuses a new key when the table is full, keeps known keys counting, and empties at midnight", () => {
    const clock = new FakeClock(MIDNIGHT + 10);
    const limit = new DailyLimit(clock, 2, 3);
    for (const key of ["a", "b", "c"]) { expect(limit.allowed(key)).toBe(true); limit.record(key); }
    expect(limit.allowed("d")).toBe(false);
    // A known key still counts up to its own limit.
    expect(limit.allowed("a")).toBe(true);
    limit.record("a");
    expect(limit.allowed("a")).toBe(false);
    expect(limit.allowed("d")).toBe(false);
    clock.value = MIDNIGHT + 86_400;
    expect(limit.allowed("d")).toBe(true);
  });
});
