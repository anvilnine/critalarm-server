import type { DeliveryEvent } from "../domain-events.js";
import { signJwt } from "./jwt.js";
import type { LiveActivityPush, LiveActivitySender, PrivateKey, PushDevice, PushResult, PushSender, SenderDependencies } from "./types.js";

export interface ApnsSenderOptions extends SenderDependencies {
  teamId: string;
  keyId: string;
  privateKey: PrivateKey;
  bundleId: string;
  environment: "sandbox" | "production";
}

type CachedToken = { value: string; issuedAt: number };

export class ApnsSender implements PushSender, LiveActivitySender {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly options: ApnsSenderOptions) {}

  async send(device: PushDevice, event: DeliveryEvent): Promise<PushResult> {
    const now = this.options.clock.now();
    const response = await this.options.fetch(
      new Request(`${this.endpoint()}/3/device/${encodeURIComponent(device.pushToken)}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${this.authorization(now)}`,
          "apns-topic": this.options.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-collapse-id": event.incidentId ?? event.messageId,
          "apns-expiration": String(now + event.maxRingS),
          "content-type": "application/json",
        },
        body: JSON.stringify(apnsPayload(event)),
      }),
    );
    return { status: response.status, stale: response.status === 410 };
  }

  async sendLiveActivity(push: LiveActivityPush): Promise<PushResult> {
    const now = this.options.clock.now();
    const response = await this.options.fetch(
      new Request(`${this.endpoint()}/3/device/${encodeURIComponent(push.token)}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${this.authorization(now)}`,
          "apns-topic": `${this.options.bundleId}.push-type.liveactivity`,
          "apns-push-type": "liveactivity",
          "apns-priority": "10",
          "content-type": "application/json",
        },
        body: JSON.stringify(liveActivityPayload(push, now)),
      }),
    );
    return { status: response.status, stale: response.status === 410 };
  }

  private endpoint(): string {
    return this.options.environment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  }

  private authorization(now: number): string {
    if (this.cachedToken !== null && now - this.cachedToken.issuedAt < 50 * 60) {
      return this.cachedToken.value;
    }
    const value = signJwt(
      { alg: "ES256", kid: this.options.keyId },
      { iss: this.options.teamId, iat: now },
      this.options.privateKey,
      "ES256",
    );
    this.cachedToken = { value, issuedAt: now };
    return value;
  }
}

function apnsPayload(event: DeliveryEvent): Record<string, unknown> {
  const isCritical = event.priority === 5 && event.critical && event.incidentId !== null;
  const full = event.relayContent === "full";
  const aps: Record<string, unknown> = {
    alert: full ? { title: event.title, body: event.body } : { title: "Crit Alarm", body: `Critical alert on ${event.topic} — open to see details` },
    "interruption-level": isCritical ? "critical" : "time-sensitive",
    ...(full ? {} : { "mutable-content": 1 }),
    category: "INCIDENT",
  };
  if (isCritical) {
    aps.sound = { critical: 1, name: "alarm.caf", volume: 1.0 };
  }
  return {
    aps,
    ...(event.incidentId === null ? {} : { incident_id: event.incidentId }),
    server: event.server,
    kind: event.kind,
  };
}

function liveActivityPayload(push: LiveActivityPush, now: number): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: now,
    event: push.event,
  };
  if (push.event === "start") {
    aps["attributes-type"] = "CritAlarmIncidentAttributes";
    aps.attributes = { incident_id: push.incidentId, topic: push.topic, server: push.server };
  }
  aps["content-state"] = { state: push.state, title: push.title, opened_at: push.openedAt };
  if (push.event === "end") {
    aps["dismissal-date"] = now;
  }
  return { aps };
}
