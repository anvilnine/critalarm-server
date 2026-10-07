import type { Clock } from "../incident/types.js";
import { apnsEndpoint, Http2ApnsTransport, type ApnsTransport } from "./apns.js";
import { ApnsProviderToken } from "./apns-token.js";
import { signJwt } from "./jwt.js";
import type { ApnsEnvironment, PrivateKey, PushFetch } from "./types.js";

// api.md §5.4. The weekly check push, for APNs and for FCM.
//
// This file builds its own headers and its own payloads and does not call the
// alarm senders. No alarm type comes in here, so nothing in it can pick up an
// alert, a sound or a collapse id from one. It keeps its own connections, so a
// check that times out tears down a connection no alarm is using. The APNs
// provider token is the one thing it shares with the alarm sender, because
// Apple counts tokens per signing key.
//
// Every call to a provider has a time limit. A call that does not answer in
// time is a failed attempt, and the scan moves on.

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
// `cancelled` means nothing was sent, because the caller said the check was no
// longer wanted.
export interface CheckAnswer {
  outcome: "accepted" | "refused" | "failed" | "cancelled";
  status: number;
}

// `stillWanted` is asked immediately before each request that carries the
// check leaves, after any provider token has been obtained. False means send
// nothing.
export interface CheckSender {
  sendCheck(target: CheckTarget, push: CheckPush, stillWanted?: () => boolean): Promise<CheckAnswer>;
}

export const CHECK_TIMEOUT_MS = 10_000;

const cancelled: CheckAnswer = { outcome: "cancelled", status: 0 };

// Rejects when `promise` has not settled in `ms`. The promise itself is left
// to finish or hang on its own. Its result is ignored after that.
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

// A caller that cannot say is treated as saying no.
function wanted(stillWanted: (() => boolean) | undefined): boolean {
  if (stillWanted === undefined) return true;
  try {
    return stillWanted();
  } catch {
    return false;
  }
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
  // The provider token the alarm sender holds. Given, this sender uses it and
  // signs none of its own.
  providerToken?: ApnsProviderToken;
  timeoutMs?: number;
}

export class ApnsCheckSender implements CheckSender {
  private readonly providerToken: ApnsProviderToken;
  private readonly timeoutMs: number;
  // Opened on the first check and not before, so a relay with no enrolled
  // device never dials Apple for this.
  private readonly transports = new Map<ApnsEnvironment, ApnsTransport>();

  constructor(private readonly options: ApnsCheckSenderOptions) {
    this.providerToken = options.providerToken ?? new ApnsProviderToken(options);
    this.timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  }

  async sendCheck(target: CheckTarget, push: CheckPush, stillWanted?: () => boolean): Promise<CheckAnswer> {
    const path = `/3/device/${encodeURIComponent(target.pushToken)}`;
    const headers = {
      authorization: `bearer ${this.providerToken.get(this.options.clock.now())}`,
      ...apnsCheckHeaders(this.options.bundleId),
      "content-type": "application/json",
    };
    const body = JSON.stringify(apnsCheckPayload(push));
    const environment = target.apnsEnvironment ?? this.options.environment;
    try {
      if (!wanted(stillWanted)) return cancelled;
      const first = await within(this.transportFor(environment).send(path, headers, body), this.timeoutMs);
      if (!badDeviceToken(first.status, first.body)) return answer(first.status, first.body);
      // A token minted by the other kind of build lives on the other host.
      // Apple refused the first request, so asking the other host once cannot
      // deliver the push twice.
      const other: ApnsEnvironment = environment === "sandbox" ? "production" : "sandbox";
      if (!wanted(stillWanted)) return cancelled;
      const second = await within(this.transportFor(other).send(path, headers, body), this.timeoutMs);
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
  timeoutMs?: number;
}

export class FcmCheckSender implements CheckSender {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly options: FcmCheckSenderOptions) {
    this.timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  }

  async sendCheck(target: CheckTarget, push: CheckPush, stillWanted?: () => boolean): Promise<CheckAnswer> {
    try {
      const token = await within(this.accessToken(), this.timeoutMs);
      if (token === null) return { outcome: "failed", status: 0 };
      // Fetching the access token can take a while. Ask again now that the
      // next thing to happen is the check leaving.
      if (!wanted(stillWanted)) return cancelled;
      return await within(this.post(token, target, push), this.timeoutMs);
    } catch (error: unknown) {
      console.warn("check_push_failed", { provider: "fcm", reason: error instanceof Error ? error.message : String(error) });
      return { outcome: "failed", status: 0 };
    }
  }

  // The request and the reading of its answer, under one time limit.
  private async post(token: string, target: CheckTarget, push: CheckPush): Promise<CheckAnswer> {
    const response = await this.options.fetch(
      new Request(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(fcmCheckMessage(target.pushToken, push)),
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
    );
    if (response.ok) return { outcome: "accepted", status: response.status };
    // Only an answer that names the token as unregistered is a refused token.
    // A 404 with anything else in it is the provider failing: a wrong project
    // id answers 404 too, and that says nothing about the device.
    const body = await response.json().catch(() => null) as unknown;
    return { outcome: fcmUnregistered(body) ? "refused" : "failed", status: response.status };
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
        signal: AbortSignal.timeout(this.timeoutMs),
      }),
    );
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
    if (body === null || typeof body.access_token !== "string" || typeof body.expires_in !== "number") return null;
    this.cachedToken = { value: body.access_token, expiresAt: now + body.expires_in };
    return body.access_token;
  }
}

// The FCM v1 error format: { error: { details: [ { errorCode: "UNREGISTERED" } ] } }.
function fcmUnregistered(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const error = (body as { error: unknown }).error;
  if (typeof error !== "object" || error === null || !("details" in error)) return false;
  const details = (error as { details: unknown }).details;
  return Array.isArray(details) && details.some((detail: unknown) => typeof detail === "object" && detail !== null && (detail as { errorCode?: unknown }).errorCode === "UNREGISTERED");
}
