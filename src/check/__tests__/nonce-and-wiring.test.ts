import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../config.js";
import type { ApnsTransport } from "../../push/apns.js";
import { ApnsProviderToken } from "../../push/apns-token.js";
import type { PushSender } from "../../push/types.js";
import { loggedPath } from "../../request-log.js";
import { LOCAL_KEY, type Stats } from "../../stats/counters.js";
import { DAY_S, WEEK_S, roundAfter, slotAtOrAfter, slotFor } from "../schedule.js";
import { checksEnabled, createChecks } from "../startup.js";
import { DAY, HOUR, T0, WEEK, addAccount, addDevice, config, database, enrolled, grantPack, lastCheckId, removePack, setup, FakeClock } from "./fakes.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function captureLogs() {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")); });
  }
  return lines;
}

describe("the check_id never leaves the push", () => {
  it("is in no route response, no log line and no error body, through a whole round and every way it can end", async () => {
    const lines = captureLogs();
    const harness = await enrolled();
    addDevice(harness.db, "dev_b", "acc_1", "android");
    await harness.api.enable("dev_b");
    const bodies: string[] = [];
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const response = await harness.api.call(method, path, token, body);
      bodies.push(await response.text());
      return response;
    };
    const everyRead = async () => {
      for (const id of ["dev_a", "dev_b"]) {
        await call("GET", `/relay/v1/devices/${id}/check`, `dv_${id.slice(4)}`);
        await call("GET", `/relay/v1/devices/${id}/checks?limit=200`, `dv_${id.slice(4)}`);
      }
      await call("GET", "/relay/v1/packs", "dv_a");
      await call("GET", "/relay/v1/internal/stats?by=key", "stats-key");
    };

    const ids = new Set<string>();
    const collect = () => { for (const sent of harness.sender.sent) ids.add(sent.push.checkId); };

    // A round that is answered, one that fails, is refused, throws, and is missed.
    await harness.scanAt(T0);
    collect();
    await everyRead();
    const [first] = [...ids];
    await call("POST", `/relay/v1/devices/dev_a/checks/${first}/receipt`, "dv_a", { attempt: 1, received_at: T0 });
    await call("POST", `/relay/v1/devices/dev_a/checks/${first}/receipt`, "dv_a", "not json");
    // Wrong device, wrong token, no token, and a check_id nobody holds.
    await call("POST", `/relay/v1/devices/dev_b/checks/${first}/receipt`, "dv_b");
    await call("POST", `/relay/v1/devices/dev_a/checks/${first}/receipt`, "dv_b");
    await call("POST", `/relay/v1/devices/dev_a/checks/${first}/receipt`);
    await call("POST", `/relay/v1/devices/dev_a/checks/${first}/receipt`, "dv_nobody");
    await call("POST", `/relay/v1/devices/dev_a/checks/${first}x/receipt`, "dv_a");
    await call("GET", `/relay/v1/devices/dev_a/checks/${first}/receipt`, "dv_a");
    await call("PUT", "/relay/v1/devices/dev_a/check", "dv_a", "not json");

    harness.sender.reply = () => ({ outcome: "failed", status: 503 });
    await harness.scanAt(T0 + 6 * HOUR);
    harness.sender.reply = () => { throw new Error(`boom ${[...ids].join(" ")}`); };
    await harness.scanAt(T0 + 18 * HOUR);
    await harness.scanAt(T0 + DAY);
    collect();
    await everyRead();
    // A late receipt.
    for (const id of ids) await call("POST", `/relay/v1/devices/dev_b/checks/${id}/receipt`, "dv_b");

    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(roundAfter("dev_a", T0) + WEEK);
    await harness.scanAt(roundAfter("dev_b", T0) + WEEK);
    collect();
    removePack(harness.db, "acc_1");
    await harness.scanAt(T0 + 5 * WEEK);
    await call("PUT", "/relay/v1/devices/dev_a/check", "dv_a", { enabled: true });
    grantPack(harness.db, "acc_1");
    await call("PUT", "/relay/v1/devices/dev_a/check", "dv_a", { enabled: false });
    await call("DELETE", "/relay/v1/devices/dev_b", "dv_b");
    await everyRead();

    expect(ids.size).toBeGreaterThanOrEqual(4);
    expect(bodies.length).toBeGreaterThan(30);
    const everything = `${bodies.join("\n")}\n${lines.join("\n")}`;
    for (const id of ids) {
      expect(id).toMatch(/^chk_[0-9a-f]{32}$/);
      expect(everything).not.toContain(id);
      expect(everything).not.toContain(id.slice(4));
    }
    expect(bodies.join("\n")).not.toContain("chk_");
    expect(lines.join("\n")).not.toContain("chk_");
    // The scan did log something, so the search above had lines to look in.
    expect(lines.some((line) => line.includes("check_not_accepted"))).toBe(true);
  });

  it("is stored as a hash: no column of any table holds it", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.scanAt(T0 + 6 * HOUR);
    const checkId = lastCheckId(harness.sender);
    const tables = (harness.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    const dump = JSON.stringify(tables.map((table) => harness.db.prepare(`SELECT * FROM "${table}"`).all()));
    expect(dump).not.toContain(checkId);
    expect(dump).not.toContain(checkId.slice(4));
    expect(harness.db.prepare("SELECT nonce_hash FROM check_rounds").get()).toEqual({ nonce_hash: createHash("sha256").update(checkId).digest("hex") });
  });

  it("differs for every round, and cannot be worked out from what a route returns", async () => {
    const harness = await enrolled();
    const seen = new Set<string>();
    let due = T0;
    for (let round = 0; round < 5; round += 1) {
      await harness.scanAt(due);
      seen.add(lastCheckId(harness.sender));
      await harness.api.receipt("dev_a", lastCheckId(harness.sender));
      due = (await harness.api.check("dev_a")).next_due_at ?? 0;
    }
    expect(seen.size).toBe(5);
    for (const round of await harness.api.rounds("dev_a")) {
      for (const guess of [round.id, round.id.replace("rnd_", "chk_"), `chk_${createHash("sha256").update(round.id).digest("hex").slice(0, 32)}`]) {
        expect(seen.has(guess)).toBe(false);
      }
    }
  });

  it("the request log shows a placeholder where the receipt path carries it", () => {
    expect(loggedPath("/relay/v1/devices/dev_a/checks/chk_0123456789abcdef0123456789abcdef/receipt")).toBe("/relay/v1/devices/dev_a/checks/-/receipt");
    expect(loggedPath("/relay/v1/devices/dev_a/checks")).toBe("/relay/v1/devices/dev_a/checks");
    expect(loggedPath("/relay/v1/devices/dev_a/check")).toBe("/relay/v1/devices/dev_a/check");
    expect(loggedPath("/v1/incidents/inc_1/ack")).toBe("/v1/incidents/inc_1/ack");
  });
});

