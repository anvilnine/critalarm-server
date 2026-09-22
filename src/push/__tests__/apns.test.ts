import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApnsSender } from "../apns.js";
import type { ApnsTransport, ApnsTransportResponse } from "../apns.js";
import type { PushDevice } from "../types.js";
import type { DeliveryEvent } from "../../domain-events.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const device: PushDevice = {
  id: "dev_1",
  accountId: "acc_1",
  platform: "ios",
  pushToken: "device/token?one",
};

type Sent = { path: string; headers: Record<string, string>; body: string };

// The HTTP/2 stand-in. No socket is opened anywhere in this file: the sender
// only ever talks to an ApnsTransport, and this is one.
class FakeTransport implements ApnsTransport {
  readonly sent: Sent[] = [];
  closed = 0;

  constructor(private readonly reply: (sent: Sent) => Promise<ApnsTransportResponse>) {}

  async send(path: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse> {
    const sent = { path, headers, body };
    this.sent.push(sent);
    return this.reply(sent);
  }

  close(): void {
    this.closed += 1;
  }
}

function replies(status: number, body = ""): FakeTransport {
  return new FakeTransport(async () => ({ status, headers: { ":status": String(status) }, body }));
}

function jsonBody(sent: Sent): Record<string, unknown> {
  return JSON.parse(sent.body) as Record<string, unknown>;
}

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
    ringUntil: 1_060,
    ...overrides,
  };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("ApnsSender", () => {
  it("sends a critical none-content incident with APNs headers and fallback payload", async () => {
    const transport = replies(200);
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "sandbox",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    const result = await sender.send(device, event());

    expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0]!;
    expect(sent.path).toBe("/3/device/device%2Ftoken%3Fone");
    expect(sent.headers["apns-topic"]).toBe("app.critalarm");
    expect(sent.headers["apns-push-type"]).toBe("alert");
    expect(sent.headers["apns-priority"]).toBe("10");
    expect(sent.headers["apns-collapse-id"]).toBe("inc_1");
    expect(sent.headers["apns-expiration"]).toBe("1060");
    const authorization = sent.headers.authorization;
    expect(authorization).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/);
    const [, compactJwt] = authorization!.split(" ");
    const [header, claims, signature] = compactJwt!.split(".");
    expect(decodeJwtPart(header!)).toEqual({ alg: "ES256", kid: "key_1" });
    expect(decodeJwtPart(claims!)).toEqual({ iss: "team_1", iat: 1_000 });
    expect(
      verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url")),
    ).toBe(true);
    expect(jsonBody(sent)).toEqual({
      aps: {
        alert: { title: "Crit Alarm", body: "Critical alert on prod — open to see details" },
        sound: "alarm.caf",
        "interruption-level": "time-sensitive",
        "mutable-content": 1,
        "content-available": 1,
        category: "INCIDENT",
      },
      incident_id: "inc_1",
      server: "https://alerts.example.com",
      ring_until: 1_060,
      kind: "open",
    });
  });

  // The app schedules the AlarmKit alarm from its background-push handler, and
  // iOS only calls that handler when the push carries content-available. Drop
  // this and the phone plays a sound and never rings an alarm.
  it("wakes the app on a critical incident and leaves other pushes asleep", async () => {
    const transport = replies(200);
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    await sender.send(device, event());
    await sender.send(device, event({ kind: "p5", critical: false, messageId: "m_quiet" }));
    await sender.send(device, event({ kind: "p4", incidentId: null, messageId: "m_4", priority: 4, critical: false, ringUntil: null }));

    const wakes = transport.sent.map((sent) => (jsonBody(sent).aps as Record<string, unknown>)["content-available"]);
    expect(wakes).toEqual([1, undefined, undefined]);
  });

  // Apple denied the Critical Alerts entitlement. A payload that asks for one
  // is rejected, so no send may carry a critical sound or interruption level.
  it("never asks for a critical alert on a critical topic", async () => {
    const transport = replies(200);
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    await sender.send(device, event());
    await sender.send(device, event({ relayContent: "full" }));

    for (const sent of transport.sent) {
      const aps = jsonBody(sent).aps as Record<string, unknown>;
      expect(aps["interruption-level"]).toBe("time-sensitive");
      expect(aps.sound).toBe("alarm.caf");
      expect(typeof aps.sound).toBe("string");
      expect(JSON.stringify(aps.sound)).not.toContain("critical");
    }
  });

  it("uses a time-sensitive payload without critical sound for p4 and noncritical p5", async () => {
    const transport = replies(200);
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    await sender.send(device, event({ kind: "p4", incidentId: null, messageId: "m_4", priority: 4, critical: false, ringUntil: null }));
    await sender.send(device, event({ kind: "p5", critical: false }));

    expect(transport.sent.map(jsonBody)).toEqual([
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
        ring_until: 1_060,
      },
    ]);
  });

  it("marks an unregistered APNs token stale and reuses its provider JWT within fifty minutes", async () => {
    const transport = replies(410, JSON.stringify({ reason: "Unregistered" }));
    let now = 1_000;
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => now },
      transport: () => transport,
    });

    expect(await sender.send(device, event())).toEqual({ status: 410, stale: true, apnsEnvironment: "production" });
    now = 3_999;
    await sender.send(device, event());

    const authorizations = transport.sent.map((sent) => sent.headers.authorization);
    expect(authorizations).toHaveLength(2);
    expect(authorizations[1]).toBe(authorizations[0]);
  });

  // DeviceTokenNotForTopic, not BadDeviceToken. BadDeviceToken now means the
  // token belongs to the other Apple host and sends a second push there, so it
  // is no longer a plain refusal.
  it("reports a rejection that is not a 410 without marking the device stale, and logs Apple's reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = replies(400, JSON.stringify({ reason: "DeviceTokenNotForTopic" }));
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    expect(await sender.send(device, event())).toEqual({ status: 400, stale: false, apnsEnvironment: "production" });
    expect(warn).toHaveBeenCalledWith("apns_rejected", { environment: "production", status: 400, reason: "DeviceTokenNotForTopic" });
    // The push token rides in the path, so nothing logged may contain it.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("device%2Ftoken");
    warn.mockRestore();
  });

  it("surfaces a transport failure as an error with a readable message", async () => {
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_000 },
      transport: () => new FakeTransport(async () => {
        throw new Error("apns transport failed: connect ECONNREFUSED 17.0.0.1:443");
      }),
    });

    // The publish path logs error.message, so an empty or opaque error there
    // is the failure this guards against.
    const error = await sender.send(device, event()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("apns transport failed: connect ECONNREFUSED 17.0.0.1:443");
  });

  it("retries once on a transport failure and delivers on the second try", async () => {
    let attempts = 0;
    const transport = new FakeTransport(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("apns transport failed: no answer from apple in 5000ms");
      return { status: 200, headers: { ":status": "200" }, body: "" };
    });
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "sandbox",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    const result = await sender.send(device, event());

    expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    expect(attempts).toBe(2);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]!.body).toBe(transport.sent[1]!.body);
  });

  it("gives up after one retry so a real outage does not hang twice over", async () => {
    let attempts = 0;
    const transport = new FakeTransport(async () => {
      attempts += 1;
      throw new Error("apns transport failed: apple is down");
    });
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "sandbox",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    await expect(sender.send(device, event())).rejects.toThrow("apple is down");
    expect(attempts).toBe(2);
  });

  it("does not retry a push Apple refused", async () => {
    const transport = replies(400, JSON.stringify({ reason: "DeviceTokenNotForTopic" }));
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "sandbox",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    const result = await sender.send(device, event());

    expect(result).toEqual({ status: 400, stale: false, apnsEnvironment: "sandbox" });
    expect(transport.sent).toHaveLength(1);
  });

  it("closes its transport on shutdown", () => {
    const transport = replies(200);
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_000 },
      transport: () => transport,
    });

    sender.close();

    expect(transport.closed).toBe(1);
  });
});

