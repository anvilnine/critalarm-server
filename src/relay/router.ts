import { capsFor } from "../tier/caps.js";
import type { Tier } from "../tier/types.js";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { bearerSecretMatches } from "../bearer.js";
import { relayKeyHash, newRelayKey } from "./client.js";
import type { RelayPayload } from "./types.js";
import type { DeliveryEvent } from "../incident/types.js";
import type { DispatchResult } from "../domain-events.js";
import type { Counters } from "../stats/counters.js";

export function createRelayRouter(db: Database.Database, dispatch: (event: DeliveryEvent) => Promise<DispatchResult | void>, counters: Counters, registrationSecret?: string): Hono {
  const router = new Hono();
  // Registration used to hand an rk_ key to anyone who asked, and that key
  // pushes to any topic_hash the holder can compute. The route exists only when
  // the operator sets a registration secret, and then only for a caller that
  // presents it.
  if (registrationSecret !== undefined && registrationSecret !== "") router.post("/relay/v1/servers", async (c) => {
    if (!bearerSecretMatches(c.req.header("authorization"), registrationSecret)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null) as { base_url?: unknown; version?: unknown } | null;
    if (body === null || typeof body.base_url !== "string" || typeof body.version !== "string") return c.json({ error: "invalid request" }, 400);
    const key = newRelayKey();
    db.prepare("INSERT INTO relay_servers (id, base_url, version, relay_key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(`rly_${crypto.randomUUID()}`, body.base_url, body.version, relayKeyHash(key), Math.floor(Date.now() / 1000));
    return c.json({ relay_key: key }, 201);
  });
  router.post("/relay/v1/push", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const key = /^Bearer (rk_[A-Za-z0-9_-]+)$/.exec(auth)?.[1];
    const keyHash = key === undefined ? undefined : relayKeyHash(key);
    if (keyHash === undefined || db.prepare("SELECT 1 FROM relay_servers WHERE relay_key_hash = ?").get(keyHash) === undefined) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null) as RelayPayload | null;
    if (body === null || !/^[0-9a-f]{64}$/.test(body.topic_hash) || !["open", "repeat", "reopen", "p4"].includes(body.kind)) return c.json({ error: "invalid request" }, 400);
    // The accounts this push is for. The pushing server's message_id has no row
    // here (api.md §4.1), so the relay establishes the owning accounts itself
    // and names one on every dispatch; the dispatcher never guesses. A hash this
    // relay already serves a topic for is not a remote topic: base_url is
    // server-wide, so a stranger can compute a hosted account's topic_hash from
    // the topic name, and a push for it is dropped rather than rung.
    const accounts = db.prepare("SELECT DISTINCT s.account_id, a.tier FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.topic_hash = ? AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.account_id = s.account_id AND t.topic_hash = s.topic_hash)").all(body.topic_hash) as { account_id: string; tier: Tier }[];
    if (body.kind === "p4") {
      const day = Math.floor(Date.now() / 1000 / 86400) * 86400;
      let eligible = 0;
      for (const account of accounts) {
        const row = db.prepare("SELECT count FROM relay_p4_usage WHERE account_id = ? AND day_start = ?").get(account.account_id, day) as { count: number } | undefined;
        if ((row?.count ?? 0) < capsFor(account.tier).p4_daily) { eligible += 1; db.prepare("INSERT INTO relay_p4_usage(account_id,day_start,count) VALUES(?,?,1) ON CONFLICT(account_id,day_start) DO UPDATE SET count=count+1").run(account.account_id, day); }
      }
      if (accounts.length > 0 && eligible === 0) return c.json({ error: "cap", cap: "p4_daily" }, 429);
    }
    const event: DeliveryEvent = { kind: body.kind, topicHash: body.topic_hash, topic: "", incidentId: body.incident_id, messageId: body.message_id, priority: body.priority, maxRingS: 1800, server: "", title: body.title ?? "Crit Alarm", body: body.body ?? "Critical alert", critical: body.priority === 5 };
    let delivered = 0;
    for (const account of accounts) {
      const result = await dispatch({ ...event, accountId: account.account_id });
      delivered += result?.delivered ?? 0;
    }
    // api.md §4.4. Counted here because this is the only place the pushing
    // server's relay key is known. One push is one event however many accounts
    // subscribe to the hash.
    counters.countEvents(keyHash, [event]);
    counters.add(keyHash, "pushes_delivered", delivered);
    console.log(JSON.stringify({ route: "/relay/v1/push", topic_hash: body.topic_hash, kind: body.kind, accounts: accounts.length }));
    return c.body(null, 202);
  });
  return router;
}
