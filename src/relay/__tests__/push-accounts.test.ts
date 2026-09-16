import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayRouter } from "../router.js";
import { relayKeyHash } from "../client.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { DeliveryEvent } from "../../incident/types.js";
import { PushDispatcher } from "../../push/dispatcher.js";
import type { PushSender } from "../../push/types.js";

const remoteHash = "a".repeat(64);
const localHash = "b".repeat(64);

// Two accounts, both subscribed to the same topic_hash. One holds a topic this
// relay serves itself; the other only subscribed to a remote one.
function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  for (const id of ["acc_1", "acc_2"]) db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES (?,'hosted',1)").run(id);
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_1','acc_1','h1','ios','t1',1)").run();
  db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_2','acc_2','h2','ios','t2',1)").run();
  db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at) VALUES ('rly_1','https://alerts.example.com','1',?,1)").run(relayKeyHash("rk_test"));
  const events: DeliveryEvent[] = [];
  const app = createRelayRouter(db, async (event) => { events.push(event); }, new Counters(db, { now: () => 1 }));
  return { db, app, events };
}

function push(app: ReturnType<typeof createRelayRouter>, topicHash: string) {
  return app.request("/relay/v1/push", {
    method: "POST",
    headers: { Authorization: "Bearer rk_test", "content-type": "application/json" },
    body: JSON.stringify({ topic_hash: topicHash, incident_id: "inc_remote", message_id: "m_remote", priority: 5, kind: "open" }),
  });
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

describe("relayed push accounts", () => {
  it("names the owning account on every dispatch", async () => {
    const { db, app, events } = setup();
    try {
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_1',?)").run(remoteHash);

      expect((await push(app, remoteHash)).status).toBe(202);
      expect(events.map((event) => event.accountId)).toEqual(["acc_1"]);
    } finally { db.close(); }
  });

  it("dispatches once per subscribed account, each carrying its own", async () => {
    const { db, app, events } = setup();
    try {
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_1',?)").run(remoteHash);
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_2',?)").run(remoteHash);

      await push(app, remoteHash);

      expect(events.map((event) => event.accountId)).toEqual(["acc_1", "acc_2"]);
    } finally { db.close(); }
  });

  // base_url is server-wide, so anyone can compute the topic_hash of a hosted
  // account's topic from its name. A relayed push for a hash this relay already
  // serves is a stranger ringing that account's own alarm.
  it("reaches each account's own device and no other, through the real dispatcher", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      for (const id of ["acc_1", "acc_2"]) db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES (?,'hosted',1)").run(id);
      db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_1','acc_1','h1','ios','token-1',1)").run();
      db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('dev_2','acc_2','h2','ios','token-2',1)").run();
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_1',?)").run(remoteHash);
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_2',?)").run(remoteHash);
      db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at) VALUES ('rly_1','https://alerts.example.com','1',?,1)").run(relayKeyHash("rk_test"));
      const sent: { device: string; account: string | undefined }[] = [];
      const sender: PushSender = { send: async (device, event) => { sent.push({ device: device.id, account: event.accountId }); return { status: 200, stale: false }; } };
      const dispatcher = new PushDispatcher(db, { apns: sender, fcm: sender });
      const app = createRelayRouter(db, async (event) => dispatcher.dispatch([event]), new Counters(db, { now: () => 1 }));

      expect((await push(app, remoteHash)).status).toBe(202);

      expect(sent).toEqual([{ device: "dev_1", account: "acc_1" }, { device: "dev_2", account: "acc_2" }]);
    } finally { db.close(); }
  });

  it("sends nothing and logs for a hash this relay serves a topic for", async () => {
    const { db, app, events } = setup();
    try {
      db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','acc_1','prod','https://relay.critalarm.app',?,1,30,60,30,'none',1)").run(localHash);
      db.prepare("INSERT INTO subscriptions (device_id, topic_hash) VALUES ('dev_1',?)").run(localHash);

      expect((await push(app, localHash)).status).toBe(202);
      expect(events).toEqual([]);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ route: "/relay/v1/push", topic_hash: localHash, kind: "open", accounts: 0 }));
    } finally { db.close(); }
  });

  it("sends nothing and logs when no account subscribes to the hash", async () => {
    const { db, app, events } = setup();
    try {
      expect((await push(app, remoteHash)).status).toBe(202);
      expect(events).toEqual([]);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ route: "/relay/v1/push", topic_hash: remoteHash, kind: "open", accounts: 0 }));
    } finally { db.close(); }
  });
});
