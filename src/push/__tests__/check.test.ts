import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApnsTransport, ApnsTransportResponse } from "../apns.js";
import { ApnsCheckSender, FcmCheckSender, apnsCheckHeaders, apnsCheckPayload, fcmCheckMessage } from "../check.js";

// api.md §5.4. The exact headers and bodies of the weekly check push, and what
// each provider answer is read as. Nothing here opens a socket.

afterEach(() => { vi.restoreAllMocks(); });

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

// Words that belong to an alarm push and must appear nowhere in a check.
const forbidden = ["alert", "sound", "badge", "category", "apns-collapse-id", "collapse_key"];

const push = { checkId: "chk_5c1d", attempt: 1 };

type Sent = { authority: string; path: string; headers: Record<string, string>; body: string };

function apns(reply: (sent: Sent) => ApnsTransportResponse | Promise<ApnsTransportResponse> = () => ({ status: 200, headers: {}, body: "" }), environment: "sandbox" | "production" = "production") {
  const sent: Sent[] = [];
  const dialled: string[] = [];
  let closed = 0;
  const sender = new ApnsCheckSender({
    teamId: "team_1",
    keyId: "key_1",
    privateKey: ec.privateKey,
    bundleId: "app.critalarm",
    environment,
    clock: { now: () => 1_000 },
    transport: (authority): ApnsTransport => {
      dialled.push(authority);
      return {
        send: async (path, headers, body) => {
          const record = { authority, path, headers, body };
          sent.push(record);
          return reply(record);
        },
        close: () => { closed += 1; },
      };
    },
  });
  return { sender, sent, dialled, closed: () => closed };
}

function fcm(reply: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 200 })) {
  const sends: { url: string; headers: Record<string, string>; body: string }[] = [];
  let tokenRequests = 0;
  const sender = new FcmCheckSender({
    projectId: "crit-alarm-project",
    clientEmail: "push@crit-alarm-project.iam.gserviceaccount.com",
    privateKey: rsa.privateKey,
    tokenUrl: "https://oauth.example.test/token",
    clock: { now: () => 1_000 },
    fetch: async (request) => {
      if (request.url === "https://oauth.example.test/token") {
        tokenRequests += 1;
        return Response.json({ access_token: "access_1", expires_in: 3_600 });
      }
      sends.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: await request.clone().text() });
      return reply(request);
    },
  });
  return { sender, sends, tokenRequests: () => tokenRequests };
}

describe("the APNs check push", () => {
  it("sends exactly the four headers of the contract, plus the provider token and the content type", async () => {
    const { sender, sent } = apns();
    const answer = await sender.sendCheck({ platform: "ios", pushToken: "device/token?one" }, push);

    expect(answer).toEqual({ outcome: "accepted", status: 200 });
    expect(sent).toHaveLength(1);
    const { authorization, ...headers } = sent[0]?.headers ?? {};
    expect(headers).toEqual({
      "apns-topic": "app.critalarm",
      "apns-push-type": "background",
      "apns-priority": "5",
      "apns-expiration": "0",
      "content-type": "application/json",
    });
    expect(sent[0]?.path).toBe("/3/device/device%2Ftoken%3Fone");
    expect(sent[0]?.authority).toBe("https://api.push.apple.com");
    const [header, claims, signature] = (authorization ?? "").replace(/^bearer /, "").split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "ES256", kid: "key_1" });
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({ iss: "team_1", iat: 1_000 });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature ?? "", "base64url"))).toBe(true);
  });

  it("sends exactly the body of the contract", async () => {
    const { sender, sent } = apns();
    await sender.sendCheck({ platform: "ios", pushToken: "token" }, { checkId: "chk_5c1d", attempt: 2 });
    expect(sent[0]?.body).toBe('{"aps":{"content-available":1},"kind":"check","check_id":"chk_5c1d","attempt":2}');
  });

  it("aps holds content-available and nothing else", () => {
    expect(apnsCheckPayload(push).aps).toEqual({ "content-available": 1 });
    expect(Object.keys(apnsCheckPayload(push))).toEqual(["aps", "kind", "check_id", "attempt"]);
  });

  it("contains no alert, sound, badge, category, apns-collapse-id or collapse_key, in a header or in the body", async () => {
    const { sender, sent } = apns();
    await sender.sendCheck({ platform: "ios", pushToken: "token" }, push);
    const { authorization: _token, ...headers } = sent[0]?.headers ?? {};
    const wire = `${JSON.stringify(headers)}\n${sent[0]?.body}`;
    for (const word of forbidden) expect(wire).not.toContain(word);
    expect(wire).not.toContain("collapse");
    expect(wire).not.toContain("mutable-content");
    expect(wire).not.toContain("interruption-level");
    expect(JSON.stringify(apnsCheckHeaders("app.critalarm"))).not.toContain("collapse");
  });

  it("carries no server, no title and no body", () => {
    const text = JSON.stringify(apnsCheckPayload(push));
    for (const word of ["server", "title", "body", "incident"]) expect(text).not.toContain(word);
  });

  it("dials Apple only when the first check is sent", async () => {
    const { sender, dialled } = apns();
    expect(dialled).toEqual([]);
    await sender.sendCheck({ platform: "ios", pushToken: "token" }, push);
    await sender.sendCheck({ platform: "ios", pushToken: "token" }, push);
    expect(dialled).toEqual(["https://api.push.apple.com"]);
  });

  it("starts on the host the device is known to be on", async () => {
    const { sender, sent } = apns();
    await sender.sendCheck({ platform: "ios", pushToken: "token", apnsEnvironment: "sandbox" }, push);
    expect(sent.map((record) => record.authority)).toEqual(["https://api.sandbox.push.apple.com"]);
  });

  it("reads a 410 as a refused token", async () => {
    const { sender, sent } = apns(() => ({ status: 410, headers: {}, body: '{"reason":"Unregistered"}' }));
    expect(await sender.sendCheck({ platform: "ios", pushToken: "token" }, push)).toEqual({ outcome: "refused", status: 410 });
    expect(sent).toHaveLength(1);
  });

  it("asks the other host once on BadDeviceToken, and reads it as refused only when both say it", async () => {
    const both = apns(() => ({ status: 400, headers: {}, body: '{"reason":"BadDeviceToken"}' }));
    expect(await both.sender.sendCheck({ platform: "ios", pushToken: "token" }, push)).toEqual({ outcome: "refused", status: 400 });
    expect(both.sent.map((record) => record.authority)).toEqual(["https://api.push.apple.com", "https://api.sandbox.push.apple.com"]);
    expect(both.sent[1]?.body).toBe(both.sent[0]?.body);

    const other = apns((record) => record.authority.includes("sandbox") ? { status: 200, headers: {}, body: "" } : { status: 400, headers: {}, body: '{"reason":"BadDeviceToken"}' });
    expect(await other.sender.sendCheck({ platform: "ios", pushToken: "token" }, push)).toEqual({ outcome: "accepted", status: 200 });
  });

  it("reads every other answer as a failed attempt, not a refused token", async () => {
    for (const [status, body] of [[400, '{"reason":"DeviceTokenNotForTopic"}'], [403, '{"reason":"InvalidProviderToken"}'], [429, ""], [500, ""], [503, "not json"]] as const) {
      const { sender } = apns(() => ({ status, headers: {}, body }));
      expect(await sender.sendCheck({ platform: "ios", pushToken: "token" }, push)).toEqual({ outcome: "failed", status });
    }
  });

  it("does not retry a send that got no answer, and logs neither the token nor the check_id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sender, sent } = apns(() => { throw new Error("apns transport failed: no answer"); });
    expect(await sender.sendCheck({ platform: "ios", pushToken: "secret-push-token" }, push)).toEqual({ outcome: "failed", status: 0 });
    expect(sent).toHaveLength(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("chk_5c1d");
    expect(logged).not.toContain("secret-push-token");
  });

  it("closes the connections it opened", async () => {
    const { sender, closed } = apns();
    sender.close();
    expect(closed()).toBe(0);
    await sender.sendCheck({ platform: "ios", pushToken: "token" }, push);
    sender.close();
    expect(closed()).toBe(1);
  });
});