describe("checks_sent and checks_received", () => {
  const stats = async (harness: Awaited<ReturnType<typeof enrolled>>, query = "") =>
    (await (await harness.api.call("GET", `/relay/v1/internal/stats${query}`, "stats-key")).json()) as Stats;

  it("checks_sent counts each check push a provider accepted, under local, and not in pushes_delivered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.sender.reply = () => ({ outcome: "failed", status: 500 });
    await harness.scanAt(T0 + 6 * HOUR);
    harness.sender.reply = () => ({ outcome: "accepted", status: 200 });
    await harness.scanAt(T0 + 18 * HOUR);
    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(roundAfter("dev_a", T0));

    const body = await stats(harness);
    expect(body.totals).toEqual({ pushes_delivered: 0, alarms_rung: 0, acks: 0, incidents_opened: 0, checks_sent: 2, checks_received: 0 });
    expect(harness.db.prepare("SELECT relay_key, metric, SUM(count) AS count FROM counters GROUP BY relay_key, metric").all()).toEqual([{ relay_key: LOCAL_KEY, metric: "checks_sent", count: 2 }]);
  });

  it("checks_received counts a round answered while it was open, once, and not a late receipt", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    const answered = lastCheckId(harness.sender);
    await harness.api.receipt("dev_a", answered);
    await harness.api.receipt("dev_a", answered);
    const next = roundAfter("dev_a", T0);
    for (const offset of [0, 6 * HOUR, 18 * HOUR, DAY]) await harness.scanAt(next + offset);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));

    const body = await stats(harness);
    expect(body.totals).toMatchObject({ checks_sent: 4, checks_received: 1, pushes_delivered: 0 });
    expect(body.days[0]).toMatchObject({ checks_sent: 3, checks_received: 0 });
    expect(body.days.reduce((sum, day) => sum + day.checks_received, 0)).toBe(1);
  });

  it("the per-key rows of ?by=key keep their four fields", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    harness.counters.add("key_a", "alarms_rung", 2);
    const body = await stats(harness, "?by=key");
    expect(body.totals).toMatchObject({ checks_sent: 1, checks_received: 1, alarms_rung: 2 });
    expect(body.keys).toEqual([{ relay_key: "key_a", zeroed: false, totals: { pushes_delivered: 0, alarms_rung: 2, acks: 0, incidents_opened: 0 }, days: [{ day: "2025-10-09", pushes_delivered: 0, alarms_rung: 2, acks: 0, incidents_opened: 0 }] }]);
  });
});

