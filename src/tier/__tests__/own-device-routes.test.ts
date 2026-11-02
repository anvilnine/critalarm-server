import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createTierRouter } from "../router.js";

// The five device routes that take a device_id in the path all answer the same
// way: 401 for a missing or unknown token, 404 for a real token on another
// device's path. The body is checked before the token, so a bad body answers
// 400 even when the token is wrong. These tests pin that for every route.

const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const json = { "content-type": "application/json" };

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  for (const [id, token] of [["dev_one", "dv_one"], ["dev_two", "dv_two"]] as const) {
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, 'acc_1', ?, 'android', ?, 1)").run(id, createHash("sha256").update(token).digest("hex"), id);
  }
  return createTierRouter({ db, clock: { now: () => 1_000 }, ids: { account: () => "acc_unused", deviceToken: () => "dv_unused", accountJoinToken: () => "aj_unused" }, revenueCat: { sharedSecret: "secret", entitlements: {} } });
}

type Route = { name: string; method: string; path: (id: string) => string; body?: unknown };

const routes: Route[] = [
  { name: "PATCH device", method: "PATCH", path: id => `/relay/v1/devices/${id}`, body: { push_token: "abc", app_version: "1.0.0" } },
  { name: "POST subscription", method: "POST", path: id => `/relay/v1/devices/${id}/subscriptions`, body: { topic_hash: hash } },
  { name: "DELETE subscription", method: "DELETE", path: id => `/relay/v1/devices/${id}/subscriptions/${hash}` },
  { name: "POST token", method: "POST", path: id => `/relay/v1/devices/${id}/tokens`, body: { kind: "fcm", token: "abc" } },
  { name: "DELETE token", method: "DELETE", path: id => `/relay/v1/devices/${id}/tokens/fcm` },
  { name: "DELETE token with activity", method: "DELETE", path: id => `/relay/v1/devices/${id}/tokens/la_update/act1` },
];

function call(app: ReturnType<typeof setup>, route: Route, id: string, token: string | undefined, body: unknown = route.body) {
  const headers: Record<string, string> = body === undefined ? {} : { ...json };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return app.request(route.path(id), { method: route.method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe.each(routes)("own-device check on $name", route => {
  it("answers 401 for a missing token", async () => {
    const response = await call(setup(), route, "dev_one", undefined);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 401 for an unknown token", async () => {
    const response = await call(setup(), route, "dev_one", "dv_wrong");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 404 for another device's path with a real token, same account included", async () => {
    const response = await call(setup(), route, "dev_two", "dv_one");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("answers 401, not 404, when the token is unknown and the path is another device's", async () => {
    const response = await call(setup(), route, "dev_two", "dv_wrong");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("lets the device's own token through", async () => {
    const response = await call(setup(), route, "dev_one", "dv_one");
    expect(response.status).toBeLessThan(300);
  });
});

describe("body is checked before the token", () => {
  it.each(routes.filter(route => route.body !== undefined))("$name answers 400 for a bad body with a wrong token", async route => {
    const response = await call(setup(), route, "dev_one", "dv_wrong", { nonsense: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request" });
  });

  it("DELETE subscription answers 400 for a malformed topic hash with a wrong token", async () => {
    const app = setup();
    const response = await app.request("/relay/v1/devices/dev_one/subscriptions/nothex", { method: "DELETE", headers: { authorization: "Bearer dv_wrong" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request" });
  });

  it("DELETE token answers 400 for an unknown kind with a wrong token", async () => {
    const app = setup();
    const response = await app.request("/relay/v1/devices/dev_one/tokens/nope", { method: "DELETE", headers: { authorization: "Bearer dv_wrong" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request" });
  });
});
