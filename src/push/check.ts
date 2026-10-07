import type { Clock } from "../incident/types.js";
import { apnsEndpoint, Http2ApnsTransport, type ApnsTransport } from "./apns.js";
import { signJwt } from "./jwt.js";
import type { ApnsEnvironment, PrivateKey, PushFetch } from "./types.js";

// api.md §5.4. The weekly check push, for APNs and for FCM.
//
// This file builds its own headers and its own payloads and does not call the
// alarm senders. No alarm type comes in here, so nothing in it can pick up an
// alert, a sound or a collapse id from one. It also keeps its own connections
// and its own provider tokens: a check that times out tears down a connection
// no alarm is using.

export interface CheckTarget {
  platform: "ios" | "android";
  pushToken: string;
  // The Apple host the device is known to be on, when it is known.
  apnsEnvironment?: ApnsEnvironment;
}

export interface CheckPush {
  checkId: string;
  attempt: number;
}

// `refused` means the provider refused the device's push token. `failed` is
// every other answer that is not an acceptance, and a send that never got one.
export interface CheckAnswer {
  outcome: "accepted" | "refused" | "failed";
  status: number;
}

export interface CheckSender {
  sendCheck(target: CheckTarget, push: CheckPush): Promise<CheckAnswer>;
}

// The four headers of §5.4. apns-expiration 0 asks Apple to try once and not
// store the push. There is no apns-collapse-id.
export function apnsCheckHeaders(bundleId: string): Record<string, string> {
  return {
    "apns-topic": bundleId,
    "apns-push-type": "background",
    "apns-priority": "5",
    "apns-expiration": "0",
  };
}

// `aps` holds content-available and nothing else.
export function apnsCheckPayload(push: CheckPush): Record<string, unknown> {
  return {
    aps: { "content-available": 1 },
    kind: "check",
    check_id: push.checkId,
    attempt: push.attempt,
  };
}

// Data only, normal priority, six hours to live, no collapse key. Every FCM
// data value is a string, so the attempt is one too.
export function fcmCheckMessage(pushToken: string, push: CheckPush): Record<string, unknown> {
  return {
    message: {
      token: pushToken,
      android: { priority: "normal", ttl: "21600s" },
      data: { kind: "check", check_id: push.checkId, attempt: String(push.attempt) },
    },
  };
}

export interface ApnsCheckSenderOptions {
  clock: Clock;
  teamId: string;
  keyId: string;
  privateKey: PrivateKey;
  bundleId: string;
  // Where to start when the device's own host is not known.
  environment: ApnsEnvironment;
  // The seam the tests replace.
  transport?: (authority: string) => ApnsTransport;
}

export class ApnsCheckSender implements CheckSender {
  private cachedToken: { value: string; issuedAt: number } | null = null;
  // Opened on the first check and not before, so a relay with no enrolled
  // device never dials Apple for this.
  private readonly transports = new Map<ApnsEnvironment, ApnsTransport>();

  constructor(private readonly options: ApnsCheckSenderOptions) {}

  async sendCheck(target: CheckTarget, push: CheckPush): Promise<CheckAnswer> {
    const path = `/3/device/${encodeURIComponent(target.pushToken)}`;
    const headers = {
      authorization: `bearer ${this.authorization(this.options.clock.now())}`,
      ...apnsCheckHeaders(this.options.bundleId),
      "content-type": "application/json",
    };
    const body = JSON.stringify(apnsCheckPayload(push));
    const environment = target.apnsEnvironment ?? this.options.environment;
    try {
      const first = await this.transportFor(environment).send(path, headers, body);
      if (!badDeviceToken(first.status, first.body)) return answer(first.status, first.body);
      // A token minted by the other kind of build lives on the other host.
      // Apple refused the first request, so asking the other host once cannot
      // deliver the push twice.
      const other: ApnsEnvironment = environment === "sandbox" ? "production" : "sandbox";
      const second = await this.transportFor(other).send(path, headers, body);
      return answer(second.status, second.body);
    } catch (error: unknown) {
      // No path, no headers and no body in the line: the path carries the push
      // token and the body carries the check_id.
      console.warn("check_push_failed", { provider: "apns", reason: error instanceof Error ? error.message : String(error) });
      return { outcome: "failed", status: 0 };
    }
  }

