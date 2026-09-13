import type Database from "better-sqlite3";
import type { DeliveryEvent } from "../domain-events.js";
import type { Clock } from "../incident/types.js";
import type { LiveActivityPush, LiveActivitySender, PushDevice, PushSender } from "./types.js";

type DeviceRow = {
  id: string;
  account_id: string;
  platform: "ios" | "android";
  push_token: string;
};

type IncidentStateRow = { state: "open" | "acked" | "closed" | "expired"; opened_at: number };

export interface PushDispatchers {
  apns: PushSender;
  fcm: PushSender;
  liveActivity?: LiveActivitySender;
}

// api.md §5.3. open starts an activity, the four state changes update or end
// one, and the rest only ring the alarm. ack, close and expire never ring.
const liveActivityEvent: Partial<Record<DeliveryEvent["kind"], "start" | "update" | "end">> = {
  open: "start",
  reopen: "update",
  ack: "update",
  close: "end",
  expire: "end",
};
const silentKinds: ReadonlySet<DeliveryEvent["kind"]> = new Set(["ack", "close", "expire"]);

export class PushDispatcher {
  constructor(
    private readonly db: Database.Database,
    private readonly senders: PushDispatchers,
    private readonly clock: Clock = { now: () => Math.floor(Date.now() / 1000) },
  ) {}

  async dispatch(events: readonly DeliveryEvent[]): Promise<void> {
    for (const event of events) {
      if (!silentKinds.has(event.kind)) {
        await this.ringAlarm(event);
      }
      await this.updateLiveActivities(event);
    }
  }

  private async ringAlarm(event: DeliveryEvent): Promise<void> {
    for (const device of this.subscribedDevices(event.topicHash, event.messageId)) {
      const result = await this.senderFor(device).send(device, event);
      if (device.platform === "ios" && result.stale) {
        this.db
          .prepare("UPDATE devices SET push_token = '' WHERE id = ? AND push_token = ?")
          .run(device.id, device.pushToken);
        this.db
          .prepare("DELETE FROM device_tokens WHERE device_id = ? AND kind = 'apns' AND token = ?")
          .run(device.id, device.pushToken);
      }
    }
  }

  private async updateLiveActivities(event: DeliveryEvent): Promise<void> {
    const action = liveActivityEvent[event.kind];
    const sender = this.senders.liveActivity;
    if (action === undefined || sender === undefined || event.incidentId === null) {
      return;
    }
    const incident = this.incidentState(event.incidentId);
    const state = incident?.state ?? fallbackState(event.kind);
    const openedAt = incident?.opened_at ?? this.clock.now();
    for (const token of this.liveActivityTokens(action, event)) {
      const push: LiveActivityPush = {
        token,
        event: action,
        incidentId: event.incidentId,
        topic: event.topic,
        server: event.server,
        state,
        title: event.relayContent === "full" ? event.title : `Critical alert on ${event.topic}`,
        openedAt,
      };
      const result = await sender.sendLiveActivity(push);
      if (result.stale) {
        this.db.prepare("DELETE FROM device_tokens WHERE token = ? AND kind IN ('la_start', 'la_update')").run(token);
      }
    }
  }

  // A start goes to the push-to-start token of every device subscribed to the
  // topic. An update or an end goes to the update token of the activity that is
  // already running for this incident, wherever it is.
  private liveActivityTokens(action: "start" | "update" | "end", event: DeliveryEvent): string[] {
    if (action === "start") {
      const deviceIds = this.subscribedDevices(event.topicHash, event.messageId).map((device) => device.id);
      if (deviceIds.length === 0) return [];
      const rows = this.db
        .prepare(
          `SELECT token FROM device_tokens WHERE kind = 'la_start' AND device_id IN (${deviceIds.map(() => "?").join(", ")})`,
        )
        .all(...deviceIds) as { token: string }[];
      return rows.map((row) => row.token);
    }
    const rows = this.db
      .prepare("SELECT token FROM device_tokens WHERE kind = 'la_update' AND incident_id = ?")
      .all(event.incidentId) as { token: string }[];
    return rows.map((row) => row.token);
  }

  private incidentState(incidentId: string): IncidentStateRow | undefined {
    return this.db.prepare("SELECT state, opened_at FROM incidents WHERE id = ?").get(incidentId) as
      | IncidentStateRow
      | undefined;
  }

  private subscribedDevices(topicHash: string, messageId: string): PushDevice[] {
    const message = this.db.prepare("SELECT t.account_id FROM messages m JOIN topics t ON t.id = m.topic_id WHERE m.id = ?").get(messageId) as { account_id: string } | undefined;
    const accountClause = message === undefined ? "" : " AND d.account_id = ?";
    const parameters = message === undefined ? [topicHash] : [topicHash, message.account_id];
    const rows = this.db
      .prepare(
        `SELECT d.id, d.account_id, d.platform,
           COALESCE(alarm.token, d.push_token) AS push_token
         FROM devices d JOIN subscriptions s ON s.device_id = d.id
         LEFT JOIN device_tokens alarm ON alarm.device_id = d.id AND alarm.activity_id = ''
           AND alarm.kind = CASE d.platform WHEN 'ios' THEN 'apns' ELSE 'fcm' END
         WHERE s.topic_hash = ? AND COALESCE(alarm.token, d.push_token) <> ''${accountClause}`,
      )
      .all(...parameters) as DeviceRow[];
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      platform: row.platform,
      pushToken: row.push_token,
    }));
  }

  private senderFor(device: PushDevice): PushSender {
    return device.platform === "ios" ? this.senders.apns : this.senders.fcm;
  }
}

function fallbackState(kind: DeliveryEvent["kind"]): "open" | "acked" | "closed" | "expired" {
  if (kind === "ack") return "acked";
  if (kind === "close") return "closed";
  if (kind === "expire") return "expired";
  return "open";
}
