import { capsFor } from "../tier/caps.js";
import type { Tier } from "../tier/types.js";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { bearerSecretMatches } from "../bearer.js";
import { relayKeyHash, newRelayKey } from "./client.js";
import type { RelayPayload } from "./types.js";
import type { Clock, DeliveryEvent } from "../incident/types.js";
import type { DispatchResult } from "../domain-events.js";
import type { Counters } from "../stats/counters.js";
import { clientIp, clientKey, type ProxyTrust } from "../rate-limit.js";
import { parseBaseUrl } from "./base-url.js";
import { confirmChallenge, type ChallengeConfirmer } from "./challenge.js";
import { topicHash } from "./hash.js";
import { readJson } from "../body-limit.js";

// A p5 with no incident is a priority-5 message on a topic whose switch is off.
// It is a plain notification and never rings. Every other kind keeps the rule
// the relay always had.
function isCritical(body: RelayPayload): boolean {
  if (body.kind === "p5" && !body.incident_id) return false;
  return body.priority === 5;
}

const REGISTRATION_RATE = { limit: 5, windowS: 60 };
const REGISTRATION_DAILY_CAP = 20;
// Challenge confirmations running at once. Each one holds a DNS query and a
// connection to a host the caller picked, so the count stays small.
const MAX_CONFIRMATIONS_IN_FLIGHT = 4;
// Confirmations started per window, across all clients.
const GLOBAL_STARTS = { limit: 60, windowS: 60 };
const RATE_LIMITED = { code: 42901, http: 429, error: "rate limited" } as const;

// Largest body each route reads. A registration is a URL, a version and a
// challenge. A push may carry a title and a body of 4096 bytes each, and JSON escaping can turn one
// character into six bytes.
const MAX_REGISTRATION_BYTES = 4096;
const MAX_PUSH_BYTES = 65536;

export interface RelayRouterOptions {
  // Lets a caller of POST /relay/v1/servers skip the challenge (api.md §4.1).
  registrationSecret?: string;
  registration?: "open" | "closed";
  behindProxy?: ProxyTrust;
  confirmChallenge?: ChallengeConfirmer;
  // The relay's own public host names, from configuration. A challenge answer
  // must name one of them. Never read from the request.
  publicHosts?: readonly string[];
  clock?: Clock;
}

