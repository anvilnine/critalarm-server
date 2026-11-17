import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

// GHSA-jpvv-r467-5p4w. @hono/node-server before 2.1.6 built the request URL
// in a way that turned a backslash in the path into a slash, so /a\b reached
// the route for /a/b. A proxy in front that blocks /a/b by path let /a\b
// through. This starts the real server and sends the raw path, because
// app.request() never goes through the code that had the bug.

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", agent: false }, (res) => {
      res.resume();
      res.on("end", () => { resolve(res.statusCode ?? 0); });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("request paths behind the real @hono/node-server", () => {
  let server: ReturnType<typeof serve>;
  let port = 0;

  beforeAll(async () => {
    const app = new Hono();
    app.get("/relay/v1/internal/stats", (c) => c.text("reached"));
    app.notFound((c) => c.text("not found", 404));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => { port = info.port; resolve(); });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  it("routes the plain path", async () => {
    expect(await get(port, "/relay/v1/internal/stats")).toBe(200);
  });

  it("does not read a backslash as a path separator", async () => {
    expect(await get(port, "/relay\\v1\\internal\\stats")).not.toBe(200);
    expect(await get(port, "/relay/v1\\internal/stats")).not.toBe(200);
  });
});
