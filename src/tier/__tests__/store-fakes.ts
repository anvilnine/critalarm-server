import { vi } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { Tier } from "../types.js";

// Fakes for the store API. Nothing in the tests that use them reaches the
// network: every request lands in one of these and the test decides the answer.

export const NOW = 1_700_000_000;

export class FakeClock {
  constructor(public value = NOW) {}
  now(): number { return this.value; }
}

export interface Answer {
  status: number;
  body?: unknown;
}

export function entitlement(id: string, expiresAtMs: number | null = null) {
  return { object: "customer.active_entitlement", entitlement_id: id, expires_at: expiresAtMs };
}

export function listing(...items: ReturnType<typeof entitlement>[]): Answer {
  return { status: 200, body: { items } };
}

function respond(answer: Answer): Response {
  return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
}

// The customer id a request asks about, read back out of the URL.
export function customerOf(url: string): string {
  const match = /\/customers\/([^/]+)\/active_entitlements/.exec(url);
  return match === null ? "" : decodeURIComponent(match[1] ?? "");
}

// Answers at once, from a function of the customer id.
export function scriptedFetch(answer: (appUserId: string, call: number) => Answer | Error) {
  const customers: string[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const appUserId = customerOf(String(input));
    customers.push(appUserId);
    const result = answer(appUserId, customers.length);
    if (result instanceof Error) throw result;
    return respond(result);
  }) as typeof globalThis.fetch;
  return { fetch, customers };
}

export interface PendingRequest {
  appUserId: string;
  answer(answer: Answer): void;
  fail(error: Error): void;
}

// Answers nothing until the test says so. Each request waits in `pending`, in
// the order it was made, so a test can let a later read finish before an
// earlier one.
export function manualFetch() {
  const pending: PendingRequest[] = [];
  const fetch = ((input: Parameters<typeof globalThis.fetch>[0]) => new Promise<Response>((resolve, reject) => {
    pending.push({
      appUserId: customerOf(String(input)),
      answer: (answer) => { resolve(respond(answer)); },
      fail: (error) => { reject(error); },
    });
  })) as typeof globalThis.fetch;
  return { fetch, pending };
}

// Lets every promise that is ready run, including the chain a resolved fetch
// starts. Reads never use a timer in these tests, so this is enough.
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

export type TestDatabase = ReturnType<typeof openDatabase>;

export function database(): TestDatabase {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export function addAccount(db: TestDatabase, id: string, tier: Tier = "free"): void {
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, ?, 1)").run(id, tier);
}

export function linkBillingId(db: TestDatabase, appUserId: string, accountId: string, entitledTier: Tier = "free"): void {
  db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES (?, ?, 1, NULL, ?)").run(appUserId, accountId, entitledTier);
}

export function tierOf(db: TestDatabase, accountId: string): Tier {
  return (db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: Tier }).tier;
}

export function billingRow(db: TestDatabase, appUserId: string) {
  return db.prepare("SELECT account_id, entitled_tier, checked_at, read_seq, applied_seq FROM account_billing_ids WHERE app_user_id = ?").get(appUserId) as { account_id: string; entitled_tier: Tier; checked_at: number | null; read_seq: number; applied_seq: number } | undefined;
}

export function storedPacks(db: TestDatabase) {
  return db.prepare("SELECT app_user_id, pack, expires_at FROM billing_packs ORDER BY app_user_id, pack").all() as { app_user_id: string; pack: string; expires_at: number | null }[];
}

export function queue(db: TestDatabase) {
  return db.prepare("SELECT app_user_id, due_at, attempts, dirty FROM billing_reads ORDER BY app_user_id").all() as { app_user_id: string; due_at: number; attempts: number; dirty: number }[];
}

export function quietLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

export function logged(spy: ReturnType<typeof quietLog>): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const call of spy.mock.calls as unknown[][]) {
    try { lines.push(JSON.parse(String(call[0])) as Record<string, unknown>); } catch { /* not a JSON line */ }
  }
  return lines;
}

// The store configuration every read test uses. The identifiers are made up.
export const api = {
  secretApiKey: "sk-fake-not-a-real-key",
  projectId: "proj_fake",
  entitlements: { ent_relay: "relay", ent_hosted: "hosted" } as Record<string, Tier>,
  packEntitlements: { ent_pack: "pro" } as Record<string, "pro">,
};
