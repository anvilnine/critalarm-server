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
  it("ignores attacker-supplied X-Forwarded-For without a trusted proxy", async () => {
    const server = app(false);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1" } })).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2" } })).status).toBe(429);
  });

  it("uses the first forwarded hop behind a configured proxy", async () => {
    const server = app(true);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } })).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.1" } })).status).toBe(200);
  });
});
