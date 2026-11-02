import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { topicHash } from "../hash.js";
import { closeDatabases, newDb, world, type SelfHosted } from "./world.js";

// api.md §3.1 and §4.1, 1.21.0. A real relay router and real self-hosted apps
// with real relay clients, as in self-host-end-to-end.test.ts. No socket, no
// DNS, no secret.

const A = "https://a.example.com";
const NAME = "pagerduty-q9";

let spies: ReturnType<typeof vi.spyOn>[];
let printed: unknown[][];
beforeEach(() => {
  printed = [];
  spies = (["log", "error", "warn", "info"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args); }));
});
afterEach(() => { for (const spy of spies) spy.mockRestore(); closeDatabases(); });

const relayNameOf = (server: SelfHosted, name = NAME): string => (server.db.prepare("SELECT relay_name FROM topics WHERE name = ?").get(name) as { relay_name: string }).relay_name;

describe.each([{ plainHash: true }, { plainHash: false }])("relay-plain-hash $plainHash", ({ plainHash }) => {
  it("rings a phone subscribed to the secret hash, once", async () => {
    const w = world({ plainHash });
    const a = w.selfHosted(A);
    const token = await a.topic(NAME);
    const relayName = relayNameOf(a);
    expect(relayName).toMatch(/^[-_A-Za-z0-9]{43}$/);
    const phone = w.phone(topicHash(A, relayName));

    expect((await a.publish(NAME, token)).status).toBe(200);

    expect(a.errors).toEqual([]);
    expect(w.sent).toEqual([{ device: phone, kind: "open", topicHash: topicHash(A, relayName) }]);
  });
});