  close(): void {
    for (const transport of this.transports.values()) transport.close();
  }

  private transportFor(environment: ApnsEnvironment): ApnsTransport {
    const existing = this.transports.get(environment);
    if (existing !== undefined) return existing;
    const authority = apnsEndpoint(environment);
    const created = this.options.transport === undefined ? new Http2ApnsTransport(authority) : this.options.transport(authority);
    this.transports.set(environment, created);
    return created;
  }

  private authorization(now: number): string {
    if (this.cachedToken !== null && now - this.cachedToken.issuedAt < 50 * 60) return this.cachedToken.value;
    const value = signJwt({ alg: "ES256", kid: this.options.keyId }, { iss: this.options.teamId, iat: now }, this.options.privateKey, "ES256");
    this.cachedToken = { value, issuedAt: now };
    return value;
  }
}

function apnsReason(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed) return String((parsed as { reason: unknown }).reason);
  } catch {
    // Not JSON, so there is no reason to read.
  }
  return "";
}

function badDeviceToken(status: number, body: string): boolean {
  return status === 400 && apnsReason(body) === "BadDeviceToken";
}

// 410 is a token Apple has retired. BadDeviceToken here means both hosts said
// it, so the token belongs to neither.
function answer(status: number, body: string): CheckAnswer {
  if (status >= 200 && status < 300) return { outcome: "accepted", status };
  if (status === 410 || badDeviceToken(status, body)) return { outcome: "refused", status };
  return { outcome: "failed", status };
}

export interface FcmCheckSenderOptions {
  clock: Clock;
  fetch: PushFetch;
  projectId: string;
  clientEmail: string;
  privateKey: PrivateKey;
  tokenUrl: string;
}

export class FcmCheckSender implements CheckSender {
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: FcmCheckSenderOptions) {}

  async sendCheck(target: CheckTarget, push: CheckPush): Promise<CheckAnswer> {
    try {
      const token = await this.accessToken();
      if (token === null) return { outcome: "failed", status: 0 };
      const response = await this.options.fetch(
        new Request(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(fcmCheckMessage(target.pushToken, push)),
        }),
      );
      if (response.ok) return { outcome: "accepted", status: response.status };
      // FCM answers 404 with UNREGISTERED for a token it no longer knows.
      const unregistered = response.status === 404 || (await response.text().catch(() => "")).includes("UNREGISTERED");
      return { outcome: unregistered ? "refused" : "failed", status: response.status };
    } catch (error: unknown) {
      console.warn("check_push_failed", { provider: "fcm", reason: error instanceof Error ? error.message : String(error) });
      return { outcome: "failed", status: 0 };
    }
  }

  private async accessToken(): Promise<string | null> {
    const now = this.options.clock.now();
    if (this.cachedToken !== null && now < this.cachedToken.expiresAt - 60) return this.cachedToken.value;
    const assertion = signJwt(
      { alg: "RS256", typ: "JWT" },
      { iss: this.options.clientEmail, sub: this.options.clientEmail, aud: this.options.tokenUrl, scope: "https://www.googleapis.com/auth/firebase.messaging", iat: now, exp: now + 3_600 },
      this.options.privateKey,
      "RS256",
    );
    const response = await this.options.fetch(
      new Request(this.options.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      }),
    );
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
    if (body === null || typeof body.access_token !== "string" || typeof body.expires_in !== "number") return null;
    this.cachedToken = { value: body.access_token, expiresAt: now + body.expires_in };
    return body.access_token;
  }
}
