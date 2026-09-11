import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApnsSender } from "../apns.js";
import type { PushDevice } from "../types.js";
import type { DeliveryEvent } from "../../domain-events.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const device: PushDevice = {
  id: "dev_1",
  accountId: "acc_1",
  platform: "ios",
  pushToken: "device/token?one",
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

describe("ApnsSender", () => {
  it("sends a critical none-content incident with APNs headers and fallback payload", async () => {
    const requests: Request[] = [];
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "sandbox",
      clock: { now: () => 1_000 },
      fetch: async (request) => {
        requests.push(request);
        return new Response(null, { status: 200 });
      },
    });

    const result = await sender.send(device, event());

    expect(result).toEqual({ status: 200, stale: false });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe("https://api.sandbox.push.apple.com/3/device/device%2Ftoken%3Fone");
    expect(request.headers.get("apns-topic")).toBe("app.critalarm");
    expect(request.headers.get("apns-push-type")).toBe("alert");
    expect(request.headers.get("apns-priority")).toBe("10");
    expect(request.headers.get("apns-collapse-id")).toBe("inc_1");
    expect(request.headers.get("apns-expiration")).toBe("1060");
    const authorization = request.headers.get("authorization");
    expect(authorization).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/);
    const [, compactJwt] = authorization!.split(" ");
    const [header, claims, signature] = compactJwt.split(".");
    expect(decodeJwtPart(header)).toEqual({ alg: "ES256", kid: "key_1" });
    expect(decodeJwtPart(claims)).toEqual({ iss: "team_1", iat: 1_000 });
    expect(
      verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
    ).toBe(true);
    await expect(request.json()).resolves.toEqual({
      aps: {
        alert: { title: "Crit Alarm", body: "Critical alert on prod — open to see details" },
        sound: { critical: 1, name: "alarm.caf", volume: 1 },
        "interruption-level": "critical",
        "mutable-content": 1,
        category: "INCIDENT",
      },
      incident_id: "inc_1",
      server: "https://alerts.example.com",
      kind: "open",
    });
  });

  it("uses a time-sensitive payload without critical sound for p4 and noncritical p5", async () => {
    const bodies: unknown[] = [];
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_000 },
      fetch: async (request) => {
        bodies.push(await request.json());
        return new Response(null, { status: 200 });
      },
    });

    await sender.send(device, event({ kind: "p4", incidentId: null, messageId: "m_4", priority: 4, critical: false }));
    await sender.send(device, event({ kind: "p5", critical: false }));

    expect(bodies).toEqual([
      {
        aps: {
          alert: { title: "Crit Alarm", body: "Critical alert on prod — open to see details" },
          "interruption-level": "time-sensitive",
          "mutable-content": 1,
          category: "INCIDENT",
        },
        server: "https://alerts.example.com",
        kind: "p4",
      },
      {
        aps: {
          alert: { title: "Crit Alarm", body: "Critical alert on prod — open to see details" },
          "interruption-level": "time-sensitive",
          "mutable-content": 1,
          category: "INCIDENT",
        },
        incident_id: "inc_1",
        server: "https://alerts.example.com",
        kind: "p5",
      },
    ]);
  });

  it("marks an unregistered APNs token stale and reuses its provider JWT within fifty minutes", async () => {
    const authorizations: string[] = [];
    let now = 1_000;
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => now },
      fetch: async (request) => {
        authorizations.push(request.headers.get("authorization")!);
        return new Response(null, { status: 410 });
      },
    });

    expect(await sender.send(device, event())).toEqual({ status: 410, stale: true });
    now = 3_999;
    await sender.send(device, event());

    expect(authorizations).toHaveLength(2);
    expect(authorizations[1]).toBe(authorizations[0]);
  });
});
