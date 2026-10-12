import { describe, expect, it, vi } from "vitest";
import { RelayClient, RelayKeyError } from "../client.js";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { DeliveryEvent } from "../../incident/types.js";

// api.md §3.8 and §4.1. Registration carries a challenge, the challenge route
// answers for it while the call is out, and a failed registration backs off.

const SHAPE = /^[A-Za-z0-9_-]{43}$/;
const env = { ALLOWED_ORIGINS: "http://localhost:3000" };
const baseEvent: DeliveryEvent = { kind: "open", topicHash: "a".repeat(64), topic: "prod", incidentId: "inc", messageId: "msg", priority: 5, maxRingS: 10, ringUntil: 1_010, server: "https://a.test", title: "T", body: "B", critical: true };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

type Handler = (request: Request) => Promise<Response> | Response;

function setup(handler: Handler, options: { secret?: string; relayContent?: "none" | "full" } = {}) {
  const db = openDatabase(":memory:"); migrate(db);
  let nowMs = 1_000_000;
  const logs: Record<string, unknown>[] = [];
  const requests: { url: string; body: unknown; auth: string | null }[] = [];
  const fetcher = vi.fn(async (request: Request) => {
    const text = await request.clone().text();
    requests.push({ url: request.url, body: text === "" ? undefined : JSON.parse(text) as unknown, auth: request.headers.get("authorization") });
    return handler(request);
  });
  const client = new RelayClient({ db, relayUrl: "https://relay.test", baseUrl: "https://a.test", relayContent: options.relayContent ?? "none", ...(options.secret === undefined ? {} : { registrationSecret: options.secret }), fetch: fetcher, now: () => nowMs, log: (line) => { logs.push(line); } });
  return { db, client, fetcher, logs, requests, advance: (ms: number) => { nowMs += ms; }, registrations: () => requests.filter((r) => r.url.endsWith("/relay/v1/servers")), pushes: () => requests.filter((r) => r.url.endsWith("/relay/v1/push")) };
}

const accepting: Handler = (request) => request.url.endsWith("/servers") ? json(201, { relay_key: "rk_secretkey" }) : new Response(null, { status: 202 });
const failing = (status: number, error: string): Handler => (request) => request.url.endsWith("/servers") ? json(status, { error }) : new Response(null, { status: 202 });

function appFor(mode: "selfhosted" | "relay" | "hosted", client?: RelayClient) {
  const db = openDatabase(":memory:"); migrate(db);
  const config = { baseUrl: "https://a.test", relayUrl: "https://relay.test", relayContent: "none" as const, listen: ":8080", port: 8080, dataDir: "/tmp", behindProxy: false, mode };
  return createApp({ config, db, clock: { now: () => 1 }, ids: { message: () => "m", incident: () => "i", timer: () => "t" }, dispatch: async () => {}, ...(client === undefined ? {} : { relayChallenge: (value: string) => client.isRelayChallenge(value) }) });
}

