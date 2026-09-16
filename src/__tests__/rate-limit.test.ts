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

  // Cloudflare appends to x-forwarded-for, so the left-most hop is whatever the
  // client typed. Changing it every request used to mean the limiter never
  // fired.
  it("keys on cf-connecting-ip when a client forges x-forwarded-for behind Cloudflare", async () => {
    const server = app(true);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "203.0.113.7" } })).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2", "cf-connecting-ip": "203.0.113.7" } })).status).toBe(429);
    expect((await server.request("/", { headers: { "cf-connecting-ip": "203.0.113.8" } })).status).toBe(200);
  });
});
