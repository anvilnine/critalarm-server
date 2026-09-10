import { describe, it, expect } from "vitest";
import app from "../index.js";

// docs/api.md puts every route at the root: /{topic} for the ntfy-compatible
// surface and /v1/ for everything else. The /api case below asserts 404 on
// purpose. It exists to fail if anyone reintroduces a prefix, which would make
// every URL in the contract and the integration docs wrong.

const testEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
};

describe("health", () => {
  it("answers at /v1/health", async () => {
    const res = await app.request("/v1/health", {}, testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("is not reachable under an /api prefix", async () => {
    const res = await app.request("/api/v1/health", {}, testEnv);
    expect(res.status).toBe(404);
  });
});

describe("404s", () => {
  it("answers plain JSON", async () => {
    const res = await app.request("/v1/nope", {}, testEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
