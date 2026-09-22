import type Database from "better-sqlite3";
import { isStateKind, type DeliveryEvent, type DispatchResult } from "../domain-events.js";
import type { Clock } from "../incident/types.js";
import type { ApnsEnvironment, LiveActivityPush, LiveActivitySender, PushDevice, PushResult, PushSender } from "./types.js";

type DeviceRow = {
  id: string;
  account_id: string;
  platform: "ios" | "android";
  push_token: string;
  apns_environment: ApnsEnvironment | null;
};

type IncidentStateRow = { state: "open" | "acked" | "closed" | "expired"; opened_at: number };

// A Live Activity token plus the Apple host its device is known to be on, so
// the sender does not have to guess for it the way it does for a new device.
type LiveActivityTarget = { token: string; apns_environment: ApnsEnvironment | null };

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

export class PushDispatcher {
  constructor(
    private readonly db: Database.Database,
    private readonly senders: PushDispatchers,
    private readonly clock: Clock = { now: () => Math.floor(Date.now() / 1000) },
  ) {}

  async dispatch(events: readonly DeliveryEvent[]): Promise<DispatchResult> {
    let delivered = 0;
    for (const event of events) {
      const accountId = this.owningAccount(event);
      if (accountId === undefined) continue;
      delivered += await this.sendToDevices(event, accountId);
      await this.updateLiveActivities(event, accountId);
    }
    return { delivered };
  }

  // Returns how many pushes the provider accepted. A refused push is not
  // counted, so a run of 500s or 410s never shows up as delivery. A state kind
  // goes to Android only (api.md §5.2): it stops a phone that is still ringing,
  // and iOS gets the same news as a Live Activity update instead.
  private async sendToDevices(event: DeliveryEvent, accountId: string): Promise<number> {
    let delivered = 0;
    const devices = this.subscribedDevices(event.topicHash, accountId)
      .filter((device) => !isStateKind(event.kind) || device.platform === "android");
    for (const device of devices) {
      const result = await this.senderFor(device).send(device, event);
      this.rememberApnsEnvironment(device, result);
      if (result.status >= 200 && result.status < 300 && !result.stale) delivered += 1;
      if (device.platform === "ios" && result.stale) {
        this.db
          .prepare("UPDATE devices SET push_token = '' WHERE id = ? AND push_token = ?")
          .run(device.id, device.pushToken);
        this.db
          .prepare("DELETE FROM device_tokens WHERE device_id = ? AND kind = 'apns' AND token = ?")
          .run(device.id, device.pushToken);
      }
    }
    return delivered;
  }

  // Which Apple host rang the phone, so the next push starts there instead of
  // paying for the wrong guess again. Only a push Apple accepted is worth
  // remembering: a token both hosts refused is a bad token, and writing down
  // the host that happened to be tried last would be a lie.
  private rememberApnsEnvironment(device: PushDevice, result: PushResult): void {
    if (device.platform !== "ios" || result.apnsEnvironment === undefined) return;
    if (result.status < 200 || result.status >= 300) return;
    if (result.apnsEnvironment === device.apnsEnvironment) return;
    this.db.prepare("UPDATE devices SET apns_environment = ? WHERE id = ?").run(result.apnsEnvironment, device.id);
  }

  private async updateLiveActivities(event: DeliveryEvent, accountId: string): Promise<void> {
    const action = liveActivityEvent[event.kind];
    const sender = this.senders.liveActivity;
    if (action === undefined || sender === undefined || event.incidentId === null) {
      return;
    }
    const incident = this.incidentState(event.incidentId);
    const state = incident?.state ?? fallbackState(event.kind);
    const openedAt = incident?.opened_at ?? this.clock.now();
    for (const target of this.liveActivityTokens(action, event, accountId)) {
      const push: LiveActivityPush = {
        token: target.token,
        event: action,
        incidentId: event.incidentId,
        topic: event.topic,
        server: event.server,
        state,
        title: event.relayContent === "full" ? event.title : `Critical alert on ${event.topic}`,
        openedAt,
        ...(target.apns_environment === null ? {} : { apnsEnvironment: target.apns_environment }),
      };
      const result = await sender.sendLiveActivity(push);
      if (result.stale) {
        this.db.prepare("DELETE FROM device_tokens WHERE token = ? AND kind IN ('la_start', 'la_update')").run(target.token);
      }
    }
  }

  // A start goes to the push-to-start token of every device subscribed to the
  // topic. An update or an end goes to the update token of the activity that is
  // already running for this incident, wherever it is.
  private liveActivityTokens(action: "start" | "update" | "end", event: DeliveryEvent, accountId: string): LiveActivityTarget[] {
    if (action === "start") {
      const deviceIds = this.subscribedDevices(event.topicHash, accountId).map((device) => device.id);
      if (deviceIds.length === 0) return [];
      return this.db
        .prepare(
          `SELECT t.token, d.apns_environment FROM device_tokens t JOIN devices d ON d.id = t.device_id
           WHERE t.kind = 'la_start' AND t.device_id IN (${deviceIds.map(() => "?").join(", ")})`,
        )
        .all(...deviceIds) as LiveActivityTarget[];
    }
    return this.db
      .prepare(
        "SELECT t.token, d.apns_environment FROM device_tokens t JOIN devices d ON d.id = t.device_id WHERE t.kind = 'la_update' AND t.incident_id = ? AND d.account_id = ?",
      )
      .all(event.incidentId, accountId) as LiveActivityTarget[];
  }

  private incidentState(incidentId: string): IncidentStateRow | undefined {
    return this.db.prepare("SELECT state, opened_at FROM incidents WHERE id = ?").get(incidentId) as
      | IncidentStateRow
      | undefined;
  }

  // The owning account, or nothing. A relayed push carries the pushing server's
  // message_id (api.md §4.1), which has no row here, so the relay puts the
  // account on the event. With neither, send nothing: the same topic name on two
  // accounts is the same topic_hash, so an unfiltered query rings both.
  private owningAccount(event: DeliveryEvent): string | undefined {
    if (event.accountId !== undefined) return event.accountId;
    const message = this.db.prepare("SELECT t.account_id FROM messages m JOIN topics t ON t.id = m.topic_id WHERE m.id = ?").get(event.messageId) as { account_id: string } | undefined;
    if (message !== undefined) return message.account_id;
    console.log(JSON.stringify({ event: "push_dropped", reason: "unknown account", kind: event.kind, topic_hash: event.topicHash, message_id: event.messageId }));
    return undefined;
  }

  private subscribedDevices(topicHash: string, accountId: string): PushDevice[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.account_id, d.platform, d.apns_environment,
           COALESCE(alarm.token, d.push_token) AS push_token
         FROM devices d JOIN subscriptions s ON s.device_id = d.id
         LEFT JOIN device_tokens alarm ON alarm.device_id = d.id AND alarm.activity_id = ''
           AND alarm.kind = CASE d.platform WHEN 'ios' THEN 'apns' ELSE 'fcm' END
         WHERE s.topic_hash = ? AND COALESCE(alarm.token, d.push_token) <> '' AND d.account_id = ?`,
      )
      .all(topicHash, accountId) as DeviceRow[];
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      platform: row.platform,
      pushToken: row.push_token,
      ...(row.apns_environment === null ? {} : { apnsEnvironment: row.apns_environment }),
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
