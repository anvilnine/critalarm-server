import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { DeliveryEvent } from "../domain-events.js";
import type { Clock } from "../incident/types.js";
import { signJwt } from "./jwt.js";
import type { ApnsEnvironment, LiveActivityPush, LiveActivitySender, PrivateKey, PushDevice, PushResult, PushSender } from "./types.js";

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
  // Where to start when the device's own host is not known yet.
  environment: ApnsEnvironment;
  // The seam the tests replace. One transport per Apple host, so a fake can
  // answer differently for sandbox and production.
  transport?: (authority: string) => ApnsTransport;
}

type CachedToken = { value: string; issuedAt: number };

export class ApnsSender implements PushSender, LiveActivitySender {
  private cachedToken: CachedToken | null = null;
  // One HTTP/2 session per Apple host. The configured host is dialled up front,
  // the other one only if a token turns out to live there.
  private readonly transports = new Map<ApnsEnvironment, ApnsTransport>();

  constructor(private readonly options: ApnsSenderOptions) {
    this.transportFor(options.environment);
  }

  async send(device: PushDevice, event: DeliveryEvent): Promise<PushResult> {
    const now = this.options.clock.now();
    return this.push(
      device.apnsEnvironment ?? this.options.environment,
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
      push.apnsEnvironment ?? this.options.environment,
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

  // Closes every HTTP/2 session so the process can exit. Safe to call when no
  // session was ever opened.
  close(): void {
    for (const transport of this.transports.values()) transport.close();
  }

  // Sends to one host, and when that host says the token is not one of its own,
  // sends to the other host once.
  //
  // BadDeviceToken is what Apple answers for a token minted in the other
  // environment. A Debug build on the founder's phone and the TestFlight build
  // on the same phone hold tokens in different environments at the same time,
  // so one host is always wrong for one of them. Without this the push is
  // refused, nothing rings and nobody sees an error.
  //
  // A refusal never delivered anything, so the second attempt cannot double
  // ring. The result names the host that answered, and the dispatcher writes it
  // back, so a device pays for the wrong guess once.
  private async push(environment: ApnsEnvironment, path: string, headers: Record<string, string>, body: string): Promise<PushResult> {
    const first = await this.attempt(environment, path, headers, body);
    if (!wrongEnvironment(first)) return pushResult(environment, first);
    const other: ApnsEnvironment = environment === "sandbox" ? "production" : "sandbox";
    // attempt() has already logged an apns_rejected for each host it tried, so
    // a token that exists in neither leaves two lines naming both. That is a
    // bad token rather than a bad guess, and the two lines say which.
    const second = await this.attempt(other, path, headers, body);
    if (second.status >= 200 && second.status < 300) console.warn("apns_environment_switched", { from: environment, to: other, bundle_id: this.options.bundleId });
    return pushResult(other, second);
  }

  private async attempt(environment: ApnsEnvironment, path: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse> {
    const response = await this.sendWithRetry(environment, path, headers, body);
    // Apple explains a refusal in the body, e.g. {"reason":"BadDeviceToken"}.
    // Without this line a rejected push is invisible: the dispatcher only
    // stops counting it as delivered. No path and no headers are logged,
    // because the path carries the push token.
    if (response.status >= 400) console.warn("apns_rejected", { environment, status: response.status, reason: rejectionReason(response.body) });
    return response;
  }

  private transportFor(environment: ApnsEnvironment): ApnsTransport {
    const existing = this.transports.get(environment);
    if (existing !== undefined) return existing;
    const authority = apnsEndpoint(environment);
    const created = this.options.transport === undefined ? new Http2ApnsTransport(authority) : this.options.transport(authority);
    this.transports.set(environment, created);
    return created;
  }

  // One retry, on a fresh connection, because the transport drops a failed
  // session before this runs. A connection that died while the server sat idle
  // should cost a reconnect, not a missed alarm. Exactly one retry, so a real
  // Apple outage still fails fast instead of hanging twice over.
  //
  // Only a transport failure lands here. A push Apple refuses comes back as a
  // status, not a throw, so this never retries a rejection.
  private async sendWithRetry(environment: ApnsEnvironment, path: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse> {
    const transport = this.transportFor(environment);
    try {
      return await transport.send(path, headers, body);
    } catch (error) {
      console.warn("apns_retry", { environment, reason: error instanceof Error ? error.message : String(error) });
      return transport.send(path, headers, body);
    }
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
// reused.
//
// A session Apple or a NAT dropped quietly is not `closed` and not
// `destroyed`, so it still looks usable and every send after it writes into a
// dead socket. Two things stop that. A PING every keepaliveMs asks whether the
// connection is really there and tears it down when it is not. And any failed
// send drops the session, so the next send dials a fresh one instead of
// repeating the same failure forever.
export class Http2ApnsTransport implements ApnsTransport {
  private session: ClientHttp2Session | null = null;
  private keepalive: NodeJS.Timeout | null = null;

  constructor(
    private readonly authority: string,
    private readonly timeoutMs: number = 5_000,
    private readonly keepaliveMs: number = 30_000,
  ) {}

  async send(path: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse> {
    const session = this.sessionFor();
    return new Promise<ApnsTransportResponse>((resolve, reject) => {
      const stream = session.request({ ":method": "POST", ":path": path, ...headers });
      const chunks: Buffer[] = [];
      let status = 0;
      let responseHeaders: Record<string, string> = {};
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        session.off("error", onSessionError);
        this.drop(session);
        stream.destroy();
        reject(transportError(error));
      };
      const onSessionError = (error: Error) => fail(error);
      session.once("error", onSessionError);

      stream.setTimeout(this.timeoutMs, () => fail(new Error(`no answer from ${this.authority} in ${this.timeoutMs}ms`)));
      stream.on("response", (received) => {
        status = Number(received[constants.HTTP2_HEADER_STATUS] ?? 0);
        responseHeaders = Object.fromEntries(Object.entries(received).map(([name, value]) => [name, String(value)]));
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", (error: Error) => fail(error));
      stream.on("close", () => {
        if (settled) return;
        settled = true;
        session.off("error", onSessionError);
        // status stays 0 when the stream closed before Apple answered. A zero
        // status would look like a real reply to the dispatcher, so this has
        // to reject. Without it the send would never settle at all.
        if (status === 0) {
          this.drop(session);
          reject(transportError(new Error(`${this.authority} closed the stream with no answer`)));
          return;
        }
        resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") });
      });
      stream.end(body);
    });
  }

  close(): void {
    const session = this.session;
    this.stopKeepalive();
    this.session = null;
    if (session !== null && !session.destroyed) session.close();
  }

  private sessionFor(): ClientHttp2Session {
    const current = this.session;
    if (current !== null && !current.closed && !current.destroyed) return current;
    const session = connect(this.authority);
    // A session with no error listener throws on the next tick and takes the
    // process with it, so the listener is attached before anything is sent.
    session.on("error", () => this.drop(session));
    session.on("close", () => this.drop(session));
    session.on("goaway", () => this.drop(session));
    this.session = session;
    this.startKeepalive(session);
    return session;
  }

  // Forgets a session so the next send dials a new one. It only forgets the
  // session passed in, so a send that failed on an old session cannot throw
  // away the fresh session a later send already opened.
  private drop(session: ClientHttp2Session): void {
    if (this.session !== session) return;
    this.session = null;
    this.stopKeepalive();
    if (!session.destroyed) session.destroy();
  }

  // Apple never says a connection died; the socket just stops answering. A
  // PING asks. If the last PING is still unanswered when the next one is due,
  // the connection is gone, and the session goes before a real push has to
  // find out the slow way.
  private startKeepalive(session: ClientHttp2Session): void {
    let waiting = false;
    const timer = setInterval(() => {
      if (this.session !== session || session.destroyed) return;
      if (waiting) {
        this.drop(session);
        return;
      }
      waiting = true;
      try {
        session.ping((error: Error | null) => {
          waiting = false;
          if (error !== null) this.drop(session);
        });
      } catch {
        waiting = false;
        this.drop(session);
      }
    }, this.keepaliveMs);
    // The timer must not be the reason the process stays alive.
    timer.unref();
    this.keepalive = timer;
  }

  private stopKeepalive(): void {
    if (this.keepalive === null) return;
    clearInterval(this.keepalive);
    this.keepalive = null;
  }
}

export function apnsEndpoint(environment: ApnsEnvironment): string {
  return environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

// The one refusal that means "right token, wrong host". Everything else,
// including DeviceTokenNotForTopic and a 410 Unregistered, is a real refusal
// and trying the other host would only waste a request.
function wrongEnvironment(response: ApnsTransportResponse): boolean {
  return response.status === 400 && rejectionReason(response.body) === "BadDeviceToken";
}

function pushResult(environment: ApnsEnvironment, response: ApnsTransportResponse): PushResult {
  return { status: response.status, stale: response.status === 410, apnsEnvironment: environment };
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
    // Wakes the app so it can schedule the AlarmKit alarm. Without this iOS
    // shows the notification and never calls the app, so the phone plays a
    // sound and no alarm ever rings. The extension cannot do this job: the
    // spike in critalarm-app (docs/specs/remote-alarm-ios-spike.md) found the
    // app's background-push handler is the only path that schedules.
    aps["content-available"] = 1;
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