describe("the slot", () => {
  it("is the first 8 hex digits of sha256(device_id), mod the seconds in a week", () => {
    for (const id of ["dev_a", "dev_123e4567-e89b-12d3-a456-426614174000"]) {
      const expected = Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % 604_800;
      expect(slotFor(id)).toBe(expected);
      expect(slotFor(id)).toBe(slotFor(id));
    }
  });

  it("is counted from Monday 00:00 UTC", () => {
    const monday = Date.UTC(2026, 9, 5) / 1000;
    expect(new Date(monday * 1000).getUTCDay()).toBe(1);
    expect(slotAtOrAfter(0, monday)).toBe(monday);
    expect(slotAtOrAfter(0, monday + 1)).toBe(monday + WEEK_S);
    expect(slotAtOrAfter(3 * DAY_S + 5, monday)).toBe(monday + 3 * DAY_S + 5);
    expect(slotAtOrAfter(3 * DAY_S + 5, monday + 3 * DAY_S + 6)).toBe(monday + WEEK_S + 3 * DAY_S + 5);
    expect(slotAtOrAfter(WEEK_S - 1, monday - 1)).toBe(monday - 1);
  });

  it("puts the round after one that opened on the slot exactly a week later, and any other between 3 and 10 days later", () => {
    const slot = slotFor("dev_a");
    const onSlot = slotAtOrAfter(slot, T0);
    expect(roundAfter("dev_a", onSlot)).toBe(onSlot + WEEK_S);
    for (let offset = 1; offset < WEEK_S; offset += 7_919) {
      const gap = roundAfter("dev_a", onSlot + offset) - (onSlot + offset);
      expect(gap).toBeGreaterThanOrEqual(3 * DAY_S);
      expect(gap).toBeLessThan(10 * DAY_S);
      expect((roundAfter("dev_a", onSlot + offset) - onSlot) % WEEK_S).toBe(0);
    }
  });
});

