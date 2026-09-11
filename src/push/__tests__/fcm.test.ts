import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DeliveryEvent } from "../../domain-events.js";
import { FcmSender } from "../fcm.js";
import type { PushDevice } from "../types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const device: PushDevice = {
  id: "dev_2",
  accountId: "acc_1",
  platform: "android",
  pushToken: "android-token",
};

function event(overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    kind: "open",
    topicHash: "hash_prod",
    topic: "prod",
    incidentId: "inc_1",
    messageId: "m_1",
    priority: 5,
    maxRingS: 60,
    server: "https://alerts.example.com",
    title: "Database",
    body: "db01 is down",
    critical: true,
    ...overrides,
  };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("FcmSender", () => {
  it("exchanges a signed service-account assertion and sends an exact data-only Android message", async () => {
    const tokenRequests: { url: string; body: URLSearchParams; contentType: string | null }[] = [];
    const sends: Request[] = [];
    const sender = new FcmSender({
      projectId: "crit-alarm-project",
      clientEmail: "push@crit-alarm-project.iam.gserviceaccount.com",
      privateKey,
      tokenUrl: "https://oauth.example.test/token",
      clock: { now: () => 1_000 },
      fetch: async (request) => {
        if (request.url === "https://oauth.example.test/token") {
          tokenRequests.push({
            url: request.url,
            body: new URLSearchParams(await request.text()),
            contentType: request.headers.get("content-type"),
          });
          return Response.json({ access_token: "access_1", expires_in: 3_600 });
        }
        sends.push(request);
        return new Response(null, { status: 200 });
      },
    });

    expect(await sender.send(device, event())).toEqual({ status: 200, stale: false });
    expect(tokenRequests).toHaveLength(1);
    const tokenRequest = tokenRequests[0];
    expect(tokenRequest.url).toBe("https://oauth.example.test/token");
    expect(tokenRequest.contentType).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(tokenRequest.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = tokenRequest.body.get("assertion");
    expect(assertion).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    const [header, claims, signature] = assertion!.split(".");
    expect(decodeJwtPart(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeJwtPart(claims)).toEqual({
      iss: "push@crit-alarm-project.iam.gserviceaccount.com",
      sub: "push@crit-alarm-project.iam.gserviceaccount.com",
      aud: "https://oauth.example.test/token",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      iat: 1_000,
      exp: 4_600,
    });
    expect(
      verify("sha256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].url).toBe("https://fcm.googleapis.com/v1/projects/crit-alarm-project/messages:send");
    expect(sends[0].headers.get("authorization")).toBe("Bearer access_1");
    await expect(sends[0].json()).resolves.toEqual({
      message: {
        token: "android-token",
        android: { priority: "high", collapse_key: "inc_1", ttl: "60s" },
        data: {
          incident_id: "inc_1",
          server: "https://alerts.example.com",
          kind: "open",
          priority: "5",
        },
      },
    });
  });

  it("does not send title or body in none mode and caches the access token until shortly before expiry", async () => {
    let now = 1_000;
    let tokenExchanges = 0;
    const requests: Request[] = [];
    const sender = new FcmSender({
      projectId: "crit-alarm-project",
      clientEmail: "push@crit-alarm-project.iam.gserviceaccount.com",
      privateKey,
      tokenUrl: "https://oauth.example.test/token",
      clock: { now: () => now },
      fetch: async (request) => {
        if (request.url === "https://oauth.example.test/token") {
          tokenExchanges += 1;
          return Response.json({ access_token: "access_1", expires_in: 3_600 });
        }
        requests.push(request);
        return new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } }), { status: 400 });
      },
    });

    expect(await sender.send(device, event())).toEqual({ status: 400, stale: false });
    now = 4_500;
    await sender.send(device, event({ kind: "p4", incidentId: null, messageId: "m_4", priority: 4, critical: false }));

    expect(tokenExchanges).toBe(1);
    await expect(requests[0].json()).resolves.toEqual({
      message: {
        token: "android-token",
        android: { priority: "high", collapse_key: "inc_1", ttl: "60s" },
        data: {
          incident_id: "inc_1",
          server: "https://alerts.example.com",
          kind: "open",
          priority: "5",
        },
      },
    });
    await expect(requests[1].json()).resolves.toEqual({
      message: {
        token: "android-token",
        android: { priority: "high", collapse_key: "m_4", ttl: "60s" },
        data: {
          server: "https://alerts.example.com",
          kind: "p4",
          priority: "4",
        },
      },
    });
  });
});
