import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { DeliveryEvent } from "../domain-events.js";
import type { Clock } from "../incident/types.js";
import { signJwt } from "./jwt.js";
import type { LiveActivityPush, LiveActivitySender, PrivateKey, PushDevice, PushResult, PushSender } from "./types.js";

export interface ApnsTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// The seam the tests replace. The real one below speaks HTTP/2; nothing else
// can, because APNs answers every HTTP/1.1 request with an HTTP/2 SETTINGS
// frame and undici cannot parse it.
export interface ApnsTransport {
  send(path: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse>;
  close(): void;
}

export interface ApnsSenderOptions {
  clock: Clock;
  teamId: string;
  keyId: string;
  privateKey: PrivateKey;
  bundleId: string;
  environment: "sandbox" | "production";
  transport?: ApnsTransport;
}

type CachedToken = { value: string; issuedAt: number };

export class ApnsSender implements PushSender, LiveActivitySender {
  private cachedToken: CachedToken | null = null;
  private readonly transport: ApnsTransport;

  constructor(private readonly options: ApnsSenderOptions) {
    this.transport = options.transport ?? new Http2ApnsTransport(apnsEndpoint(options.environment));
  }

  async send(device: PushDevice, event: DeliveryEvent): Promise<PushResult> {
    const now = this.options.clock.now();
    return this.push(
      `/3/device/${encodeURIComponent(device.pushToken)}`,
      {
        authorization: `bearer ${this.authorization(now)}`,
        "apns-topic": this.options.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": event.incidentId ?? event.messageId,
        "apns-expiration": String(now + event.maxRingS),
        "content-type": "application/json",
      },
      JSON.stringify(apnsPayload(event)),
    );
  }

  async sendLiveActivity(push: LiveActivityPush): Promise<PushResult> {
    const now = this.options.clock.now();
    return this.push(
      `/3/device/${encodeURIComponent(push.token)}`,
      {
        authorization: `bearer ${this.authorization(now)}`,
        "apns-topic": `${this.options.bundleId}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      JSON.stringify(liveActivityPayload(push, now)),
    );
  }

  // Closes the HTTP/2 session so the process can exit. Safe to call when no
  // session was ever opened.
  close(): void {
    this.transport.close();
  }

  private async push(path: string, headers: Record<string, string>, body: string): Promise<PushResult> {
    const response = await this.transport.send(path, headers, body);
    // Apple explains a refusal in the body, e.g. {"reason":"BadDeviceToken"}.
    // Without this line a rejected push is invisible: the dispatcher only
    // stops counting it as delivered. No path and no headers are logged,
    // because the path carries the push token.
    if (response.status >= 400) console.warn("apns_rejected", { status: response.status, reason: rejectionReason(response.body) });
    return { status: response.status, stale: response.status === 410 };
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

// Apple asks providers to keep one connection open rather than dial per
// notification, and this process is long lived, so the session is held and
// reused. It is dropped on error, close or GOAWAY, so a dead session costs one
// failed send and not every send after it.
export class Http2ApnsTransport implements ApnsTransport {
  private session: ClientHttp2Session | null = null;

  constructor(private readonly authority: string, private readonly timeoutMs: number = 10_000) {}

  async send(path: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse> {
    const session = this.sessionFor();
    return new Promise<ApnsTransportResponse>((resolve, reject) => {
      const stream = session.request({ ":method": "POST", ":path": path, ...headers });
      const chunks: Buffer[] = [];
      let status = 0;
      let responseHeaders: Record<string, string> = {};
      const onSessionError = (error: Error) => { reject(transportError(error)); stream.destroy(); };
      session.once("error", onSessionError);
      const done = () => session.off("error", onSessionError);
      stream.setTimeout(this.timeoutMs, () => stream.destroy(new Error(`no answer from ${this.authority} in ${this.timeoutMs}ms`)));
      stream.on("response", (received) => {
        status = Number(received[constants.HTTP2_HEADER_STATUS] ?? 0);
        responseHeaders = Object.fromEntries(Object.entries(received).map(([name, value]) => [name, String(value)]));
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", (error: Error) => { done(); reject(transportError(error)); });
      stream.on("close", () => {
        done();
        // status stays 0 when the stream died before Apple answered. The error
        // listener has already rejected; resolving here would be a no-op, but
        // a zero status would look like a real reply to the dispatcher.
        if (status !== 0) resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") });
      });
      stream.end(body);
    });
  }

  close(): void {
    const session = this.session;
    this.session = null;
    if (session !== null && !session.destroyed) session.close();
  }

  private sessionFor(): ClientHttp2Session {
    const current = this.session;
    if (current !== null && !current.closed && !current.destroyed) return current;
    const session = connect(this.authority);
    // A session with no error listener throws on the next tick and takes the
    // process with it, so the listener is attached before anything is sent.
    const forget = () => { if (this.session === session) this.session = null; };
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", forget);
    this.session = session;
    return session;
  }
}

export function apnsEndpoint(environment: "sandbox" | "production"): string {
  return environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

function transportError(error: unknown): Error {
  return new Error(`apns transport failed: ${error instanceof Error ? error.message : String(error)}`);
}

function rejectionReason(body: string): string {
  if (body === "") return "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed) return String((parsed as { reason: unknown }).reason);
  } catch {
    // Not JSON. Fall through and report whatever Apple sent.
  }
  return body;
}

function apnsPayload(event: DeliveryEvent): Record<string, unknown> {
  const isCritical = event.priority === 5 && event.critical && event.incidentId !== null;
  const full = event.relayContent === "full";
  const aps: Record<string, unknown> = {
    alert: full ? { title: event.title, body: event.body } : { title: "Crit Alarm", body: `Critical alert on ${event.topic} — open to see details` },
    "interruption-level": "time-sensitive",
    ...(full ? {} : { "mutable-content": 1 }),
    category: "INCIDENT",
  };
  // Apple denied the Critical Alerts entitlement, so this payload never asks
  // for one. APNs rejects a critical sound or a critical interruption level
  // from an app without the entitlement, which fails the whole send. A topic
  // with critical on still gets the alarm sound, played at the ringer volume
  // and silenced by the silent switch like any other notification sound.
  if (isCritical) {
    aps.sound = "alarm.caf";
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
