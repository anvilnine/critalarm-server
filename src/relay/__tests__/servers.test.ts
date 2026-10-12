import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayRouter, type RelayRouterOptions } from "../router.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";

const CHALLENGE = "k".repeat(43);
const BASE = "https://alerts.example.com";
// The host the registration request is called on.
const HOST = "relay.critalarm.app";
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

function setup(options: RelayRouterOptions = {}, db = openDatabase(":memory:")) {
  migrate(db);
  const confirm = vi.fn(async () => true);
  const clock = { t: 1_800_000_000 };
  const app = createRelayRouter(db, vi.fn(async () => {}), new Counters(db, { now: () => 1 }), { behindProxy: true, confirmChallenge: confirm, clock: { now: () => clock.t }, ...options });
  return { db, app, confirm, clock };
}

type Fields = { base_url?: unknown; version?: unknown; challenge?: unknown };
function register(app: ReturnType<typeof createRelayRouter>, fields: Fields = {}, headers: Record<string, string> = {}) {
  const body = { base_url: BASE, version: "0.1.0", challenge: CHALLENGE, ...fields };
  return app.request("/relay/v1/servers", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.114.1", host: HOST, ...headers }, body: JSON.stringify(body) });
}
const rows = (db: ReturnType<typeof openDatabase>) => (db.prepare("SELECT count(*) AS rows FROM relay_servers").get() as { rows: number }).rows;

describe("relay server registration without a secret", () => {
  it("issues a key to a server whose challenge the relay confirms", async () => {
    const { db, app, confirm } = setup();
    try {
      const response = await register(app);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ relay_key: expect.stringMatching(/^rk_[0-9a-f]{32}$/) });
      expect(confirm).toHaveBeenCalledWith(BASE, CHALLENGE, HOST);
      expect(db.prepare("SELECT base_url, version, legacy FROM relay_servers").all()).toEqual([{ base_url: BASE, version: "0.1.0", legacy: 0 }]);
    } finally { db.close(); }
  });

  it("passes the Host of the request, in lower case, to the confirmer", async () => {
    const { db, app, confirm } = setup();
    try {
      expect((await register(app, {}, { host: "Relay.CritAlarm.App:8443" })).status).toBe(201);
      expect(confirm).toHaveBeenCalledWith(BASE, CHALLENGE, "relay.critalarm.app:8443");
    } finally { db.close(); }
  });

  it("answers 422 and calls nobody when the request has no Host header", async () => {
    const { db, app, confirm } = setup();
    try {
      const response = await app.request("/relay/v1/servers", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.114.1" }, body: JSON.stringify({ base_url: BASE, version: "0.1.0", challenge: CHALLENGE }) });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "challenge failed" });
      expect(confirm).not.toHaveBeenCalled();
      expect(rows(db)).toBe(0);
    } finally { db.close(); }
  });

  it("is mounted whether or not an operator secret is set", async () => {
    for (const registrationSecret of [undefined, "", "operator-secret"]) {
      const { db, app } = setup(registrationSecret === undefined ? {} : { registrationSecret });
      try { expect((await register(app)).status).toBe(201); } finally { db.close(); }
    }
  });

  it("answers 422 and writes no row when the confirmer says no", async () => {
    const { db, app, confirm } = setup();
    try {
      confirm.mockResolvedValueOnce(false);
      const response = await register(app);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "challenge failed" });
      expect(rows(db)).toBe(0);
    } finally { db.close(); }
  });

  it.each([
    ["a missing base_url", { base_url: undefined }],
    ["a base_url that is not a string", { base_url: 7 }],
    ["a missing version", { version: undefined }],
    ["a missing challenge", { challenge: undefined }],
    ["a challenge under 32 characters", { challenge: "a".repeat(31) }],
    ["a challenge over 128 characters", { challenge: "a".repeat(129) }],
    ["a challenge with a character outside the set", { challenge: `${"a".repeat(40)}!` }],
  ])("answers 400 invalid request for %s", async (_name, fields) => {
    const { db, app, confirm } = setup();
    try {
      const response = await register(app, fields);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
      expect(confirm).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("answers 400 invalid request for a body that is not JSON", async () => {
    const { db, app } = setup();
    try {
      const response = await app.request("/relay/v1/servers", { method: "POST", body: "nope" });
      expect(response.status).toBe(400);
    } finally { db.close(); }
  });

  it.each([
    ["http", "http://alerts.example.com"],
    ["an IPv4 literal", "https://203.0.113.5"],
    ["an IPv6 literal", "https://[2606:4700::1111]"],
    ["a name with no dot", "https://alerts"],
    ["localhost", "https://localhost"],
    ["a .local name", "https://box.local"],
    ["a .localhost name", "https://box.localhost"],
    ["a .internal name", "https://box.internal"],
    ["a .lan name", "https://box.lan"],
    ["a .home.arpa name", "https://box.home.arpa"],
    ["a user name", "https://me@alerts.example.com"],
    ["a password", "https://me:pw@alerts.example.com"],
    ["a query", "https://alerts.example.com?a=1"],
    ["a fragment", "https://alerts.example.com#x"],
    ["a trailing slash", "https://alerts.example.com/"],
    ["201 characters", `https://alerts.example.com/${"p".repeat(201 - "https://alerts.example.com/".length)}`],
  ])("answers 400 invalid base_url for %s", async (_name, base_url) => {
    const { db, app, confirm } = setup();
    try {
      const response = await register(app, { base_url });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid base_url" });
      expect(confirm).not.toHaveBeenCalled();
      expect(rows(db)).toBe(0);
    } finally { db.close(); }
  });

  it("accepts a base_url with a path and a base_url of exactly 200 characters", async () => {
    const { db, app, clock } = setup();
    try {
      expect((await register(app, { base_url: "https://alerts.example.com/crit" })).status).toBe(201);
      clock.t += 61;
      const exact = `https://alerts.example.com/${"p".repeat(200 - "https://alerts.example.com/".length)}`;
      expect((await register(app, { base_url: exact })).status).toBe(201);
    } finally { db.close(); }
  });

  it("gives a second registration for the same base_url a new key and retires the first", async () => {
    const { db, app, clock } = setup();
    try {
      const first = (await (await register(app)).json() as { relay_key: string }).relay_key;
      clock.t += 61;
      const second = (await (await register(app)).json() as { relay_key: string }).relay_key;
      expect(second).not.toBe(first);
      expect(rows(db)).toBe(1);
      const push = (key: string) => app.request("/relay/v1/push", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "{}" });
      expect((await push(first)).status).toBe(401);
      expect((await push(second)).status).toBe(400);
    } finally { db.close(); }
  });

  it("keeps a key of a different base_url and an older legacy row", async () => {
    const { db, app, clock } = setup();
    try {
      db.prepare("INSERT INTO relay_servers (id,base_url,version,relay_key_hash,created_at,legacy) VALUES ('old',?,'1','h',1,1)").run(BASE);
      await register(app);
      clock.t += 61;
      await register(app, { base_url: "https://other.example.com" });
      expect(rows(db)).toBe(3);
    } finally { db.close(); }
  });

  it("does not write the key, the challenge or the secret to the log", async () => {
    const { db, app } = setup({ registrationSecret: "operator-secret" });
    try {
      const key = (await (await register(app)).json() as { relay_key: string }).relay_key;
      await register(app, {}, { Authorization: "Bearer operator-secret" });
      const logged = (log.mock.calls as unknown[][]).map((call) => String(call[0])).join("\n");
      expect(logged).toContain("alerts.example.com");
      for (const secret of [key, CHALLENGE, "operator-secret"]) expect(logged).not.toContain(secret);
    } finally { db.close(); }
  });
});