describe("the plain hash", () => {
  it("rings a phone subscribed to the plain hash while the setting is on", async () => {
    const w = world({ plainHash: true });
    const a = w.selfHosted(A);
    const token = await a.topic(NAME);
    const phone = w.phone(topicHash(A, NAME));

    await a.publish(NAME, token);

    expect(a.errors).toEqual([]);
    expect(w.sent).toEqual([{ device: phone, kind: "open", topicHash: topicHash(A, NAME) }]);
  });

  it("is sent as a second push with the same incident, message and ring window", async () => {
    const w = world({ plainHash: true });
    const a = w.selfHosted(A);
    const token = await a.topic(NAME);

    await a.publish(NAME, token);

    const [secret, plain] = w.relayPushBodies;
    expect(w.relayPushBodies).toHaveLength(2);
    expect(secret).toMatchObject({ topic: relayNameOf(a), topic_hash: topicHash(A, relayNameOf(a)) });
    expect(plain).toMatchObject({ topic: NAME, topic_hash: topicHash(A, NAME) });
    for (const key of ["incident_id", "message_id", "kind", "ring_until", "priority"]) expect(plain?.[key]).toEqual(secret?.[key]);
  });

  it("rings nobody on the plain hash when the setting is off", async () => {
    const w = world({ plainHash: false });
    const a = w.selfHosted(A);
    const token = await a.topic(NAME);
    w.phone(topicHash(A, NAME));

    await a.publish(NAME, token);

    expect(a.errors).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("keeps a stranger who guessed the name off the topic when the setting is off, and the real phone rings", async () => {
    const w = world({ plainHash: false });
    const a = w.selfHosted(A);
    const token = await a.topic(NAME);
    const owner = w.phone(topicHash(A, relayNameOf(a)));
    const stranger = w.phone(topicHash(A, NAME));

    await a.publish(NAME, token);

    expect(w.sent.map((entry) => entry.device)).toEqual([owner]);
    expect(w.sent.some((entry) => entry.device === stranger)).toBe(false);
  });

  it("never sends the relay the topic's name when the setting is off", async () => {
    const w = world({ plainHash: false });
    const a = w.selfHosted(A);
    const token = await a.topic(NAME);
    w.phone(topicHash(A, relayNameOf(a)));

    await a.publish(NAME, token);
    await a.publish(NAME, token);

    expect(w.relayPushBodies).toHaveLength(2);
    for (const body of w.relayPushBodies) {
      expect(body.topic).toBe(relayNameOf(a));
      expect(JSON.stringify(body)).not.toContain(NAME);
    }
  });
});

describe("key recovery for the secret push", () => {
  it("answers 401 to an old key, registers once and retries the secret push once", async () => {
    const w = world({ plainHash: false });
    const old = w.selfHosted(A);
    const tokenOld = await old.topic(NAME);
    const relayName = relayNameOf(old);
    const phone = w.phone(topicHash(A, relayName));
    await old.publish(NAME, tokenOld);
    const oldKey = w.keyOf(old);

    // The same address comes back with an empty database and takes the relay's key slot.
    const fresh = w.selfHosted(A);
    await fresh.publish(NAME, await fresh.topic(NAME));
    expect(w.keyOf(fresh)).not.toBe(oldKey);

    w.servers.set(A, old);
    w.sent.length = 0;
    w.relayCalls.length = 0;
    await old.publish(NAME, tokenOld);

    expect(old.errors).toEqual([]);
    expect(w.relayCalls).toEqual(["POST /relay/v1/push", "POST /relay/v1/servers", "POST /relay/v1/push"]);
    expect(w.sent.map((entry) => entry.device)).toEqual([phone]);
  });

  it("replaces a key from an older base_url on a topic made under it, because the secret hash is worked out fresh", async () => {
    const w = world({ plainHash: false });
    const db = newDb();
    const before = w.selfHosted(A, db);
    const tokenOld = await before.topic(NAME);
    await before.publish(NAME, tokenOld);
    const oldKey = w.keyOf(before);
    expect(oldKey).toMatch(/^rk_/);

    // Same database and key, new BASE_URL. The topic was made under the old one.
    const moved = "https://moved.example.com";
    const after = w.selfHosted(moved, db);
    const phone = w.phone(topicHash(moved, relayNameOf(after)));
    w.sent.length = 0;
    w.relayCalls.length = 0;
    after.lines.length = 0;

    await after.publish(NAME, tokenOld);

    expect(after.errors).toEqual([]);
    expect(after.lines.map((line) => line.event)).toEqual(["relay_key_replaced", "relay_registered"]);
    expect(after.lines.map((line) => line.event)).not.toContain("relay_topic_other_base_url");
    expect(w.keyOf(after)).not.toBe(oldKey);
    expect(w.sent).toEqual([{ device: phone, kind: "p5", topicHash: topicHash(moved, relayNameOf(after)) }]);
    expect(w.relayCalls).toEqual(["POST /relay/v1/push", "POST /relay/v1/servers", "POST /relay/v1/push"]);
  });

  it("recovers the secret push and still sends the plain one once, while the setting is on", async () => {
    const w = world({ plainHash: true });
    const old = w.selfHosted(A);
    const tokenOld = await old.topic(NAME);
    const secretPhone = w.phone(topicHash(A, relayNameOf(old)));
    const plainPhone = w.phone(topicHash(A, NAME));
    await old.publish(NAME, tokenOld);
    const fresh = w.selfHosted(A);
    await fresh.publish(NAME, await fresh.topic(NAME));
    w.servers.set(A, old);
    w.sent.length = 0;
    w.relayPushBodies.length = 0;

    await old.publish(NAME, tokenOld);

    expect(old.errors).toEqual([]);
    expect(w.sent.map((entry) => entry.device).sort()).toEqual([secretPhone, plainPhone].sort());
    // The 401 push, its retry, and the plain push: the plain one is not sent twice.
    expect(w.relayPushBodies.filter((body) => body.topic === NAME)).toHaveLength(1);
    expect(w.relayPushBodies.filter((body) => body.topic !== NAME)).toHaveLength(2);
  });
});

describe("logs", () => {
  it("carry no relay name, through registration, key recovery and a topic made under another base_url", async () => {
    const w = world({ plainHash: true });
    const db = newDb();
    const before = w.selfHosted(A, db);
    const tokenOld = await before.topic(NAME);
    await before.publish(NAME, tokenOld);
    const moved = "https://moved.example.com";
    const after = w.selfHosted(moved, db);
    await after.topic("web");
    await after.publish(NAME, tokenOld);
    await after.publish(NAME, tokenOld);

    const names = [NAME, "web"].map((name) => relayNameOf(after, name));
    const everything = JSON.stringify([before.lines, after.lines, after.errors.map(String), printed]);
    expect(before.lines.length + after.lines.length).toBeGreaterThan(0);
    for (const relayName of names) expect(everything).not.toContain(relayName);
  });
});