export function createRelayRouter(db: Database.Database, dispatch: (event: DeliveryEvent) => Promise<DispatchResult | void>, counters: Counters, options: RelayRouterOptions = {}): Hono {
  const router = new Hono();
  const confirm = options.confirmChallenge ?? confirmChallenge;
  const clock: Clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
  const secret = options.registrationSecret === undefined || options.registrationSecret === "" ? undefined : options.registrationSecret;
  const publicHosts = options.publicHosts ?? [];
  let inFlight = 0;

  // A rolling window kept in memory. `allowed` only looks, and `record` counts,
  // so a call that another limit turns away is not charged to this one.
  function slidingWindow(limit: number, windowS: number) {
    const hits = new Map<string, number[]>();
    let sweptAt = 0;
    const live = (key: string, now: number): number[] => (hits.get(key) ?? []).filter((time) => time > now - windowS);
    return {
      allowed(key: string): boolean {
        const now = clock.now();
        // Drop idle keys once per window so the table follows the traffic.
        if (now - sweptAt >= windowS) { sweptAt = now; for (const [other, times] of hits) if (!times.some((time) => time > now - windowS)) hits.delete(other); }
        return live(key, now).length < limit;
      },
      record(key: string): void {
        const now = clock.now();
        hits.set(key, [...live(key, now), now]);
      },
    };
  }
  const clientWindow = slidingWindow(REGISTRATION_RATE.limit, REGISTRATION_RATE.windowS);
  // Wrong operator secrets, counted per client on their own, so a guess at the
  // secret is limited at any speed and a right guess is not charged.
  const secretWindow = slidingWindow(REGISTRATION_RATE.limit, REGISTRATION_RATE.windowS);
  // Confirmations started, across all clients.
  const startedWindow = slidingWindow(GLOBAL_STARTS.limit, GLOBAL_STARTS.windowS);
  const GLOBAL = "all";

  function dailyAllowed(client: string): boolean {
    const day = Math.floor(clock.now() / 86400) * 86400;
    const row = db.prepare("SELECT count FROM relay_registration_attempts WHERE client = ? AND day_start = ?").get(client, day) as { count: number } | undefined;
    return (row?.count ?? 0) < REGISTRATION_DAILY_CAP;
  }
  // The daily count lives in SQLite so a restart does not reset it. Only a call
  // that gets through is counted against the day.
  function recordDaily(client: string): void {
    const day = Math.floor(clock.now() / 86400) * 86400;
    db.prepare("INSERT INTO relay_registration_attempts(client,day_start,count) VALUES(?,?,1) ON CONFLICT(client,day_start) DO UPDATE SET count=count+1").run(client, day);
    db.prepare("DELETE FROM relay_registration_attempts WHERE day_start < ?").run(day);
  }

  function issueKey(baseUrl: string, version: string): string {
    const key = newRelayKey();
    // One live key per base_url. The old key answers 401 from the next push on.
    db.transaction(() => {
      db.prepare("DELETE FROM relay_servers WHERE base_url = ? AND legacy = 0").run(baseUrl);
      db.prepare("INSERT INTO relay_servers (id, base_url, version, relay_key_hash, created_at, legacy) VALUES (?, ?, ?, ?, ?, 0)").run(`rly_${crypto.randomUUID()}`, baseUrl, version, relayKeyHash(key), clock.now());
    })();
    return key;
  }

  const logRegistration = (outcome: string, host?: string) => console.log(JSON.stringify({ route: "/relay/v1/servers", outcome, ...(host === undefined ? {} : { host }) }));

  // api.md §4.1. A key is issued to a server that proves it answers at its
  // base_url, or to a caller that holds the operator's secret.
  router.post("/relay/v1/servers", async (c) => {
    const authorization = c.req.header("authorization");
    const hasSecret = secret !== undefined && authorization !== undefined && /^Bearer /.test(authorization);
    if (hasSecret) {
      // A right secret always passes. Only wrong ones are counted, and more
      // than 5 in 60 seconds from one client is 429, so the secret cannot be
      // guessed at any speed and cannot be used to lock the operator out.
      if (!bearerSecretMatches(authorization, secret ?? "")) {
        const guesser = clientKey(clientIp(c, options.behindProxy ?? false));
        if (!secretWindow.allowed(guesser)) { logRegistration("rate limited"); return c.json(RATE_LIMITED, 429); }
        secretWindow.record(guesser); logRegistration("unauthorized"); return c.json({ error: "unauthorized" }, 401);
      }
    }
    if (!hasSecret && options.registration === "closed") { logRegistration("closed"); return c.json({ error: "registration closed" }, 403); }
    const read = await readJson(c.req.raw, MAX_REGISTRATION_BYTES);
    if (read === "too large") { logRegistration("invalid request"); return c.json({ error: "invalid request" }, 400); }
    const body = (read ?? null) as { base_url?: unknown; version?: unknown; challenge?: unknown } | null;
    if (body === null || typeof body !== "object" || typeof body.base_url !== "string" || typeof body.version !== "string" || body.base_url === "" || body.version.length > 200) { logRegistration("invalid request"); return c.json({ error: "invalid request" }, 400); }
    if (hasSecret) {
      if (body.base_url.length > 200) { logRegistration("invalid base_url"); return c.json({ error: "invalid base_url" }, 400); }
      const key = issueKey(body.base_url, body.version);
      logRegistration("issued_with_secret");
      return c.json({ relay_key: key }, 201);
    }
    if (typeof body.challenge !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(body.challenge)) { logRegistration("invalid request"); return c.json({ error: "invalid request" }, 400); }
    const parsed = parseBaseUrl(body.base_url);
    if (parsed === undefined) { logRegistration("invalid base_url"); return c.json({ error: "invalid base_url" }, 400); }
    // IPv6 clients count by /64, and a typed header cannot grow the key.
    const client = clientKey(clientIp(c, options.behindProxy ?? false));
    if (inFlight >= MAX_CONFIRMATIONS_IN_FLIGHT || !startedWindow.allowed(GLOBAL) || !clientWindow.allowed(client) || !dailyAllowed(client)) { logRegistration("rate limited", parsed.host); return c.json(RATE_LIMITED, 429); }
    clientWindow.record(client); recordDaily(client); startedWindow.record(GLOBAL);
    inFlight += 1;
    let confirmed: boolean;
    try { confirmed = await confirm(body.base_url, body.challenge, publicHosts); } finally { inFlight -= 1; }
    if (!confirmed) { logRegistration("challenge failed", parsed.host); return c.json({ error: "challenge failed" }, 422); }
    const key = issueKey(body.base_url, body.version);
    logRegistration("issued", parsed.host);
    return c.json({ relay_key: key }, 201);
  });
  router.post("/relay/v1/push", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const key = /^Bearer (rk_[A-Za-z0-9_-]+)$/.exec(auth)?.[1];
    const keyHash = key === undefined ? undefined : relayKeyHash(key);
    const server = keyHash === undefined ? undefined : db.prepare("SELECT base_url, legacy FROM relay_servers WHERE relay_key_hash = ?").get(keyHash) as { base_url: string; legacy: number } | undefined;
    if (keyHash === undefined || server === undefined) return c.json({ error: "unauthorized" }, 401);
    const read = await readJson(c.req.raw, MAX_PUSH_BYTES);
    const body = (read === "too large" || read === undefined ? null : read) as RelayPayload | null;
    if (body === null || typeof body !== "object" || !/^[0-9a-f]{64}$/.test(body.topic_hash) || !["open", "repeat", "reopen", "p4", "p5", "ack", "close", "expire"].includes(body.kind)) return c.json({ error: "invalid request" }, 400);
    // api.md §4.1. A key pushes only topics of the server it was registered
    // for. The topic name is used for this check alone: it is not stored,
    // logged or put on the event.
    if (body.topic !== undefined || server.legacy === 0) {
      if (typeof body.topic !== "string" || !/^[-_A-Za-z0-9]{1,64}$/.test(body.topic)) return c.json({ error: "invalid request" }, 400);
      if (topicHash(server.base_url, body.topic) !== body.topic_hash) return c.json({ error: "topic mismatch" }, 403);
    }
    // The accounts this push is for. The pushing server's message_id has no row
    // here (api.md §4.1), so the relay establishes the owning accounts itself
    // and names one on every dispatch; the dispatcher never guesses. A hash this
    // relay already serves a topic for is not a remote topic: base_url is
    // server-wide, so a stranger can compute a hosted account's topic_hash from
    // the topic name, and a push for it is dropped rather than rung.
    const accounts = db.prepare("SELECT DISTINCT d.account_id, a.tier FROM subscriptions s JOIN devices d ON d.id = s.device_id JOIN accounts a ON a.id = d.account_id WHERE s.topic_hash = ? AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.account_id = d.account_id AND t.topic_hash = s.topic_hash)").all(body.topic_hash) as { account_id: string; tier: Tier }[];
    if (body.kind === "p4") {
      const day = Math.floor(Date.now() / 1000 / 86400) * 86400;
      let eligible = 0;
      for (const account of accounts) {
        const row = db.prepare("SELECT count FROM relay_p4_usage WHERE account_id = ? AND day_start = ?").get(account.account_id, day) as { count: number } | undefined;
        if ((row?.count ?? 0) < capsFor(account.tier).p4_daily) { eligible += 1; db.prepare("INSERT INTO relay_p4_usage(account_id,day_start,count) VALUES(?,?,1) ON CONFLICT(account_id,day_start) DO UPDATE SET count=count+1").run(account.account_id, day); }
      }
      if (accounts.length > 0 && eligible === 0) return c.json({ error: "cap", cap: "p4_daily" }, 429);
    }
    const event: DeliveryEvent = { kind: body.kind, topicHash: body.topic_hash, topic: "", incidentId: body.incident_id, messageId: body.message_id, priority: body.priority, maxRingS: 1800, ringUntil: body.ring_until ?? null, server: "", title: body.title ?? "Crit Alarm", body: body.body ?? "Critical alert", critical: isCritical(body) };
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
