import { describe, expect, it, vi } from "vitest";
import { RelayClient } from "../client.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";

describe("relay client", () => {
  it("issues key once and serializes none/full payloads", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    const calls: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => { calls.push(request); if (request.url.endsWith("/servers")) return new Response(JSON.stringify({ relay_key: "rk_test" }), { status: 201 }); return new Response(null, { status: 202 }); });
    const client = new RelayClient({ db, relayUrl: "https://relay.test", baseUrl: "https://a.test", relayContent: "none", fetch: fetcher });
    const event = { kind: "open" as const, topicHash: "a".repeat(64), topic: "prod", incidentId: "inc", messageId: "msg", priority: 5 as const, maxRingS: 10, ringUntil: 1_010, server: "https://a.test", title: "T", body: "B", critical: true };
    await client.forwardOne(event); await client.forwardOne(event);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await calls[1].json()).not.toHaveProperty("body");
    db.close();
  });

  // api.md §4.1. The three state kinds ride the same route as the alarm kinds,
  // so a self-hosted server behind a relay can stop a second phone.
  it("forwards the state kinds", async () => {
    const { bodies, client, event, db } = harness();
    for (const kind of ["ack", "close", "expire"] as const) await client.forwardOne({ ...event, kind });
    expect(bodies.map((value) => (value as { kind: string }).kind)).toEqual(["ack", "close", "expire"]);
    db.close();
  });

  // api.md §4.1 and §5.1. A priority-5 message that joins an open incident is
  // forwarded with the incident and its ring window, so the phone behind the
  // relay hears about it.
  it("forwards a p5 that joins an open incident", async () => {
    const { bodies, client, event, db } = harness();
    await client.forwardOne({ ...event, kind: "p5", ringUntil: 1_010 });
    expect(bodies).toEqual([{ topic_hash: "a".repeat(64), incident_id: "inc", message_id: "msg", priority: 5, kind: "p5", ring_until: 1_010 }]);
    db.close();
  });

  // api.md §4.1. A p5 on a topic whose switch is off has no incident and no
  // ring window.
  it("forwards a p5 on a topic with the switch off, with no incident", async () => {
    const { bodies, client, event, db } = harness();
    await client.forwardOne({ ...event, kind: "p5", incidentId: null, ringUntil: null, critical: false });
    expect(bodies).toEqual([{ topic_hash: "a".repeat(64), incident_id: null, message_id: "msg", priority: 5, kind: "p5", ring_until: null }]);
    db.close();
  });

  it("sends the p5 title and body only under relay_content full", async () => {
    const { bodies, client, event, db } = harness("full");
    await client.forwardOne({ ...event, kind: "p5", ringUntil: 1_010 });
    expect(bodies[0]).toMatchObject({ kind: "p5", title: "T", body: "B" });
    db.close();
  });

  // The wire has no field for "this incident is acknowledged", so the relay
  // could not tell this push from one that should ring. It stays unsent, as it
  // was before p5 was forwarded at all.
  it("does not forward a p5 that joins an acknowledged incident", async () => {
    const { bodies, client, event, db } = harness();
    expect(await client.forwardOne({ ...event, kind: "p5", ringUntil: 1_010, critical: false })).toBeUndefined();
    expect(bodies).toEqual([]);
    db.close();
  });
});

function harness(relayContent: "none" | "full" = "none") {
  const db = openDatabase(":memory:"); migrate(db);
  const bodies: unknown[] = [];
  const fetcher = vi.fn(async (request: Request) => {
    if (request.url.endsWith("/servers")) return new Response(JSON.stringify({ relay_key: "rk_test" }), { status: 201 });
    bodies.push(await request.json());
    return new Response(null, { status: 202 });
  });
  const client = new RelayClient({ db, relayUrl: "https://relay.test", baseUrl: "https://a.test", relayContent, fetch: fetcher });
  const event = { kind: "open" as const, topicHash: "a".repeat(64), topic: "prod", incidentId: "inc" as string | null, messageId: "msg", priority: 5 as const, maxRingS: 10, ringUntil: null as number | null, server: "https://a.test", title: "T", body: "B", critical: true };
  return { db, bodies, client, event };
}