describe("where the scan runs, and the setting that switches it off", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const withApns: Config = { ...config, apns: { teamId: "team_1", keyId: "key_1", privateKey: pem, bundleId: "app.critalarm", environment: "production" } };
  const inner: PushSender = { send: async () => ({ status: 200, stale: false }) };

  it("runs on a relay and on a hosted server, and not on a self-hosted one or with no mode", () => {
    expect(checksEnabled({ ...config, mode: "relay" })).toBe(true);
    expect(checksEnabled({ ...config, mode: "hosted" })).toBe(true);
    expect(checksEnabled({ ...config, mode: "selfhosted" })).toBe(false);
    const { mode: _mode, ...noMode } = config;
    expect(checksEnabled(noMode)).toBe(false);
  });

  it("WEEKLY_CHECKS=off switches it off, and unset is on", () => {
    const env = { BASE_URL: "https://alerts.example.com", ALLOW_NOOP_PUSH: "true", MODE: "relay" };
    const read = () => "";
    expect(loadConfig(env, read).weeklyChecks).toBe(true);
    expect(loadConfig({ ...env, WEEKLY_CHECKS: "" }, read).weeklyChecks).toBe(true);
    expect(loadConfig({ ...env, WEEKLY_CHECKS: "on" }, read).weeklyChecks).toBe(true);
    expect(loadConfig({ ...env, WEEKLY_CHECKS: "off" }, read).weeklyChecks).toBe(false);
    expect(() => loadConfig({ ...env, WEEKLY_CHECKS: "false" }, read)).toThrow("invalid configuration: WEEKLY_CHECKS");
    expect(checksEnabled(loadConfig({ ...env, WEEKLY_CHECKS: "off" }, read))).toBe(false);
    expect(checksEnabled(loadConfig(env, read))).toBe(true);
  });

  it("switched off or self-hosted: no timer, no scheduler, and the alarm sender is handed back as it was", () => {
    vi.useFakeTimers();
    for (const off of [{ ...withApns, weeklyChecks: false }, { ...withApns, mode: "selfhosted" as const }]) {
      const db = database();
      const dialled: string[] = [];
      const checks = createChecks(off, { db, clock: new FakeClock(), fetch: async () => new Response(null), apnsTransport: (authority) => { dialled.push(authority); return { send: async () => ({ status: 200, headers: {}, body: "" }), close: () => {} }; } });
      expect(checks.enabled).toBe(false);
      expect(checks.scheduler).toBeUndefined();
      expect(checks.noting(inner)).toBe(inner);
      const stop = checks.start();
      expect(vi.getTimerCount()).toBe(0);
      stop();
      expect(dialled).toEqual([]);
    }
  });

  it("switched on: scans once a minute, sends nothing and dials nobody until a device enrols, then sends the check", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = database();
    const clock = new FakeClock();
    const sent: { authority: string; headers: Record<string, string>; body: string }[] = [];
    const dialled: string[] = [];
    let closed = 0;
    const transport = (authority: string): ApnsTransport => {
      dialled.push(authority);
      return { send: async (_path, headers, body) => { sent.push({ authority, headers, body }); return { status: 200, headers: {}, body: "" }; }, close: () => { closed += 1; } };
    };
    const checks = createChecks(withApns, { db, clock, fetch: async () => new Response(null), apnsTransport: transport });
    expect(checks.enabled).toBe(true);
    expect(checks.noting(inner)).not.toBe(inner);
    addAccount(db, "acc_1");
    addDevice(db, "dev_a", "acc_1");

    const stop = checks.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);
    expect(dialled).toEqual([]);

    db.prepare("INSERT INTO device_checks (device_id, enabled, enrolled_at, next_attempt_at, next_due_at) VALUES ('dev_a', 1, ?, ?, ?)").run(T0, T0, T0);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["apns-push-type"]).toBe("background");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ kind: "check", attempt: 1 });

    stop();
    expect(closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the check with the provider token it is handed, and signs none of its own", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = database();
    const clock = new FakeClock();
    const token = new ApnsProviderToken({ teamId: "team_1", keyId: "key_1", privateKey });
    const held = token.get(clock.now());
    const seen: string[] = [];
    const checks = createChecks(withApns, { db, clock, fetch: async () => new Response(null), apnsToken: token, apnsTransport: () => ({ send: async (_path, headers) => { seen.push(headers.authorization ?? ""); return { status: 200, headers: {}, body: "" }; }, close: () => {} }) });
    addAccount(db, "acc_1");
    addDevice(db, "dev_a", "acc_1");
    db.prepare("INSERT INTO device_checks (device_id, enabled, enrolled_at, next_attempt_at, next_due_at) VALUES ('dev_a', 1, ?, ?, ?)").run(T0, T0, T0);
    expect(await checks.scheduler?.scan()).toBe(1);
    expect(seen).toEqual([`bearer ${held}`]);
    expect(token.minted).toBe(1);
  });

  it("with no provider configured for a platform, the attempt is used and nothing is sent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = database();
    const clock = new FakeClock();
    const checks = createChecks(config, { db, clock, fetch: async () => { throw new Error("no request may be made"); } });
    addAccount(db, "acc_1");
    addDevice(db, "dev_a", "acc_1", "android");
    db.prepare("INSERT INTO device_checks (device_id, enabled, enrolled_at, next_attempt_at, next_due_at) VALUES ('dev_a', 1, ?, ?, ?)").run(T0, T0, T0);
    expect(await checks.scheduler?.scan()).toBe(1);
    expect(db.prepare("SELECT attempt, outcome, status FROM check_attempts").all()).toEqual([{ attempt: 1, outcome: "failed", status: 501 }]);
  });
});

describe("a device that never enrolled", () => {
  it("is sent nothing however long the scan runs, even on an account that holds the pack", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addAccount(harness.db, "acc_2", { pack: false });
    addDevice(harness.db, "dev_a", "acc_1");
    addDevice(harness.db, "dev_b", "acc_2");
    for (let time = T0; time < T0 + 8 * WEEK; time += 6 * HOUR) await harness.scanAt(time);
    expect(harness.sender.sent).toEqual([]);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_rounds").get()).toEqual({ n: 0 });
  });
});
