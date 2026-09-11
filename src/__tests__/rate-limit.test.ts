import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeRateLimiter } from "../rate-limit.js";

function app(behindProxy: boolean) {
  const server = new Hono();
  server.use("*", makeRateLimiter(undefined, 1, behindProxy));
  server.get("/", (c) => c.text("ok"));
  return server;
}

describe("rate limiter client keys", () => {
  it("uses the direct socket address and ignores attacker-supplied X-Forwarded-For", async () => {
    const server = app(false);
    const one = { incoming: { socket: { remoteAddress: "10.0.0.1" } } };
    const two = { incoming: { socket: { remoteAddress: "10.0.0.2" } } };
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1" }, }, one as never)).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2" }, }, one as never)).status).toBe(429);
    expect((await server.request("/", {}, two as never)).status).toBe(200);
  });

  it("uses the first forwarded hop behind a configured proxy", async () => {
    const server = app(true);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } })).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.1" } })).status).toBe(200);
  });
});
