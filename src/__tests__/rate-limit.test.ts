import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "../config.js";
import { clientIp, makeRateLimiter, type ProxyTrust } from "../rate-limit.js";

function app(trust: ProxyTrust) {
  const server = new Hono();
  server.use("*", makeRateLimiter(undefined, 1, trust));
  server.get("/", (c) => c.text("ok"));
  return server;
}

const socket = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } }) as never;

function source(headers: Record<string, string>, remoteAddress = "10.0.0.9") {
  return { env: { incoming: { socket: { remoteAddress } } }, req: { header: (name: string) => headers[name] } };
}

describe("rate limiter client keys", () => {
  it("uses the direct socket address and ignores attacker-supplied X-Forwarded-For", async () => {
    const server = app(false);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1" } }, socket("10.0.0.1"))).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2" } }, socket("10.0.0.1"))).status).toBe(429);
    expect((await server.request("/", {}, socket("10.0.0.2"))).status).toBe(200);
  });

  // The old code took the LEFT-most hop, which is whatever the client typed.
  // A client that typed a new one on every request never filled a bucket.
  it("with one trusted hop, keys on the right-most x-forwarded-for entry and not on what the client typed", async () => {
    const server = app(1);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.7" } }, socket("10.0.0.1"))).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.7" } }, socket("10.0.0.1"))).status).toBe(429);
    expect((await server.request("/", { headers: { "x-forwarded-for": "203.0.113.8" } }, socket("10.0.0.1"))).status).toBe(200);
  });

  // Cloudflare overwrites cf-connecting-ip, so in this mode it is the only
  // header read.
  it("in cloudflare mode keys on cf-connecting-ip and never on x-forwarded-for", async () => {
    const server = app("cloudflare");
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "203.0.113.7" } })).status).toBe(200);
    expect((await server.request("/", { headers: { "x-forwarded-for": "198.51.100.2", "cf-connecting-ip": "203.0.113.7" } })).status).toBe(429);
    expect((await server.request("/", { headers: { "cf-connecting-ip": "203.0.113.8" } })).status).toBe(200);
  });

  it("counts every address in one IPv6 /64 as one client", async () => {
    const server = app("cloudflare");
    expect((await server.request("/", { headers: { "cf-connecting-ip": "2001:db8:1:2::1" } })).status).toBe(200);
    expect((await server.request("/", { headers: { "cf-connecting-ip": "2001:db8:1:2:ffff::9" } })).status).toBe(429);
    expect((await server.request("/", { headers: { "cf-connecting-ip": "2001:db8:1:3::1" } })).status).toBe(200);
  });
});

describe("clientIp", () => {
  it("reads nothing a client can type when no proxy is trusted", () => {
    expect(clientIp(source({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }), false)).toBe("10.0.0.9");
  });

  it("in cloudflare mode reads cf-connecting-ip only, and falls back to the peer without it", () => {
    expect(clientIp(source({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }), "cloudflare")).toBe("203.0.113.7");
    expect(clientIp(source({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }), "cloudflare")).toBe("10.0.0.9");
  });

  it("takes the Nth x-forwarded-for entry from the right", () => {
    const headers = { "x-forwarded-for": "198.51.100.1, 203.0.113.7, 10.1.1.1" };
    expect(clientIp(source(headers), 1)).toBe("10.1.1.1");
    expect(clientIp(source(headers), 2)).toBe("203.0.113.7");
    expect(clientIp(source(headers), 3)).toBe("198.51.100.1");
  });

  it("falls back to the peer when the hop is missing or is not an IP address", () => {
    expect(clientIp(source({ "x-forwarded-for": "198.51.100.1" }), 2)).toBe("10.0.0.9");
    expect(clientIp(source({}), 1)).toBe("10.0.0.9");
    expect(clientIp(source({ "x-forwarded-for": "198.51.100.1, not-an-ip" }), 1)).toBe("10.0.0.9");
    expect(clientIp(source({ "cf-connecting-ip": "a".repeat(5000) }), "cloudflare")).toBe("10.0.0.9");
  });
});

describe("BEHIND_PROXY", () => {
  const load = (value: string | undefined, file = "") => loadConfig({ ALLOW_NOOP_PUSH: "true", ...(value === undefined ? {} : { BEHIND_PROXY: value }) }, () => `base-url: https://alerts.example.com\n${file}`).behindProxy;

  it("is off unless it is set", () => {
    expect(load(undefined)).toBe(false);
    for (const off of ["false", "off", "0", ""]) expect(load(off)).toBe(false);
  });

  it("takes cloudflare or a hop count", () => {
    expect(load("cloudflare")).toBe("cloudflare");
    expect(load("1")).toBe(1);
    expect(load("2")).toBe(2);
    expect(load(undefined, "behind-proxy: 1")).toBe(1);
    expect(load(undefined, "behind-proxy: cloudflare")).toBe("cloudflare");
  });

  it("reads the old true as cloudflare and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(load("true")).toBe("cloudflare");
      expect(load(undefined, "behind-proxy: true")).toBe("cloudflare");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toBe("behind_proxy_true");
    } finally { warn.mockRestore(); }
  });

  it("stops startup on a value it does not know", () => {
    for (const bad of ["yes", "-1", "11", "1.5", "nginx"]) expect(() => load(bad)).toThrow("behind-proxy");
  });
});