const PRODUCTION_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";
const badDeviceToken = JSON.stringify({ reason: "BadDeviceToken" });

// One fake per Apple host, keyed the way the sender dials them. Apple really
// does answer differently on the two hosts for the same token, so a test that
// shares one fake between them cannot show the difference.
function hosts(answers: Record<string, { status: number; body?: string }>) {
  const fakes = new Map<string, FakeTransport>();
  const transport = (authority: string): FakeTransport => {
    const answer = answers[authority] ?? { status: 500 };
    const fake = new FakeTransport(async () => ({
      status: answer.status,
      headers: { ":status": String(answer.status) },
      body: answer.body ?? "",
    }));
    fakes.set(authority, fake);
    return fake;
  };
  return { transport, sentTo: (authority: string) => fakes.get(authority)?.sent ?? [] };
}

function senderOn(environment: "sandbox" | "production", transport: (authority: string) => ApnsTransport) {
  return new ApnsSender({
    teamId: "team_1",
    keyId: "key_1",
    privateKey,
    bundleId: "app.critalarm",
    environment,
    clock: { now: () => 1_000 },
    transport,
  });
}

describe("ApnsSender across the two Apple hosts", () => {
  it("sends a sandbox device's token to the sandbox host even though the server is set to production", async () => {
    const { transport, sentTo } = hosts({ [SANDBOX_HOST]: { status: 200 }, [PRODUCTION_HOST]: { status: 200 } });

    const result = await senderOn("production", transport).send({ ...device, apnsEnvironment: "sandbox" }, event());

    expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    expect(sentTo(SANDBOX_HOST)).toHaveLength(1);
    expect(sentTo(PRODUCTION_HOST)).toHaveLength(0);
  });

  it("falls back to sandbox when production refuses a Debug build's token with BadDeviceToken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, sentTo } = hosts({
      [PRODUCTION_HOST]: { status: 400, body: badDeviceToken },
      [SANDBOX_HOST]: { status: 200 },
    });

    const result = await senderOn("production", transport).send(device, event());

    expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    expect(sentTo(PRODUCTION_HOST)).toHaveLength(1);
    expect(sentTo(SANDBOX_HOST)).toHaveLength(1);
    warn.mockRestore();
  });

  it("falls back to production when sandbox refuses a TestFlight build's token with BadDeviceToken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, sentTo } = hosts({
      [SANDBOX_HOST]: { status: 400, body: badDeviceToken },
      [PRODUCTION_HOST]: { status: 200 },
    });

    const result = await senderOn("sandbox", transport).send(device, event());

    expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "production" });
    expect(sentTo(SANDBOX_HOST)).toHaveLength(1);
    expect(sentTo(PRODUCTION_HOST)).toHaveLength(1);
    warn.mockRestore();
  });

  it("sends the same push body to the second host, so the fallback rings the same alarm", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, sentTo } = hosts({
      [PRODUCTION_HOST]: { status: 400, body: badDeviceToken },
      [SANDBOX_HOST]: { status: 200 },
    });

    await senderOn("production", transport).send(device, event());

    expect(sentTo(SANDBOX_HOST)[0]!.body).toBe(sentTo(PRODUCTION_HOST)[0]!.body);
    expect(sentTo(SANDBOX_HOST)[0]!.path).toBe(sentTo(PRODUCTION_HOST)[0]!.path);
    warn.mockRestore();
  });

  it("logs the switch when the other host accepts, so a wrong-environment token is never silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport } = hosts({
      [PRODUCTION_HOST]: { status: 400, body: badDeviceToken },
      [SANDBOX_HOST]: { status: 200 },
    });

    await senderOn("production", transport).send(device, event());

    expect(warn).toHaveBeenCalledWith("apns_rejected", { environment: "production", status: 400, reason: "BadDeviceToken" });
    expect(warn).toHaveBeenCalledWith("apns_environment_switched", { from: "production", to: "sandbox", bundle_id: "app.critalarm" });
    // The push token rides in the path, so nothing logged may contain it.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("device%2Ftoken");
    warn.mockRestore();
  });

  it("tries each host once and names both in the log when the token belongs to neither", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, sentTo } = hosts({
      [PRODUCTION_HOST]: { status: 400, body: badDeviceToken },
      [SANDBOX_HOST]: { status: 400, body: badDeviceToken },
    });

    const result = await senderOn("production", transport).send(device, event());

    expect(result).toEqual({ status: 400, stale: false, apnsEnvironment: "sandbox" });
    expect(sentTo(PRODUCTION_HOST)).toHaveLength(1);
    expect(sentTo(SANDBOX_HOST)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("apns_rejected", { environment: "production", status: 400, reason: "BadDeviceToken" });
    expect(warn).toHaveBeenCalledWith("apns_rejected", { environment: "sandbox", status: 400, reason: "BadDeviceToken" });
    expect(warn).not.toHaveBeenCalledWith("apns_environment_switched", expect.anything());
    warn.mockRestore();
  });

  it("stays on one host when Apple refuses for a reason other than BadDeviceToken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, sentTo } = hosts({
      [PRODUCTION_HOST]: { status: 400, body: JSON.stringify({ reason: "DeviceTokenNotForTopic" }) },
      [SANDBOX_HOST]: { status: 200 },
    });

    const result = await senderOn("production", transport).send(device, event());

    expect(result).toEqual({ status: 400, stale: false, apnsEnvironment: "production" });
    expect(sentTo(SANDBOX_HOST)).toHaveLength(0);
    warn.mockRestore();
  });

  it("stays on one host when Apple says the token is unregistered, so a stale token is not chased", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, sentTo } = hosts({
      [PRODUCTION_HOST]: { status: 410, body: JSON.stringify({ reason: "Unregistered" }) },
      [SANDBOX_HOST]: { status: 200 },
    });

    const result = await senderOn("production", transport).send(device, event());

    expect(result).toEqual({ status: 410, stale: true, apnsEnvironment: "production" });
    expect(sentTo(SANDBOX_HOST)).toHaveLength(0);
    warn.mockRestore();
  });

  it("sends a Live Activity push to the host its device is known to be on", async () => {
    const { transport, sentTo } = hosts({ [SANDBOX_HOST]: { status: 200 }, [PRODUCTION_HOST]: { status: 200 } });

    const result = await senderOn("production", transport).sendLiveActivity({
      token: "la/token",
      event: "start",
      incidentId: "inc_1",
      topic: "prod",
      server: "https://alerts.example.com",
      state: "open",
      title: "Database",
      openedAt: 900,
      apnsEnvironment: "sandbox",
    });

    expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    expect(sentTo(SANDBOX_HOST)).toHaveLength(1);
    expect(sentTo(PRODUCTION_HOST)).toHaveLength(0);
  });

  it("falls back to the other host for a Live Activity token too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, sentTo } = hosts({
      [PRODUCTION_HOST]: { status: 400, body: badDeviceToken },
      [SANDBOX_HOST]: { status: 200 },
    });

    const result = await senderOn("production", transport).sendLiveActivity({
      token: "la/token",
      event: "start",
      incidentId: "inc_1",
      topic: "prod",
      server: "https://alerts.example.com",
      state: "open",
      title: "Database",
      openedAt: 900,
    });

    expect(result).toEqual({ status: 200, stale: false, apnsEnvironment: "sandbox" });
    expect(sentTo(SANDBOX_HOST)).toHaveLength(1);
    warn.mockRestore();
  });

  it("closes both hosts on shutdown once it has dialled both", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakes = new Map<string, FakeTransport>();
    const sender = senderOn("production", (authority) => {
      const fake = new FakeTransport(async () => ({
        status: authority === PRODUCTION_HOST ? 400 : 200,
        headers: {},
        body: authority === PRODUCTION_HOST ? badDeviceToken : "",
      }));
      fakes.set(authority, fake);
      return fake;
    });
    await sender.send(device, event());

    sender.close();

    expect([...fakes.values()].map((fake) => fake.closed)).toEqual([1, 1]);
    expect(fakes.size).toBe(2);
    warn.mockRestore();
  });
});