describe("registration challenge", () => {
  it("sends base_url, version and a 43 character base64url challenge, and the secret as Bearer", async () => {
    const { client, registrations, db } = setup(accepting, { secret: "s3cret" });
    await client.forwardOne(baseEvent);
    const [call] = registrations();
    expect(call!.auth).toBe("Bearer s3cret");
    expect(call!.body).toMatchObject({ base_url: "https://a.test" });
    expect(Object.keys(call!.body as object).sort()).toEqual(["base_url", "challenge", "version"]);
    expect((call!.body as { challenge: string }).challenge).toMatch(SHAPE);
    db.close();
  });

  it("makes a fresh challenge for every attempt", async () => {
    const { client, registrations, advance, db } = setup(failing(422, "challenge failed"));
    await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    advance(31_000);
    await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    const [a, b] = registrations().map((r) => (r.body as { challenge: string }).challenge);
    expect(a).not.toBe(b);
    db.close();
  });

  it("answers the route with 200 only for the value in flight, 404 before and after", async () => {
    let client!: RelayClient;
    const seen: { status: number; body: unknown }[] = [];
    const harness = setup(async (request) => {
      if (!request.url.endsWith("/servers")) return new Response(null, { status: 202 });
      const challenge = (JSON.parse(await request.clone().text()) as { challenge: string }).challenge;
      const app = appFor("selfhosted", client);
      for (const value of [challenge, `${challenge.slice(0, -1)}${challenge.endsWith("A") ? "B" : "A"}`, "short"]) {
        const res = await app.request(`/v1/relay-challenge/${value}`, {}, env);
        seen.push({ status: res.status, body: await res.json() });
      }
      return json(201, { relay_key: "rk_secretkey" });
    });
    client = harness.client;
    const challenge = (await (async () => { await client.forwardOne(baseEvent); return harness.registrations()[0]!.body as { challenge: string }; })()).challenge;
    expect(seen[0]).toEqual({ status: 200, body: { challenge } });
    expect(seen[1]).toEqual({ status: 404, body: { error: "not found" } });
    expect(seen[2]).toEqual({ status: 404, body: { error: "not found" } });
    // The call has returned, so the same value no longer answers.
    expect(client.isRelayChallenge(challenge)).toBe(false);
    const after = await appFor("selfhosted", client).request(`/v1/relay-challenge/${challenge}`, {}, env);
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual({ error: "not found" });
    harness.db.close();
  });

  it("stops answering after 60 seconds even while the call is still out", async () => {
    let client!: RelayClient; let advance!: (ms: number) => void;
    const results: boolean[] = [];
    const harness = setup(async (request) => {
      if (!request.url.endsWith("/servers")) return new Response(null, { status: 202 });
      const challenge = (JSON.parse(await request.clone().text()) as { challenge: string }).challenge;
      results.push(client.isRelayChallenge(challenge));
      advance(59_000); results.push(client.isRelayChallenge(challenge));
      advance(1_000); results.push(client.isRelayChallenge(challenge));
      return json(201, { relay_key: "rk_secretkey" });
    });
    client = harness.client; advance = harness.advance;
    await client.forwardOne(baseEvent);
    expect(results).toEqual([true, true, false]);
    harness.db.close();
  });

  it("answers 404 for everything before any registration", async () => {
    const { client, db } = setup(accepting);
    const res = await appFor("selfhosted", client).request("/v1/relay-challenge/" + "A".repeat(43), {}, env);
    expect(res.status).toBe(404);
    db.close();
  });
});

describe("challenge route and modes", () => {
  it("answers 404 in relay and hosted mode even for the value in flight", async () => {
    for (const mode of ["relay", "hosted"] as const) {
      let client!: RelayClient; let status = 0;
      const harness = setup(async (request) => {
        if (!request.url.endsWith("/servers")) return new Response(null, { status: 202 });
        const challenge = (JSON.parse(await request.clone().text()) as { challenge: string }).challenge;
        status = (await appFor(mode, client).request(`/v1/relay-challenge/${challenge}`, {}, env)).status;
        return json(201, { relay_key: "rk_secretkey" });
      });
      client = harness.client;
      await client.forwardOne(baseEvent);
      expect(status, mode).toBe(404);
      harness.db.close();
    }
  });

  it("needs no auth in selfhosted mode, and a publish to a topic still reaches the ingress router", async () => {
    const { client, db } = setup(accepting);
    const app = appFor("selfhosted", client);
    expect((await app.request("/v1/relay-challenge/" + "A".repeat(43), {}, env)).status).toBe(404);
    // No token: the ingress router answers its own 401, so it was not swallowed.
    const publish = await app.request("/prod", { method: "POST", body: "x" }, env);
    expect(publish.status).toBe(401);
    expect(await publish.json()).toMatchObject({ code: 40101 });
    db.close();
  });
});

describe("topic on the wire", () => {
  it("carries the topic name on every kind", async () => {
    const { client, pushes, db } = setup(accepting);
    for (const kind of ["open", "repeat", "reopen", "p4", "p5", "ack", "close", "expire"] as const) {
      await client.forwardOne({ ...baseEvent, kind, priority: kind === "p4" ? 4 : 5, incidentId: kind === "p4" ? null : "inc" });
    }
    expect(pushes().map((p) => (p.body as { kind: string; topic: string }).topic)).toEqual(Array(8).fill("prod"));
    expect(pushes()).toHaveLength(8);
    db.close();
  });

  it("keeps topic when relay content is full, with title and body", async () => {
    const { client, pushes, db } = setup(accepting, { relayContent: "full" });
    await client.forwardOne(baseEvent);
    expect(pushes()[0]!.body).toMatchObject({ topic: "prod", title: "T", body: "B" });
    db.close();
  });
});

