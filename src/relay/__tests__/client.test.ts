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
    const event = { kind: "open" as const, topicHash: "a".repeat(64), topic: "prod", incidentId: "inc", messageId: "msg", priority: 5 as const, maxRingS: 10, server: "https://a.test", title: "T", body: "B", critical: true };
    await client.forwardOne(event); await client.forwardOne(event);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await calls[1].json()).not.toHaveProperty("body");
    db.close();
  });
});