describe("ApnsSender Live Activity pushes", () => {
  function senderFor(transport: ApnsTransport) {
    return new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "sandbox",
      clock: { now: () => 1_757_740_800 },
      transport: () => transport,
    });
  }

  const push = {
    token: "la/token",
    incidentId: "inc_1",
    topic: "prod",
    server: "https://alerts.example.com",
    state: "open" as const,
    title: "Database down",
    openedAt: 1_757_740_800,
  };

  it("starts an activity on the Live Activity topic with attributes", async () => {
    const transport = replies(200);

    await senderFor(transport).sendLiveActivity({ ...push, event: "start" });

    const sent = transport.sent[0]!;
    expect(sent.path).toBe("/3/device/la%2Ftoken");
    expect(sent.headers["apns-topic"]).toBe("app.critalarm.push-type.liveactivity");
    expect(sent.headers["apns-push-type"]).toBe("liveactivity");
    expect(sent.headers["apns-priority"]).toBe("10");
    expect(jsonBody(sent)).toEqual({
      aps: {
        timestamp: 1_757_740_800,
        event: "start",
        "attributes-type": "CritAlarmIncidentAttributes",
        attributes: { incident_id: "inc_1", topic: "prod", server: "https://alerts.example.com" },
        "content-state": { state: "open", title: "Database down", opened_at: 1_757_740_800 },
      },
    });
  });

  it("updates an activity with content-state only", async () => {
    const transport = replies(200);

    await senderFor(transport).sendLiveActivity({ ...push, event: "update", state: "acked" });

    expect(jsonBody(transport.sent[0]!)).toEqual({
      aps: {
        timestamp: 1_757_740_800,
        event: "update",
        "content-state": { state: "acked", title: "Database down", opened_at: 1_757_740_800 },
      },
    });
  });

  it("ends an activity with a dismissal date", async () => {
    const transport = replies(200);

    await senderFor(transport).sendLiveActivity({ ...push, event: "end", state: "closed" });

    expect(jsonBody(transport.sent[0]!)).toEqual({
      aps: {
        timestamp: 1_757_740_800,
        event: "end",
        "content-state": { state: "closed", title: "Database down", opened_at: 1_757_740_800 },
        "dismissal-date": 1_757_740_800,
      },
    });
  });

  it("reports a gone Live Activity token as stale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sender = new ApnsSender({
      teamId: "team_1",
      keyId: "key_1",
      privateKey,
      bundleId: "app.critalarm",
      environment: "production",
      clock: { now: () => 1_757_740_800 },
      transport: () => replies(410),
    });

    expect(await sender.sendLiveActivity({ ...push, event: "update" })).toEqual({ status: 410, stale: true, apnsEnvironment: "production" });
    warn.mockRestore();
  });
});
