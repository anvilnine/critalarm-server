import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { Config } from "../../config.js";
import { createApp } from "../../index.js";
import type { CheckAnswer, CheckPush, CheckSender, CheckTarget } from "../../push/check.js";
import { Counters } from "../../stats/counters.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { AlarmNotes, alarmNoteWriter } from "../device-hooks.js";
import { CheckScheduler } from "../scheduler.js";
import { CheckStore, type CheckView, type RoundView } from "../store.js";

// Fakes for the weekly check tests. No test that uses them reaches a network:
// every check push lands in FakeCheckSender and the test decides the answer.

export const T0 = 1_760_000_000;
export const HOUR = 3_600;
export const DAY = 86_400;
export const WEEK = 7 * DAY;

export type TestDatabase = Database.Database;

export class FakeClock {
  constructor(public value = T0) {}
  now(): number { return this.value; }
}

export interface SentCheck {
  target: CheckTarget;
  push: CheckPush;
}

export class FakeCheckSender implements CheckSender {
  readonly sent: SentCheck[] = [];
  reply: (sent: SentCheck) => CheckAnswer | Promise<CheckAnswer> = () => ({ outcome: "accepted", status: 200 });
  // Runs where a real sender would be fetching a provider token.
  before: () => void | Promise<void> = () => {};

  async sendCheck(target: CheckTarget, push: CheckPush, stillWanted: () => boolean = () => true): Promise<CheckAnswer> {
    await this.before();
    if (!stillWanted()) return { outcome: "cancelled", status: 0 };
    const sent = { target, push };
    this.sent.push(sent);
    return this.reply(sent);
  }
}

export function database(): TestDatabase {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export function addAccount(db: TestDatabase, id: string, options: { pack?: boolean; tier?: "free" | "relay" | "hosted" } = {}): void {
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, ?, 1)").run(id, options.tier ?? "free");
  if (options.pack !== false) grantPack(db, id);
}

// The pack reaches the account as an operator grant here. Which source it
// comes from makes no difference to the check.
export function grantPack(db: TestDatabase, accountId: string, expiresAt: number | null = null): void {
  db.prepare("INSERT OR REPLACE INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES (?, 'pro', ?, 'test', 1)").run(accountId, expiresAt);
}

export function removePack(db: TestDatabase, accountId: string): void {
  db.prepare("DELETE FROM account_pack_grants WHERE account_id = ?").run(accountId);
}

// The device's dv_ token is `dv_` plus the part of its id after `dev_`.
export function addDevice(db: TestDatabase, id: string, accountId: string, platform: "ios" | "android" = "ios", pushToken = `push-${id}`): string {
  const token = `dv_${id.slice(4)}`;
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, app_version, last_seen) VALUES (?, ?, ?, ?, ?, '1.0.0', 1)")
    .run(id, accountId, createHash("sha256").update(token).digest("hex"), platform, pushToken);
  return token;
}

export const config: Config = { mode: "relay", baseUrl: "https://alerts.example.com", relayUrl: "https://relay.example.com", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false, statsKey: "stats-key" };

export interface SetupOptions { batch?: number; config?: Partial<Config> }

export interface Harness {
  db: TestDatabase;
  clock: FakeClock;
  sender: FakeCheckSender;
  counters: Counters;
  store: CheckStore;
  scheduler: CheckScheduler;
  notes: AlarmNotes;
  app: Hono;
  api: {
    call(method: string, path: string, token?: string, body?: unknown): Response | Promise<Response>;
    enable(deviceId: string): Response | Promise<Response>;
    disable(deviceId: string): Response | Promise<Response>;
    check(deviceId: string): Promise<CheckView>;
    rounds(deviceId: string, query?: string): Promise<RoundView[]>;
    receipt(deviceId: string, checkId: string, body?: unknown): Response | Promise<Response>;
  };
  scanAt(time: number): Promise<number>;
  restart(): { sender: FakeCheckSender; scheduler: CheckScheduler };
}

export function setup(options: SetupOptions = {}): Harness {
  const db = database();
  const clock = new FakeClock();
  const sender = new FakeCheckSender();
  const counters = new Counters(db, clock);
  const store = new CheckStore(db, clock, counters, options.config?.packIncludes ?? {});
  const notes = new AlarmNotes(alarmNoteWriter(db));
  const scheduler = new CheckScheduler(store, { ios: sender, android: sender }, { notes, ...(options.batch === undefined ? {} : { batch: options.batch }) });
  const app = createApp({ config: { ...config, ...options.config }, db, clock, ids: { message: () => "m_1", incident: () => "inc_1", timer: () => "tm_1" }, dispatch: async () => {} });

  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const tokenOf = (deviceId: string) => `dv_${deviceId.slice(4)}`;
  const api = {
    call,
    enable: (deviceId: string) => call("PUT", `/relay/v1/devices/${deviceId}/check`, tokenOf(deviceId), { enabled: true }),
    disable: (deviceId: string) => call("PUT", `/relay/v1/devices/${deviceId}/check`, tokenOf(deviceId), { enabled: false }),
    check: async (deviceId: string) => (await (await call("GET", `/relay/v1/devices/${deviceId}/check`, tokenOf(deviceId))).json()) as CheckView,
    rounds: async (deviceId: string, query = "") => (await (await call("GET", `/relay/v1/devices/${deviceId}/checks${query}`, tokenOf(deviceId))).json()) as RoundView[],
    receipt: (deviceId: string, checkId: string, body?: unknown) => call("POST", `/relay/v1/devices/${deviceId}/checks/${checkId}/receipt`, tokenOf(deviceId), body),
  };
  // Moves the clock and runs one scan.
  const scanAt = async (time: number) => {
    clock.value = time;
    return scheduler.scan();
  };
  // A new scheduler and a new store over the same database: what a restart
  // leaves behind.
  const restart = () => {
    const next = new FakeCheckSender();
    return { sender: next, scheduler: new CheckScheduler(new CheckStore(db, clock, new Counters(db, clock)), { ios: next, android: next }, options.batch === undefined ? {} : { batch: options.batch }) };
  };
  return { db, clock, sender, counters, store, scheduler, notes, app, api, scanAt, restart };
}

// One enrolled device on an account that holds the pack.
export async function enrolled(options: SetupOptions = {}): Promise<Harness> {
  const harness = setup(options);
  addAccount(harness.db, "acc_1");
  addDevice(harness.db, "dev_a", "acc_1");
  await harness.api.enable("dev_a");
  return harness;
}

export function lastCheckId(sender: FakeCheckSender): string {
  const last = sender.sent.at(-1);
  if (last === undefined) throw new Error("no check was sent");
  return last.push.checkId;
}