describe("backoff", () => {
  it("makes far fewer registration calls than forwards", async () => {
    const { client, registrations, advance, db } = setup(failing(422, "challenge failed"));
    for (let i = 0; i < 20; i += 1) { await expect(client.forwardOne(baseEvent)).rejects.toBeInstanceOf(RelayKeyError); advance(1_000); }
    expect(registrations()).toHaveLength(1);
    db.close();
  });

  it("doubles the delay from 30 seconds and caps it at one hour", async () => {
    const { client, registrations, advance, db } = setup(failing(500, "boom"));
    const waits: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      await expect(client.forwardOne(baseEvent)).rejects.toThrow();
      const calls = registrations().length;
      let waited = 0;
      // Find the shortest wait, in whole seconds, after which a forward calls the relay again.
      for (;;) {
        advance(1_000); waited += 1_000;
        await client.forwardOne(baseEvent).catch(() => undefined);
        if (registrations().length > calls) break;
      }
      waits.push(waited / 1_000);
      expect(registrations()).toHaveLength(calls + 1);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
    db.close();
  });

  it("resets after a success", async () => {
    let ok = false;
    const { client, registrations, advance, db } = setup((request) => request.url.endsWith("/servers") ? (ok ? json(201, { relay_key: "rk_new" }) : json(500, { error: "boom" })) : new Response(null, { status: 202 }));
    await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    advance(30_000); await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    advance(60_000); ok = true;
    await client.forwardOne(baseEvent);
    expect(registrations()).toHaveLength(3);
    // Drop the key by hand, fail again: the wait starts at 30 seconds, not 120.
    db.prepare("DELETE FROM relay_client_credentials").run(); ok = false;
    await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    advance(30_000); await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    expect(registrations()).toHaveLength(5);
    db.close();
  });

  it("makes a forward during the wait fail without calling the relay", async () => {
    const { client, fetcher, advance, db } = setup(failing(429, "rate limited"));
    await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    const calls = fetcher.mock.calls.length;
    advance(10_000);
    await expect(client.forwardOne(baseEvent)).rejects.toBeInstanceOf(RelayKeyError);
    expect(fetcher.mock.calls.length).toBe(calls);
    db.close();
  });

  it("starts one registration for two forwards at once", async () => {
    const { client, registrations, pushes, db } = setup(accepting);
    await Promise.all([client.forwardOne(baseEvent), client.forwardOne(baseEvent)]);
    expect(registrations()).toHaveLength(1);
    expect(pushes()).toHaveLength(2);
    db.close();
  });
});

describe("registration log", () => {
  it("logs once per reason, again when the reason changes, and never the key, secret or challenge", async () => {
    let answer: Handler = failing(422, "challenge failed");
    const { client, logs, registrations, advance, db } = setup((request) => answer(request), { secret: "s3cret-value" });
    const attempt = async () => { advance(3_600_000); await client.forwardOne(baseEvent).catch(() => undefined); };
    await attempt(); await attempt(); await attempt();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "relay_registration_failed", reason: "challenge_failed", status: 422 });
    expect(String(logs[0]!.message)).toContain("https://a.test/v1/relay-challenge/");
    answer = failing(400, "invalid base_url");
    await attempt(); await attempt();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ reason: "invalid_base_url", status: 400 });
    expect(String(logs[1]!.message)).toContain("BASE_URL is set to https://a.test");
    const challenges = registrations().map((r) => (r.body as { challenge: string }).challenge);
    const text = JSON.stringify(logs);
    for (const secret of ["rk_", "s3cret-value", ...challenges]) expect(text).not.toContain(secret);
    db.close();
  });

  it("says plainly what happened for each other answer", async () => {
    const cases: [number, string, string][] = [[403, "registration closed", "registration_closed"], [429, "rate limited", "rate_limited"], [502, "bad gateway", "status_502"]];
    for (const [status, error, reason] of cases) {
      const { client, logs, db } = setup(failing(status, error));
      await client.forwardOne(baseEvent).catch(() => undefined);
      expect(logs[0], reason).toMatchObject({ event: "relay_registration_failed", reason, status });
      db.close();
    }
  });

  it("logs a network error and starts the backoff", async () => {
    const { client, logs, fetcher, db } = setup(() => { throw new TypeError("fetch failed"); });
    await client.forwardOne(baseEvent).catch(() => undefined);
    await client.forwardOne(baseEvent).catch(() => undefined);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ reason: "network" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    db.close();
  });
});