describe("the FCM check push", () => {
  it("sends exactly the message of the contract", async () => {
    const { sender, sends } = fcm();
    const answer = await sender.sendCheck({ platform: "android", pushToken: "android-token" }, push);

    expect(answer).toEqual({ outcome: "accepted", status: 200 });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.url).toBe("https://fcm.googleapis.com/v1/projects/crit-alarm-project/messages:send");
    expect(sends[0]?.headers).toMatchObject({ authorization: "Bearer access_1", "content-type": "application/json" });
    expect(sends[0]?.body).toBe('{"message":{"token":"android-token","android":{"priority":"normal","ttl":"21600s"},"data":{"kind":"check","check_id":"chk_5c1d","attempt":"1"}}}');
    expect(JSON.parse(sends[0]?.body ?? "")).toEqual({
      message: {
        token: "android-token",
        android: { priority: "normal", ttl: "21600s" },
        data: { kind: "check", check_id: "chk_5c1d", attempt: "1" },
      },
    });
  });

  it("is data only, at normal priority, with six hours to live and no collapse key", () => {
    const message = fcmCheckMessage("android-token", { checkId: "chk_5c1d", attempt: 3 }).message as Record<string, unknown>;
    expect(Object.keys(message)).toEqual(["token", "android", "data"]);
    expect(message.android).toEqual({ priority: "normal", ttl: "21600s" });
    expect(message.data).toEqual({ kind: "check", check_id: "chk_5c1d", attempt: "3" });
  });

  it("contains no alert, sound, badge, category, apns-collapse-id or collapse_key", async () => {
    const { sender, sends } = fcm();
    await sender.sendCheck({ platform: "android", pushToken: "android-token" }, push);
    const wire = sends[0]?.body ?? "";
    for (const word of [...forbidden, "collapse", "notification", "high", "server", "title", "body", "incident"]) expect(wire).not.toContain(word);
  });

  it("reads UNREGISTERED as a refused token", async () => {
    const gone = fcm(() => Response.json({ error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 }));
    expect(await gone.sender.sendCheck({ platform: "android", pushToken: "t" }, push)).toEqual({ outcome: "refused", status: 404 });
  });

  it("reads every other answer as a failed attempt", async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const { sender } = fcm(() => Response.json({ error: { code: status, status: "SOMETHING" } }, { status }));
      expect(await sender.sendCheck({ platform: "android", pushToken: "t" }, push)).toEqual({ outcome: "failed", status });
    }
  });

  it("fetches one access token and reuses it", async () => {
    const { sender, tokenRequests } = fcm();
    await sender.sendCheck({ platform: "android", pushToken: "t" }, push);
    await sender.sendCheck({ platform: "android", pushToken: "t" }, push);
    expect(tokenRequests()).toBe(1);
  });

  it("a send that throws is a failed attempt, and the log line holds neither the token nor the check_id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sender } = fcm(() => { throw new Error("fetch failed"); });
    expect(await sender.sendCheck({ platform: "android", pushToken: "secret-push-token" }, push)).toEqual({ outcome: "failed", status: 0 });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("chk_5c1d");
    expect(logged).not.toContain("secret-push-token");
  });
});