describe("relay registration limits", () => {
  it("answers 429 on the sixth call within 60 seconds and recovers after the window", async () => {
    const { db, app, confirm, clock } = setup();
    try {
      for (let i = 0; i < 5; i += 1) expect((await register(app)).status).toBe(201);
      const limited = await register(app);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ code: 42901, http: 429, error: "rate limited" });
      expect(confirm).toHaveBeenCalledTimes(5);
      clock.t += 61;
      expect((await register(app)).status).toBe(201);
    } finally { db.close(); }
  });

  it("limits each client address on its own", async () => {
    const { db, app } = setup();
    try {
      for (let i = 0; i < 5; i += 1) await register(app);
      expect((await register(app)).status).toBe(429);
      expect((await register(app, {}, { "cf-connecting-ip": "203.0.114.2" })).status).toBe(201);
    } finally { db.close(); }
  });

  it("stops a client at 20 attempts in a UTC day, and a restart does not reset the count", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-cap-")), "relay.db");
    const first = setup({}, openDatabase(file));
    try {
      for (let i = 0; i < 20; i += 1) {
        expect((await register(first.app)).status).toBe(201);
        first.clock.t += 61;
      }
      expect((await register(first.app)).status).toBe(429);
    } finally { first.db.close(); }
    const second = setup({ clock: { now: () => first.clock.t } }, openDatabase(file));
    try {
      const capped = await register(second.app);
      expect(capped.status).toBe(429);
      expect(second.confirm).not.toHaveBeenCalled();
    } finally { second.db.close(); }
    const nextDay = setup({ clock: { now: () => (Math.floor(first.clock.t / 86400) + 1) * 86400 + 5 } }, openDatabase(file));
    try {
      expect((await register(nextDay.app)).status).toBe(201);
    } finally { nextDay.db.close(); }
  });

  it("does not count a call that fails the shape checks", async () => {
    const { db, app, confirm } = setup();
    try {
      for (let i = 0; i < 10; i += 1) await register(app, { base_url: "http://nope.example.com" });
      expect((await register(app)).status).toBe(201);
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});

describe("who counts as one client", () => {
  const from = (ip: string) => ({ "cf-connecting-ip": ip });

  it("counts every address of one IPv6 /64 as one client, and another /64 as another", async () => {
    const { db, app, confirm } = setup();
    try {
      for (let i = 1; i <= 5; i += 1) expect((await register(app, {}, from(`2606:4700:1:2::${i}`))).status).toBe(201);
      const sixth = await register(app, {}, from("2606:4700:1:2:aaaa:bbbb:cccc:dddd"));
      expect(sixth.status).toBe(429);
      expect(confirm).toHaveBeenCalledTimes(5);
      expect((await register(app, {}, from("2606:4700:1:3::1"))).status).toBe(201);
    } finally { db.close(); }
  });

  it("counts an IPv4-mapped IPv6 address as its IPv4 address", async () => {
    const { db, app } = setup();
    try {
      for (const ip of ["203.0.114.7", "::ffff:203.0.114.7", "::ffff:cb00:7207", "203.0.114.7", "::ffff:203.0.114.7"]) expect((await register(app, {}, from(ip))).status).toBe(201);
      expect((await register(app, {}, from("203.0.114.7"))).status).toBe(429);
    } finally { db.close(); }
  });

  it("counts the daily cap on the /64 too", async () => {
    const { db, app, clock } = setup();
    try {
      for (let i = 1; i <= 20; i += 1) { expect((await register(app, {}, from(`2606:4700:9:9::${i}`))).status).toBe(201); clock.t += 61; }
      expect((await register(app, {}, from("2606:4700:9:9:1:2:3:4"))).status).toBe(429);
      expect((await register(app, {}, from("2606:4700:9:a::1"))).status).toBe(201);
    } finally { db.close(); }
  });

  it("keeps the stored client key short whatever the header holds", async () => {
    const { db, app } = setup();
    try {
      expect((await register(app, {}, from("z".repeat(8000)))).status).toBe(201);
      const keys = db.prepare("SELECT client FROM relay_registration_attempts").all() as { client: string }[];
      expect(keys).toHaveLength(1);
      expect(keys[0]!.client.length).toBeLessThanOrEqual(64);
    } finally { db.close(); }
  });
});

describe("the global limit on confirmations", () => {
  it("answers 429 after 60 confirmations started in 60 seconds across all clients, and recovers after the window", async () => {
    const { db, app, confirm, clock } = setup();
    try {
      for (let i = 0; i < 60; i += 1) expect((await register(app, {}, { "cf-connecting-ip": `198.51.${Math.floor(i / 200)}.${(i % 200) + 1}` })).status).toBe(201);
      const over = await register(app, {}, { "cf-connecting-ip": "192.0.9.1" });
      expect(over.status).toBe(429);
      expect(await over.json()).toEqual({ code: 42901, http: 429, error: "rate limited" });
      expect(confirm).toHaveBeenCalledTimes(60);
      clock.t += 61;
      expect((await register(app, {}, { "cf-connecting-ip": "192.0.9.1" })).status).toBe(201);
    } finally { db.close(); }
  });

  it("does not charge a client for a call the global limit turned away", async () => {
    const { db, app, clock } = setup();
    try {
      for (let i = 0; i < 60; i += 1) await register(app, {}, { "cf-connecting-ip": `198.51.100.${i + 1}` });
      for (let i = 0; i < 10; i += 1) expect((await register(app, {}, { "cf-connecting-ip": "192.0.9.1" })).status).toBe(429);
      clock.t += 61;
      expect((await register(app, {}, { "cf-connecting-ip": "192.0.9.1" })).status).toBe(201);
      expect(db.prepare("SELECT count FROM relay_registration_attempts WHERE client = '192.0.9.1'").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });
});

describe("confirmations in flight", () => {
  it("answers 429 above 4 confirmations at once and makes no outbound request for the fifth", async () => {
    const { db, app, confirm } = setup();
    try {
      const release: (() => void)[] = [];
      confirm.mockImplementation(() => new Promise<boolean>((done) => { release.push(() => done(true)); }));
      const ip = (n: number) => ({ "cf-connecting-ip": `203.0.114.${n}` });
      const pending = [1, 2, 3, 4].map((n) => register(app, {}, ip(n)));
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(4));
      const fifth = await register(app, {}, ip(5));
      expect(fifth.status).toBe(429);
      expect(await fifth.json()).toEqual({ code: 42901, http: 429, error: "rate limited" });
      expect(confirm).toHaveBeenCalledTimes(4);
      for (const done of release) done();
      expect((await Promise.all(pending)).map((response) => response.status)).toEqual([201, 201, 201, 201]);
      // A slot is free again once they finish.
      confirm.mockResolvedValue(true);
      expect((await register(app, {}, ip(6))).status).toBe(201);
    } finally { db.close(); }
  });

  it("frees the slot when the confirmer throws", async () => {
    const { db, app, confirm } = setup();
    try {
      confirm.mockRejectedValue(new Error("boom"));
      for (let n = 1; n <= 6; n += 1) await Promise.resolve(register(app, {}, { "cf-connecting-ip": `203.0.114.${n}` })).catch(() => undefined);
      confirm.mockResolvedValue(true);
      expect((await register(app, {}, { "cf-connecting-ip": "203.0.114.9" })).status).toBe(201);
    } finally { db.close(); }
  });
});

describe("the registration switch", () => {
  it("answers 403 registration closed and makes no outbound request", async () => {
    const { db, app, confirm } = setup({ registration: "closed" });
    try {
      const response = await register(app);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "registration closed" });
      expect(confirm).not.toHaveBeenCalled();
      expect(rows(db)).toBe(0);
    } finally { db.close(); }
  });

  it("still serves a caller with the operator's secret", async () => {
    const { db, app, confirm } = setup({ registration: "closed", registrationSecret: "operator-secret" });
    try {
      expect((await register(app, {}, { Authorization: "Bearer operator-secret" })).status).toBe(201);
      expect(confirm).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("is open when the setting is left out", async () => {
    const { db, app } = setup({});
    try { expect((await register(app)).status).toBe(201); } finally { db.close(); }
  });
});

describe("registration with the operator's secret", () => {
  it("skips the challenge, the address rules and the limits, and issues a key tied to its base_url", async () => {
    const { db, app, confirm } = setup({ registrationSecret: "operator-secret" });
    try {
      const headers = { Authorization: "Bearer operator-secret" };
      for (let i = 0; i < 8; i += 1) {
        const response = await register(app, { base_url: "https://10.0.0.5:8443", challenge: undefined }, headers);
        expect(response.status).toBe(201);
      }
      expect(confirm).not.toHaveBeenCalled();
      expect(db.prepare("SELECT base_url, legacy FROM relay_servers").all()).toEqual([{ base_url: "https://10.0.0.5:8443", legacy: 0 }]);
    } finally { db.close(); }
  });

  it("still checks the shape of the body and the length of base_url", async () => {
    const { db, app } = setup({ registrationSecret: "operator-secret" });
    try {
      const headers = { Authorization: "Bearer operator-secret" };
      expect((await register(app, { version: 3 }, headers)).status).toBe(400);
      expect((await register(app, { base_url: undefined }, headers)).status).toBe(400);
      const tooLong = await register(app, { base_url: `https://a.example.com/${"p".repeat(200)}` }, headers);
      expect(tooLong.status).toBe(400);
      expect(await tooLong.json()).toEqual({ error: "invalid base_url" });
    } finally { db.close(); }
  });

  it("answers 401 to a wrong secret and writes nothing", async () => {
    const { db, app, confirm } = setup({ registrationSecret: "operator-secret" });
    try {
      const response = await register(app, {}, { Authorization: "Bearer wrong" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(confirm).not.toHaveBeenCalled();
      expect(rows(db)).toBe(0);
    } finally { db.close(); }
  });

  it("answers 429 to the sixth wrong secret in 60 seconds from one client, even with the right secret after it", async () => {
    const { db, app, clock } = setup({ registrationSecret: "operator-secret" });
    try {
      const guess = (secret: string, ip = "203.0.114.1") => register(app, {}, { Authorization: `Bearer ${secret}`, "cf-connecting-ip": ip });
      for (let i = 0; i < 5; i += 1) expect((await guess(`wrong-${i}`)).status).toBe(401);
      const sixth = await guess("wrong-5");
      expect(sixth.status).toBe(429);
      expect(await sixth.json()).toEqual({ code: 42901, http: 429, error: "rate limited" });
      expect((await guess("operator-secret")).status).toBe(429);
      expect(rows(db)).toBe(0);
      // Another client is not affected, and the first one recovers after the window.
      expect((await guess("operator-secret", "203.0.114.2")).status).toBe(201);
      clock.t += 61;
      expect((await guess("operator-secret")).status).toBe(201);
    } finally { db.close(); }
  });

  it("does not count right secrets against the limit", async () => {
    const { db, app } = setup({ registrationSecret: "operator-secret" });
    try {
      for (let i = 0; i < 12; i += 1) expect((await register(app, {}, { Authorization: "Bearer operator-secret" })).status).toBe(201);
    } finally { db.close(); }
  });

  it("retires an earlier key for the same base_url", async () => {
    const { db, app } = setup({ registrationSecret: "operator-secret" });
    try {
      const headers = { Authorization: "Bearer operator-secret" };
      await register(app, {}, headers);
      await register(app, {}, headers);
      expect(rows(db)).toBe(1);
    } finally { db.close(); }
  });
});