describe("a key that stopped working", () => {
  it("drops the key on 401, registers once more and retries the push once", async () => {
    let pushes = 0; let registrations = 0;
    const { client, db, requests } = setup((request) => {
      if (request.url.endsWith("/servers")) { registrations += 1; return json(201, { relay_key: `rk_${registrations}` }); }
      pushes += 1;
      return pushes === 1 ? json(401, { error: "unauthorized" }) : new Response(null, { status: 202 });
    });
    await client.forwardOne(baseEvent);
    await client.forwardOne(baseEvent);
    expect(registrations).toBe(2);
    expect(pushes).toBe(3);
    expect(requests.filter((r) => r.url.endsWith("/push")).map((r) => r.auth)).toEqual(["Bearer rk_1", "Bearer rk_2", "Bearer rk_2"]);
    db.close();
  });

  it("does not loop when the retry is a 401 too", async () => {
    const { client, pushes, registrations, db } = setup((request) => request.url.endsWith("/servers") ? json(201, { relay_key: "rk_x" }) : json(401, { error: "unauthorized" }));
    await expect(client.forwardOne(baseEvent)).rejects.toThrow("relay push failed: 401");
    expect(registrations()).toHaveLength(2);
    expect(pushes()).toHaveLength(2);
    db.close();
  });

  it("drops the key on 403 topic mismatch, logs one clear line and does not retry", async () => {
    const { client, logs, pushes, registrations, db } = setup((request) => request.url.endsWith("/servers") ? json(201, { relay_key: "rk_x" }) : json(403, { error: "topic mismatch" }));
    await expect(client.forwardOne(baseEvent)).rejects.toBeInstanceOf(RelayKeyError);
    expect(pushes()).toHaveLength(1);
    expect(registrations()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM relay_client_credentials").get()).toEqual({ n: 0 });
    const mismatch = logs.filter((l) => l.event === "relay_topic_mismatch");
    expect(mismatch).toHaveLength(1);
    expect(String(mismatch[0]!.hint)).toContain("BASE_URL");
    expect(JSON.stringify(logs)).not.toContain("rk_x");
    db.close();
  });

  it("registers again with the current base_url on the next forward after a mismatch", async () => {
    let mismatch = true;
    const { client, registrations, db } = setup((request) => request.url.endsWith("/servers") ? json(201, { relay_key: "rk_x" }) : (mismatch ? json(403, { error: "topic mismatch" }) : new Response(null, { status: 202 })));
    await expect(client.forwardOne(baseEvent)).rejects.toThrow();
    mismatch = false;
    await client.forwardOne(baseEvent);
    expect(registrations()).toHaveLength(2);
    db.close();
  });
});

describe("startup registration", () => {
  it("registers and logs one accepted line", async () => {
    const { client, logs, registrations, db } = setup(accepting);
    await client.registerAtStartup();
    expect(registrations()).toHaveLength(1);
    expect(logs).toEqual([expect.objectContaining({ event: "relay_registered" })]);
    db.close();
  });

  it("does not throw on a failure, logs it and starts the backoff", async () => {
    const { client, logs, registrations, db } = setup(failing(422, "challenge failed"));
    await expect(client.registerAtStartup()).resolves.toBeUndefined();
    expect(logs).toEqual([expect.objectContaining({ event: "relay_registration_failed", reason: "challenge_failed" })]);
    await client.forwardOne(baseEvent).catch(() => undefined);
    expect(registrations()).toHaveLength(1);
    db.close();
  });

  it("does not register again when a key is stored", async () => {
    const { client, registrations, db } = setup(accepting);
    await client.forwardOne(baseEvent);
    await client.registerAtStartup();
    expect(registrations()).toHaveLength(1);
    db.close();
  });
});
