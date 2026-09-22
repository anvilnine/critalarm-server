import { isStateKind, type DeliveryEvent } from "../domain-events.js";
import { signJwt } from "./jwt.js";
import type { PrivateKey, PushDevice, PushResult, PushSender, SenderDependencies } from "./types.js";

const firebaseScope = "https://www.googleapis.com/auth/firebase.messaging";

export interface FcmSenderOptions extends SenderDependencies {
  projectId: string;
  clientEmail: string;
  privateKey: PrivateKey;
  tokenUrl: string;
}

type CachedToken = { value: string; expiresAt: number };
type TokenResult = { token: string } | { status: number };
type FcmTokenResponse = { access_token: string; expires_in: number };
type FcmErrorResponse = { error: { code?: number; status?: string; message?: string } };

export class FcmSender implements PushSender {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly options: FcmSenderOptions) {}

  async send(device: PushDevice, event: DeliveryEvent): Promise<PushResult> {
    const token = await this.accessToken();
    if ("status" in token) {
      return { status: token.status, stale: false };
    }
    const response = await this.options.fetch(
      new Request(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(fcmPayload(device, event)),
      }),
    );
    return { status: response.status, stale: false };
  }

  private async accessToken(): Promise<TokenResult> {
    const now = this.options.clock.now();
    if (this.cachedToken !== null && now < this.cachedToken.expiresAt - 60) {
      return { token: this.cachedToken.value };
    }
    const assertion = signJwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: this.options.clientEmail,
        sub: this.options.clientEmail,
        aud: this.options.tokenUrl,
        scope: firebaseScope,
        iat: now,
        exp: now + 3_600,
      },
      this.options.privateKey,
      "RS256",
    );
    const response = await this.options.fetch(
      new Request(this.options.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      }),
    );
    const body = await responseJson(response);
    if (!response.ok) {
      return { status: isFcmErrorResponse(body) ? body.error.code ?? response.status : response.status };
    }
    if (!isFcmTokenResponse(body)) {
      return { status: response.status };
    }
    this.cachedToken = { value: body.access_token, expiresAt: now + body.expires_in };
    return { token: body.access_token };
  }
}

function fcmPayload(device: PushDevice, event: DeliveryEvent): Record<string, unknown> {
  // api.md §5.2. A state push says the incident was handled somewhere else. It
  // carries the incident and the kind and nothing more: no priority, no title,
  // no body, nothing the app could ring on. Its ttl is 60 seconds, because a
  // stop that arrives after the phone stopped ringing is useless.
  const state = isStateKind(event.kind);
  return {
    message: {
      token: device.pushToken,
      android: {
        priority: "high",
        collapse_key: event.incidentId ?? event.messageId,
        ttl: state ? "60s" : `${event.maxRingS}s`,
      },
      data: {
        ...(event.incidentId === null ? {} : { incident_id: event.incidentId }),
        server: event.server,
        kind: event.kind,
        ...(state ? {} : { priority: String(event.priority) }),
        // Epoch seconds as a string, because every FCM data value is a string.
        ...(event.ringUntil === null ? {} : { ring_until: String(event.ringUntil) }),
        ...(!state && event.relayContent === "full" ? { title: event.title, body: event.body } : {}),
      },
    },
  };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function isFcmTokenResponse(value: unknown): value is FcmTokenResponse {
  return isRecord(value) && typeof value.access_token === "string" && typeof value.expires_in === "number";
}

function isFcmErrorResponse(value: unknown): value is FcmErrorResponse {
  return isRecord(value) && isRecord(value.error)
    && (value.error.code === undefined || typeof value.error.code === "number")
    && (value.error.status === undefined || typeof value.error.status === "string")
    && (value.error.message === undefined || typeof value.error.message === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
