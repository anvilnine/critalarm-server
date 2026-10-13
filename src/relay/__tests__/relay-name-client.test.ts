import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { RelayClient } from "../client.js";
import { topicHash } from "../hash.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { newRelayName } from "../../v1/topics.js";

// api.md §4.1, 1.21.0. The client against a stub relay: what it sends for a
// topic with a relay name, and what one failing push does to the other.

const BASE = "https://a.example.com";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function harness(options: { plainHash?: boolean; reply?: (body: { topic: string }, attempt: number) => Response } = {}) {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const relayName = newRelayName();
  db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('acc',  'free',1)").run();
  db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at,relay_name) VALUES ('top','acc','prod',?,?,1,30,60,30,'none',1,?)").run(BASE, topicHash(BASE, "prod"), relayName);
  const pushes: { topic_hash: string; topic: string; message_id: string }[] = [];
  const attempts = new Map<string, number>();
  const fetcher = async (request: Request): Promise<Response> => {
    if (request.url.endsWith("/servers")) return new Response(JSON.stringify({ relay_key: "rk_test" }), { status: 201 });
    const body = await request.json() as { topic_hash: string; topic: string; message_id: string };
    pushes.push(body);
    const attempt = (attempts.get(body.topic) ?? 0) + 1;
    attempts.set(body.topic, attempt);
    return options.reply?.(body, attempt) ?? new Response(null, { status: 202 });
  };
  const client = new RelayClient({ db, relayUrl: "https://relay.test", baseUrl: BASE, relayContent: "none", ...(options.plainHash === undefined ? {} : { plainHash: options.plainHash }), fetch: fetcher, log: () => {} });
  const event = { kind: "open" as const, topicHash: topicHash(BASE, "prod"), topic: "prod", incidentId: "inc", messageId: "msg", priority: 5 as const, maxRingS: 10, ringUntil: 1_010, server: BASE, title: "T", body: "B", critical: true };
  return { client, event, pushes, relayName, db };
}

describe("a topic with a relay name", () => {
  it("is pushed on the secret hash with the relay name as topic, and then on the plain hash", async () => {
    const { client, event, pushes, relayName } = harness();
    await client.forwardOne(event);
    expect(pushes.map((push) => [push.topic, push.topic_hash])).toEqual([[relayName, topicHash(BASE, relayName)], ["prod", topicHash(BASE, "prod")]]);
  });

  it("works the secret hash out from the BASE_URL the client runs with, not the stored base_url", async () => {
    const { client, event, pushes, relayName, db } = harness({ plainHash: false });
    db.prepare("UPDATE topics SET base_url = 'https://old.example.com'").run();
    await client.forwardOne(event);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.topic_hash).toBe(topicHash(BASE, relayName));
  });

  it("sends only the secret push when the setting is off", async () => {
    const { client, event, pushes, relayName } = harness({ plainHash: false });
    await client.forwardOne(event);
    expect(pushes.map((push) => push.topic)).toEqual([relayName]);
  });

  it("still sends the plain push when the secret push fails, and raises the failure", async () => {
    const { client, event, pushes, relayName } = harness({ reply: (body) => new Response(null, { status: body.topic === "prod" ? 202 : 500 }) });
    await expect(client.forwardOne(event)).rejects.toThrow("relay push failed: 500");
    expect(pushes.map((push) => push.topic)).toEqual([relayName, "prod"]);
  });

  it("still sends the secret push when the plain push fails, and raises the failure", async () => {
    const { client, event, pushes, relayName } = harness({ reply: (body) => new Response(null, { status: body.topic === "prod" ? 500 : 202 }) });
    await expect(client.forwardOne(event)).rejects.toThrow("relay push failed: 500");
    expect(pushes.map((push) => push.topic)).toEqual([relayName, "prod"]);
  });

  it("retries only the push that met a 401, so the other is not sent twice", async () => {
    const { client, event, pushes, relayName } = harness({ reply: (body, attempt) => new Response(null, { status: body.topic !== "prod" && attempt === 1 ? 401 : 202 }) });
    await client.forwardOne(event);
    expect(pushes.map((push) => push.topic)).toEqual([relayName, relayName, "prod"]);
  });

  it("sends the plain push alone for a topic without a relay name", async () => {
    const { client, event, pushes, db } = harness({ plainHash: false });
    db.prepare("UPDATE topics SET relay_name = NULL").run();
    await client.forwardOne(event);
    expect(pushes.map((push) => push.topic)).toEqual(["prod"]);
  });
});
