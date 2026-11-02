import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { clientIp, clientKey, makeRateLimiter } from "../rate-limit.js";
import type { Bindings, Variables } from "../index.js";

// The other rate limit tests hand the app a made-up env with `incoming` on it.
// That proves our reading of the shape and nothing about what @hono/node-server
// really passes. This one starts the real server, makes a real request, and
// checks the key the limiter counts on is the address the connection came from.
// If a server upgrade moves the socket, this fails with "anonymous" instead of
// every client sharing one bucket in production.

type Reply = { status: number; body: string; localAddress: string };

function get(port: number, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => { resolve({ status: res.statusCode ?? 0, body, localAddress: req.socket?.localAddress ?? "" }); });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("rate limiter behind the real @hono/node-server", () => {
  let server: ReturnType<typeof serve>;
  let port = 0;

  beforeAll(async () => {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.get("/who", (c) => c.json({ peer: clientIp(c, false), key: clientKey(clientIp(c, false)) }));
    app.use("/limited", makeRateLimiter(undefined, 1, false));
    app.get("/limited", (c) => c.text("ok"));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => { port = info.port; resolve(); });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  it("reads the peer address of the connection, never the anonymous fallback", async () => {
    const reply = await get(port, "/who");

    expect(reply.status).toBe(200);
    expect(reply.localAddress).toBe("127.0.0.1");
    const seen = JSON.parse(reply.body) as { peer: string; key: string };
    expect(seen.peer).not.toBe("anonymous");
    expect(seen.peer).toBe(reply.localAddress);
    expect(seen.key).toBe(reply.localAddress);
  });

  it("counts a second request from the same peer against the same bucket", async () => {
    expect((await get(port, "/limited")).status).toBe(200);
    expect((await get(port, "/limited")).status).toBe(429);
  });
});
