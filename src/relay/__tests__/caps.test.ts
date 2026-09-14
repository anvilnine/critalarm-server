import { afterEach, expect, it, vi } from "vitest";
import { createRelayRouter } from "../router.js";
import { relayKeyHash } from "../client.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";

afterEach(() => vi.useRealTimers());
it.each([["free", 50], ["relay", 1000], ["hosted", 1000]] as const)("enforces the %s p4 daily boundary at %i", async (tier, limit) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  const db = openDatabase(":memory:"); migrate(db);
  try {
    db.prepare("INSERT INTO accounts(id,tier,created_at) VALUES ('a',?,1)").run(tier);
    db.prepare("INSERT INTO devices(id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a','hash','ios','push',1)").run();
    const hash = "a".repeat(64);
    db.prepare("INSERT INTO subscriptions(account_id,device_id,topic_hash) VALUES ('a','d',?)").run(hash);
    db.prepare("INSERT INTO relay_servers(id,base_url,version,relay_key_hash,created_at) VALUES ('r','https://example.com','1',?,1)").run(relayKeyHash("rk_test"));
    const day = Math.floor(Date.now() / 86400000) * 86400;
    db.prepare("INSERT INTO relay_p4_usage(account_id,day_start,count) VALUES ('a',?,?)").run(day, limit - 1);
    const dispatch = vi.fn(async () => {});
    const app = createRelayRouter(db, dispatch, new Counters(db, { now: () => Date.now() / 1000 }));
    const send = () => app.request("/relay/v1/push", { method: "POST", headers: { Authorization: "Bearer rk_test" }, body: JSON.stringify({ topic_hash: hash, incident_id: null, message_id: "m_1", priority: 4, kind: "p4" }) });
    expect((await send()).status).toBe(202);
    const rejected = await send();
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({ error: "cap", cap: "p4_daily" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count FROM relay_p4_usage").get()).toEqual({ count: limit });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    expect((await send()).status).toBe(202);
  } finally { db.close(); }
});
