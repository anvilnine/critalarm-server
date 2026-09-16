import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Config } from "../../config.js";
import type { DeliveryEvent } from "../../domain-events.js";
import { createApp } from "../../index.js";
import { PushDispatcher } from "../../push/dispatcher.js";
import type { PushDevice, PushResult, PushSender } from "../../push/types.js";
import type { Stats } from "../counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";

const RELAY_KEY = "rk_abusive000000000000000000000000";
const KEY_HASH = createHash("sha256").update(RELAY_KEY).digest("hex");
const TOPIC_HASH = "b".repeat(64);
const STATS_KEY = "sk_stats_test";
const noon = Math.floor(Date.UTC(2026, 8, 13, 12, 0, 0) / 1000);

class FixedSender implements PushSender {
  constructor(private readonly result: PushResult) {}
  async send(_device: PushDevice, _event: DeliveryEvent): Promise<PushResult> {
    return this.result;
  }
}

function config(mode: "relay" | "selfhosted", statsKey: string | null): Config {
  return {
    mode,
    baseUrl: "https://relay.critalarm.app",
    relayUrl: "https://relay.critalarm.app",
    relayContent: "none",
    listen: ":8080",
    port: 8080,
    dataDir: "/data",
    behindProxy: false,
    ...(statsKey === null ? {} : { statsKey }),
  };
}

// One iOS device the provider accepts, one Android device it refuses with a
// 500. A single relay push therefore delivers exactly one push.
function setup(mode: "relay" | "selfhosted" = "relay", statsKey: string | null = STATS_KEY) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1','hosted',1)").run();
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_ios','acc_1','h_ios','ios','ios-token',?)").run(noon);
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_android','acc_1','h_android','android','android-token',?)").run(noon);
  db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_ios',?)").run(TOPIC_HASH);
  db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_android',?)").run(TOPIC_HASH);
  db.prepare("INSERT INTO relay_servers (id, base_url, version, relay_key_hash, created_at) VALUES ('rly_1','https://alerts.example.com','0.1.0',?,1)").run(KEY_HASH);
  const clock = { now: () => noon };
  const dispatcher = new PushDispatcher(
    db,
    { apns: new FixedSender({ status: 200, stale: false }), fcm: new FixedSender({ status: 500, stale: false }) },
    clock,
  );
  const app = createApp({
    config: config(mode, statsKey),
    db,
    clock,
    ids: { message: () => "m_1", incident: () => "inc_1", timer: () => "tm_1" },
    dispatch: (events) => dispatcher.dispatch(events),
  });
  return { app, db };
}

function push(app: ReturnType<typeof setup>["app"], kind: string) {
  return app.request("/relay/v1/push", {
    method: "POST",
    headers: { authorization: `Bearer ${RELAY_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ topic_hash: TOPIC_HASH, incident_id: "inc_1", message_id: "m_1", priority: 5, kind }),
  });
}

function stats(app: ReturnType<typeof setup>["app"], path = "/relay/v1/internal/stats", key: string | null = STATS_KEY) {
  return app.request(path, key === null ? {} : { headers: { authorization: `Bearer ${key}` } });
}

describe("GET /relay/v1/internal/stats", () => {
  it("counts a relay push and leaves the refused push out of pushes_delivered", async () => {
    const { app } = setup();
    expect((await push(app, "open")).status).toBe(202);

    const body = await (await stats(app)).json() as Stats;
    expect(body.totals).toEqual({ pushes_delivered: 1, alarms_rung: 1, acks: 0, incidents_opened: 1 });
    expect(body.days).toEqual([{ day: "2026-09-13", pushes_delivered: 1, alarms_rung: 1, acks: 0, incidents_opened: 1 }]);
    expect(body.servers_total).toBe(1);
    expect(body.devices_active_7d).toBe(2);
  });

  it("counts a reopen as an alarm on an incident that is already open", async () => {
    const { app } = setup();
    await push(app, "open");
    await push(app, "reopen");
    await push(app, "repeat");

    const body = await (await stats(app)).json() as Stats;
    expect(body.totals).toEqual({ pushes_delivered: 3, alarms_rung: 2, acks: 0, incidents_opened: 1 });
  });

  it("excludes a zeroed key from the totals and still lists it under by=key", async () => {
    const { app, db } = setup();
    await push(app, "open");
    db.prepare("INSERT INTO counters_zeroed (relay_key, zeroed_at) VALUES (?, ?)").run(KEY_HASH, noon);

    const body = await (await stats(app, "/relay/v1/internal/stats?by=key")).json() as Stats;
    expect(body.totals).toEqual({ pushes_delivered: 0, alarms_rung: 0, acks: 0, incidents_opened: 0 });
    expect(body.servers_total).toBe(0);
    expect(body.keys).toEqual([
      { relay_key: KEY_HASH, zeroed: true, totals: { pushes_delivered: 1, alarms_rung: 1, acks: 0, incidents_opened: 1 }, days: [{ day: "2026-09-13", pushes_delivered: 1, alarms_rung: 1, acks: 0, incidents_opened: 1 }] },
    ]);
  });

  it("answers 401 without the stats key and with the wrong one", async () => {
    const { app } = setup();
    expect((await stats(app, "/relay/v1/internal/stats", null)).status).toBe(401);
    expect((await stats(app, "/relay/v1/internal/stats", "sk_wrong")).status).toBe(401);
  });

  it("is not cached", async () => {
    const { app } = setup();
    expect((await stats(app)).headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 in self-hosted mode even with the right key", async () => {
    const { app } = setup("selfhosted");
    const res = await stats(app);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("answers 404 when no STATS_KEY is configured", async () => {
    const { app } = setup("relay", null);
    expect((await stats(app)).status).toBe(404);
  });

  it("rejects an unknown by value", async () => {
    const { app } = setup();
    expect((await stats(app, "/relay/v1/internal/stats?by=server")).status).toBe(400);
  });
});
