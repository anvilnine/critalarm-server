import type Database from "better-sqlite3";
import type { Hono, MiddlewareHandler } from "hono";
import { readBytes } from "../body-limit.js";
import type { Clock } from "../incident/types.js";
import { tierRequired } from "../tier/caps.js";
import type { V1Env } from "./auth.js";

// api.md §3.9. The answer to "What made you cancel?", one per account in any
// rolling 30 days. The route creates no alert, sends no push and schedules
// nothing.

export const CANCEL_REASONS = ["price", "unused", "selfhost", "missing", "broken", "other"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

const DAY_S = 86_400;
const HOUR_S = 3_600;
export const MAX_TEXT_CHARACTERS = 500;
// Raw request bytes. 500 emoji written as \u escapes are 6000 bytes of text,
// and the other fields take under 200.
export const MAX_BODY_BYTES = 8192;
export const ANSWER_WINDOW_S = 30 * DAY_S;
export const REQUESTS_PER_HOUR = 30;

export type AnswerInput = {
  reason: CancelReason;
  text: string | null;
  appVersion: string;
  platform: "ios" | "android";
};

export type ParseResult =
  | { ok: true; input: AnswerInput }
  | { ok: false; error: "invalid request" | "invalid reason" | "text too long" };

const invalid: ParseResult = { ok: false, error: "invalid request" };

function isReason(value: string): value is CancelReason {
  return (CANCEL_REASONS as readonly string[]).includes(value);
}

// Steps 6 to 8 of the order in api.md §3.9: the shape, then the reason, then
// the length of the text. Fields the route does not know are ignored.
export function parseAnswer(body: unknown): ParseResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid;
  const { reason, text, app_version: appVersion, platform } = body as Record<string, unknown>;
  if (typeof reason !== "string") return invalid;
  if (text !== undefined && text !== null && typeof text !== "string") return invalid;
  if (typeof appVersion !== "string" || !/^[A-Za-z0-9.+_-]{1,32}$/.test(appVersion)) return invalid;
  if (platform !== "ios" && platform !== "android") return invalid;
  if (!isReason(reason)) return { ok: false, error: "invalid reason" };
  let cleaned: string | null = null;
  if (typeof text === "string") {
    const trimmed = text.trim();
    // Code points, not UTF-16 units, so an emoji counts as one character.
    if ([...trimmed].length > MAX_TEXT_CHARACTERS) return { ok: false, error: "text too long" };
    cleaned = trimmed === "" ? null : trimmed;
  }
  return { ok: true, input: { reason, text: cleaned, appVersion, platform } };
}

// Registration is open and makes a free account for anyone, so the route takes
// an answer only from an account that holds Hosted now or was ever moved to it
// (a trial or a manual grant included; this is not a test of payment). "Ever
// moved" is a tier_changes row to hosted, on the account or on a tombstone
// merged into it: every code path that writes accounts.tier writes one. A tier
// set by hand outside those paths leaves no row, and a tier move from before
// the table existed has none. An account on hosted now passes by its tier.
export function holdsOrHeldHosted(db: Database.Database, accountId: string): boolean {
  const account = db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: string } | undefined;
  if (account?.tier === "hosted") return true;
  const held = db
    .prepare(
      `WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT a.id FROM accounts a JOIN family f ON a.merged_into = f.id)
       SELECT 1 FROM tier_changes WHERE to_tier = 'hosted' AND account_id IN (SELECT id FROM family) LIMIT 1`,
    )
    .get(accountId);
  return held !== undefined;
}

// The current answer of an account is the newest one first stored within the
// last 30 days. A call while there is one is a repeat of it: reason, version and
// platform never change, an empty text is filled once, and a text that is set is
// never replaced. A call with no current answer creates one. The window runs
// from created_at, so a repeat does not extend it.
//
// The read and the write share one IMMEDIATE transaction, so a second
// connection waits for the first and then sees its row. Should two first calls
// still land in the same second, the insert yields to the row already there
// and the call is a repeat of it, never a constraint error.
export function storeAnswer(db: Database.Database, clock: Clock, accountId: string, input: AnswerInput): "stored" | "kept" {
  return db.transaction((): "stored" | "kept" => {
    const now = clock.now();
    const fillText = (createdAt: number): void => {
      if (input.text === null) return;
      db.prepare("UPDATE cancel_answers SET text = ?, updated_at = ? WHERE account_id = ? AND created_at = ? AND text IS NULL")
        .run(input.text, now, accountId, createdAt);
    };
    const current = db
      .prepare("SELECT created_at AS createdAt FROM cancel_answers WHERE account_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
      .get(accountId, now - ANSWER_WINDOW_S) as { createdAt: number } | undefined;
    if (current !== undefined) {
      fillText(current.createdAt);
      return "kept";
    }
    const inserted = db
      .prepare("INSERT INTO cancel_answers (account_id, created_at, reason, text, app_version, platform, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, created_at) DO NOTHING")
      .run(accountId, now, input.reason, input.text, input.appVersion, input.platform, now);
    if (inserted.changes === 0) {
      fillText(now);
      return "kept";
    }
    return "stored";
  }).immediate();
}

// A rolling hour per account, kept in memory by this process: best effort, and
// a restart clears it. Every call that reaches it counts, whatever its outcome
// after; a call it refuses does not.
function requestWindow(): (accountId: string, nowS: number) => boolean {
  const calls = new Map<string, number[]>();
  return (accountId, nowS) => {
    if (calls.size > 1000) {
      for (const [key, times] of calls) if (times.every((at) => at <= nowS - HOUR_S)) calls.delete(key);
    }
    const recent = (calls.get(accountId) ?? []).filter((at) => at > nowS - HOUR_S);
    if (recent.length >= REQUESTS_PER_HOUR) {
      calls.set(accountId, recent);
      return false;
    }
    recent.push(nowS);
    calls.set(accountId, recent);
    return true;
  };
}

type Deps = { db: Database.Database; clock: Clock; mode: "selfhosted" | "relay" | "hosted" };

export function mountCancelAnswerRoute(r: Hono<V1Env>, auth: MiddlewareHandler<V1Env>, deps: Deps): void {
  const path = "/v1/account/cancel-reason";
  // Step 1. Only a hosted server sells the Hosted plan. The other modes mount
  // the route to refuse it, ahead of the credential check. That departs from
  // the rule at the top of api.md §3 on purpose, and in relay mode it departs
  // from §3.7, which is not refused there.
  if (deps.mode !== "hosted") {
    r.post(path, (c) => c.json({ error: `not supported in ${deps.mode} mode` }, 501));
    return;
  }
  // Step 2, the credential.
  r.use(path, auth);
  const allow = requestWindow();
  r.post(path, async (c) => {
    const accountId = c.get("account").accountId;
    // Step 3, the request limit.
    if (!allow(accountId, deps.clock.now())) return c.json({ error: "rate limited" }, 429);
    // Step 4, on hosted now or ever.
    if (!holdsOrHeldHosted(deps.db, accountId)) return tierRequired("hosted");
    // Step 5, the raw size. A declared Content-Length over the limit is refused
    // unread; any other body is read only until it passes the limit.
    const bytes = await readBytes(c.req.raw, MAX_BODY_BYTES);
    if (bytes === "too large") return c.json({ error: "request too large" }, 413);
    let body: unknown;
    try { body = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; } catch { return c.json({ error: "invalid request" }, 400); }
    // Steps 6 to 8.
    const parsed = parseAnswer(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    // Step 9.
    storeAnswer(deps.db, deps.clock, accountId, parsed.input);
    return c.body(null, 204);
  });
}
