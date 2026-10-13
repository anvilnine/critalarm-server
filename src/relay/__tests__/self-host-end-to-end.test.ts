import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { topicHash } from "../hash.js";
import { closeDatabases, newDb, RELAY_URL, world } from "./world.js";

// api.md §3.8 and §4.1, both halves at once. A real relay router and real
// self-hosted apps with real relay clients, joined by injected functions only.
// No socket, no DNS, no secret. The setup is in world.ts.

let logs: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logs = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { logs.mockRestore(); closeDatabases(); });

const A = "https://a.example.com";
const B = "https://b.example.com";

describe("a self-hosted server and the relay, joined", () => {
  it("registers a fresh server through the challenge with no secret, and rings a phone on its topic hash", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const token = await a.topic("prod");
    const phone = w.phone(topicHash(A, "prod"));

    expect(w.keyOf(a)).toBe("");
    const response = await a.publish("prod", token);

    expect(response.status).toBe(200);
    expect(a.errors).toEqual([]);
    expect(w.keyOf(a)).toMatch(/^rk_/);
    expect(w.confirmed).toEqual([true]);
    expect(a.lines.map((line) => line.event)).toEqual(["relay_registered"]);
    expect(w.sent).toEqual([{ device: phone, kind: "open", topicHash: topicHash(A, "prod") }]);
    // A fresh challenge was used and it is closed again.
    expect(a.client.isRelayChallenge("anything")).toBe(false);
  });

  it("keeps two servers with the same topic name apart, and a hosted account's own prod out of both", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const b = w.selfHosted(B);
    const tokenA = await a.topic("prod");
    const tokenB = await b.topic("prod");
    const phoneA = w.phone(topicHash(A, "prod"));
    const phoneB = w.phone(topicHash(B, "prod"));
    // A hosted account that owns its own topic "prod" on this relay.
    w.relayDb.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc_hosted','hosted',1)").run();
    w.relayDb.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_hosted','acc_hosted','h','ios','token',1)").run();
    const hostedHash = topicHash(RELAY_URL, "prod");
    w.relayDb.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_h','acc_hosted','prod',?,?,1,30,60,30,'none',1)").run(RELAY_URL, hostedHash);
    w.relayDb.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_hosted',?)").run(hostedHash);

    await a.publish("prod", tokenA);
    expect(w.sent.map((entry) => entry.device)).toEqual([phoneA]);
    await b.publish("prod", tokenB);

    expect(w.sent.map((entry) => entry.device)).toEqual([phoneA, phoneB]);
    expect(w.sent.some((entry) => entry.device === "dev_hosted")).toBe(false);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it("refuses a stranger who claims another server's base_url, and the real key keeps working", async () => {
    const w = world();
    const b = w.selfHosted(B);
    const tokenB = await b.topic("prod");
    const phoneB = w.phone(topicHash(B, "prod"));
    await b.publish("prod", tokenB);
    expect(w.sent).toHaveLength(1);

    // The stranger has its own database and its own challenge. Only B's app can
    // answer at B's address, and B never made that challenge.
    const stranger = w.selfHosted(B, newDb(), false);
    const mallory = await w.router.request("/relay/v1/servers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_url: B, version: "1", challenge: "c".repeat(43) }) });
    expect(mallory.status).toBe(422);
    expect(await mallory.json()).toEqual({ error: "challenge failed" });
    await expect(stranger.client.forwardOne({ kind: "open", topicHash: topicHash(B, "prod"), topic: "prod", incidentId: "i", messageId: "m", priority: 5, maxRingS: 60, ringUntil: 99, server: B, title: "T", body: "B", critical: true })).rejects.toThrow("relay registration failed: challenge_failed");
    expect(stranger.lines.map((line) => line.reason)).toEqual(["challenge_failed"]);

    await b.publish("prod", tokenB);
    expect(b.errors).toEqual([]);
    expect(w.sent.map((entry) => entry.device)).toEqual([phoneB, phoneB]);
  });

  it("refuses a registration that a second relay replays to the first, because the challenge names the second relay", async () => {
    const w = world();
    const replayed: { status: number; body: unknown }[] = [];
    // A second relay that is not the one RELAY_URL names. It receives the
    // server's registration and sends the same base_url and challenge on to the
    // first relay, as a hostile operator would.
    const secondRelay = async (request: Request): Promise<Response> => {
      const text = await request.clone().text();
      let last: Response | undefined;
      // It sends whatever Host it likes, its own name and the first relay's.
      for (const host of ["second-relay.example.net", new URL(RELAY_URL).host]) {
        last = await w.router.request("/relay/v1/servers", { method: "POST", headers: { "content-type": "application/json", host }, body: text });
        replayed.push({ status: last.status, body: await last.clone().json() });
      }
      return last as Response;
    };
    const a = w.selfHosted(A, newDb(), true, { relayUrl: "https://second-relay.example.net", fetch: secondRelay });
    const token = await a.topic("prod");
    w.phone(topicHash(A, "prod"));

    expect((await a.publish("prod", token)).status).toBe(200);

    expect(replayed).toEqual([{ status: 422, body: { error: "challenge failed" } }, { status: 422, body: { error: "challenge failed" } }]);
    expect(w.confirmed).toEqual([false, false]);
    expect(w.relayDb.prepare("SELECT COUNT(*) AS n FROM relay_servers").get()).toEqual({ n: 0 });
    expect(a.lines.map((line) => line.reason)).toEqual(["challenge_failed"]);
    expect(w.sent).toEqual([]);

    // Called as itself, the same server gets its key from the same relay.
    const own = w.selfHosted(B);
    const tokenOwn = await own.topic("prod");
    await own.publish("prod", tokenOwn);
    expect(w.keyOf(own)).toMatch(/^rk_/);
    expect(w.confirmed).toEqual([false, false, true]);
  });

  it("stops a key holder from ringing another server's phone", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const b = w.selfHosted(B);
    const tokenA = await a.topic("prod");
    await b.topic("prod");
    const phoneA = w.phone(topicHash(A, "prod"));
    w.phone(topicHash(B, "prod"));
    await a.publish("prod", tokenA);
    const keyA = w.keyOf(a);
    expect(keyA).toMatch(/^rk_/);
    w.sent.length = 0;

    const hashB = topicHash(B, "prod");
    expect((await w.rawPush(keyA, { topic_hash: hashB })).status).toBe(400);
    expect((await w.rawPush(keyA, { topic_hash: hashB, topic: "prod" })).status).toBe(403);
    expect((await w.rawPush(keyA, { topic_hash: hashB, topic: "x/prod" })).status).toBe(400);
    expect((await w.rawPush(keyA, { topic_hash: hashB, topic: "../b.example.com/prod" })).status).toBe(400);
    expect((await w.rawPush(keyA, { topic_hash: topicHash(A, "prod"), topic: "a.example.com/prod" })).status).toBe(400);
    expect(w.sent).toEqual([]);
    // The same key still reaches its own server's phone.
    expect((await w.rawPush(keyA, { topic_hash: topicHash(A, "prod"), topic: "prod" })).status).toBe(202);
    expect(w.sent.map((entry) => entry.device)).toEqual([phoneA]);
  });

  it("answers the old key 401 after a server that lost its database registers again, and the old holder recovers on its own", async () => {
    const w = world();
    const old = w.selfHosted(B);
    const tokenOld = await old.topic("prod");
    const phone = w.phone(topicHash(B, "prod"));
    await old.publish("prod", tokenOld);
    const oldKey = w.keyOf(old);
    w.sent.length = 0;

    // B comes back with an empty database at the same address.
    const fresh = w.selfHosted(B);
    const tokenFresh = await fresh.topic("prod");
    await fresh.publish("prod", tokenFresh);
    const freshKey = w.keyOf(fresh);
    expect(freshKey).not.toBe(oldKey);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone]);
    expect((await w.rawPush(oldKey, { topic_hash: topicHash(B, "prod"), topic: "prod" })).status).toBe(401);
    expect(w.relayDb.prepare("SELECT COUNT(*) AS n FROM relay_servers WHERE base_url = ?").get(B)).toEqual({ n: 1 });

    // The old holder is the same server (the address answers as it again). Its
    // next forward gets 401, registers once and retries once.
    w.servers.set(B, old);
    w.sent.length = 0;
    w.relayCalls.length = 0;
    await old.publish("prod", tokenOld);

    expect(old.errors).toEqual([]);
    // The secret push meets the 401 and recovers the key. The plain push follows with the new key.
    expect(w.relayCalls).toEqual(["POST /relay/v1/push", "POST /relay/v1/servers", "POST /relay/v1/push", "POST /relay/v1/push"]);
    expect(w.keyOf(old)).not.toBe(oldKey);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone]);
  });

  it("logs one actionable line when the relay has closed registration, backs off, and makes no call inside the wait", async () => {
    const w = world({ registration: "closed" });
    const a = w.selfHosted(A);
    const token = await a.topic("prod");
    w.phone(topicHash(A, "prod"));

    expect((await a.publish("prod", token)).status).toBe(200);
    expect(w.relayCalls).toEqual(["POST /relay/v1/servers"]);
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]).toMatchObject({ event: "relay_registration_failed", reason: "registration_closed", status: 403 });
    expect(String(a.lines[0]?.message)).toContain("RELAY_URL");

    w.clock.ms += 10_000;
    await a.publish("prod", token);
    expect(w.relayCalls).toEqual(["POST /relay/v1/servers"]);
    expect(a.lines).toHaveLength(1);
    expect(a.errors).toHaveLength(2);
    expect(w.sent).toEqual([]);

    // After the 30 second gap it tries again, once, and logs nothing new for the same reason.
    w.clock.ms += 30_000;
    await a.publish("prod", token);
    expect(w.relayCalls).toEqual(["POST /relay/v1/servers", "POST /relay/v1/servers"]);
    expect(a.lines).toHaveLength(1);
  });

  it("replaces a key from an older base_url on the first alarm of a topic made under the new one, and delivers that alarm", async () => {
    const w = world();
    const db = newDb();
    const before = w.selfHosted(A, db);
    const tokenProd = await before.topic("prod");
    await before.publish("prod", tokenProd);
    const oldKey = w.keyOf(before);
    expect(oldKey).toMatch(/^rk_/);

    // Same database, same key, new BASE_URL. A topic made now hashes the new address.
    const moved = "https://moved.example.com";
    const after = w.selfHosted(moved, db);
    const tokenWeb = await after.topic("web");
    const phone = w.phone(topicHash(moved, "web"));
    expect(w.keyOf(after)).toBe(oldKey);

    await after.publish("web", tokenWeb);
    expect(after.lines.map((line) => line.event)).toEqual(["relay_key_replaced", "relay_registered"]);
    expect(after.errors).toEqual([]);
    expect(w.keyOf(after)).toMatch(/^rk_/);
    expect(w.keyOf(after)).not.toBe(oldKey);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone]);

    // The next alarm needs no second registration.
    w.relayCalls.length = 0;
    await after.publish("web", tokenWeb);
    // One push for the secret hash and one for the plain hash.
    expect(w.relayCalls).toEqual(["POST /relay/v1/push", "POST /relay/v1/push"]);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone, phone]);
  });

  it("keeps a good key and says once per topic that a topic made under the old base_url cannot ring", async () => {
    const w = world();
    const db = newDb();
    const before = w.selfHosted(A, db);
    const tokenProd = await before.topic("prod");
    const oldPhone = w.phone(topicHash(A, "prod"));
    await before.publish("prod", tokenProd);
    expect(w.sent.map((entry) => entry.device)).toEqual([oldPhone]);

    const moved = "https://moved.example.com";
    const after = w.selfHosted(moved, db);
    const tokenWeb = await after.topic("web");
    const newPhone = w.phone(topicHash(moved, "web"));
    // The first alarm of a topic made under the new address replaces the key.
    await after.publish("web", tokenWeb);
    const key = w.keyOf(after);
    expect(w.sent.map((entry) => entry.device)).toEqual([oldPhone, newPhone]);
    after.lines.length = 0;
    w.relayCalls.length = 0;

    // The old topic hashes the old address. The key under the new address is
    // right, so the client keeps it and registers nothing.
    for (let i = 0; i < 3; i += 1) await after.publish("prod", tokenProd);
    expect(w.relayCalls).toEqual(Array(6).fill("POST /relay/v1/push"));
    expect(w.keyOf(after)).toBe(key);
    expect(after.errors).toHaveLength(3);
    expect(after.lines.map((line) => line.event)).toEqual(["relay_topic_other_base_url"]);
    expect(String(after.lines[0]?.message)).toContain("Delete the topic and create it again");
    expect(w.sent.map((entry) => entry.device)).toEqual([oldPhone, newPhone]);

    // The topic made under the new address still rings with the same key.
    await after.publish("web", tokenWeb);
    expect(w.sent.map((entry) => entry.device)).toEqual([oldPhone, newPhone, newPhone]);
    expect(w.keyOf(after)).toBe(key);
  });

  it("has the relay route accept every kind the real client forwards with 202", async () => {
    const w = world();
    const a = w.selfHosted(A);
    const base = { topicHash: topicHash(A, "prod"), topic: "prod", incidentId: "inc_1", messageId: "m_1", priority: 5 as const, maxRingS: 60, ringUntil: 2_000_000_000, server: A, title: "T", body: "B", critical: true };
    const kinds = ["open", "repeat", "reopen", "p4", "p5", "ack", "close", "expire"] as const;
    const statuses: number[] = [];
    for (const kind of kinds) {
      const response = await a.client.forwardOne({ ...base, kind, priority: kind === "p4" ? 4 : 5, incidentId: kind === "p4" ? null : "inc_1", ringUntil: kind === "p4" || kind === "ack" || kind === "close" || kind === "expire" ? null : base.ringUntil });
      statuses.push(response?.status ?? 0);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 202, 202]);
    expect(a.errors).toEqual([]);
  });
});
