import type Database from "better-sqlite3";
import type { DeliveryEvent } from "../domain-events.js";
import type { PushDevice, PushSender } from "./types.js";

type DeviceRow = {
  id: string;
  account_id: string;
  platform: "ios" | "android";
  push_token: string;
};

export interface PushDispatchers {
  apns: PushSender;
  fcm: PushSender;
}

export class PushDispatcher {
  constructor(
    private readonly db: Database.Database,
    private readonly senders: PushDispatchers,
  ) {}

  async dispatch(events: readonly DeliveryEvent[]): Promise<void> {
    for (const event of events) {
      const devices = this.subscribedDevices(event.topicHash, event.messageId);
      for (const device of devices) {
        const result = await this.senderFor(device).send(device, event);
        if (device.platform === "ios" && result.stale) {
          this.db
            .prepare("UPDATE devices SET push_token = '' WHERE id = ? AND push_token = ?")
            .run(device.id, device.pushToken);
        }
      }
    }
  }

  private subscribedDevices(topicHash: string, messageId: string): PushDevice[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.account_id, d.platform, d.push_token
         FROM devices d JOIN subscriptions s ON s.device_id = d.id
         WHERE s.topic_hash = ? AND d.push_token <> ''
           AND d.account_id = (
             SELECT t.account_id FROM messages m JOIN topics t ON t.id = m.topic_id
             WHERE m.id = ?
           )`,
      )
      .all(topicHash, messageId) as DeviceRow[];
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
