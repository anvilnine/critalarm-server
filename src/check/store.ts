import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import type { ApnsEnvironment } from "../push/types.js";
import { Counters, LOCAL_KEY } from "../stats/counters.js";
import { holdsPack, type PackId, type PackIncludes } from "../tier/packs.js";
import { ALARM_HOLD_S, ATTEMPT_OFFSETS_S, MAX_ATTEMPTS, MIN_ROUND_GAP_S, ROUND_LENGTH_S, roundAfter, slotAtOrAfter, slotFor } from "./schedule.js";

// api.md §4.5. Everything the weekly check keeps, and every change to it. The
// routes and the scan both go through this file, so the rules about when a
// round closes are written once.
//
// Nothing here is read by the alarm path, and nothing here sends a push.

// The pack a device's account must hold to be sent checks.
export const CHECK_PACK: PackId = "pro";

export type RoundResult = "received" | "missed" | "refused" | "skipped";
export type SkipReason = "pack" | "no_token" | "disabled";
export type CheckState = "waiting" | "received" | "missed_once" | "missed_repeatedly" | "token_refused" | "no_token" | "off";
export type AttemptOutcome = "accepted" | "refused" | "failed";

export interface CheckView {
  enabled: boolean;
  state: CheckState;
  reason: null | "pack" | "disabled";
  misses: number;
  last_sent_at: number | null;
  last_received_at: number | null;
  next_due_at: number | null;
  notice_after: number | null;
}

export interface RoundView {
  id: string;
  opened_at: number;
  closes_at: number;
  closed_at: number | null;
  attempts: number;
  result: RoundResult | null;
  attempt_received: number | null;
  receipt_at: number | null;
  device_received_at: number | null;
  late_receipt_at: number | null;
  reason: SkipReason | null;
}

export interface ReceiptAnswer {
  counted: boolean;
  next_due_at: number | null;
  notice_after: number | null;
}

// One push the scan has put on record and now has to send.
export interface PlannedCheck {
  roundId: string;
  attempt: number;
  checkId: string;
  platform: "ios" | "android";
  pushToken: string;
  apnsEnvironment?: ApnsEnvironment;
}

type StateRow = {
  device_id: string;
  enabled: number;
  next_attempt_at: number | null;
  next_due_at: number;
  round_id: string | null;
  misses: number;
  last_result: "received" | "missed" | "refused" | null;
  second_miss_at: number | null;
  last_sent_at: number | null;
  last_received_at: number | null;
};

type RoundRow = RoundView & { device_id: string };

type DeviceRow = {
  account_id: string;
  platform: "ios" | "android";
  apns_environment: ApnsEnvironment | null;
  last_alarm_push_at: number | null;
  push_token: string;
};

const ROUND_COLUMNS = "id, device_id, opened_at, closes_at, closed_at, attempts, result, attempt_received, receipt_at, device_received_at, late_receipt_at, reason";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class CheckStore {
  private secret: string | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly counters: Counters = new Counters(db, clock),
    private readonly packIncludes: PackIncludes = {},
  ) {}

  // PUT with "enabled":true. The caller has already checked the pack. A device
  // that enrols for the first time is due at once. One that switches back on
  // keeps the schedule it had, so switching off and on again cannot be used to
  // ask for a push.
  enable(deviceId: string): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      const state = this.state(deviceId);
      if (state === undefined) {
        this.db.prepare("INSERT INTO device_checks (device_id, enabled, enrolled_at, next_attempt_at, next_due_at) VALUES (?, 1, ?, ?, ?)").run(deviceId, now, now, now);
        return;
      }
      if (state.enabled === 1) return;
      this.db.prepare("UPDATE device_checks SET enabled = 1, next_attempt_at = next_due_at WHERE device_id = ?").run(deviceId);
    })();
  }

  // PUT with "enabled":false. A round that is open ends as skipped, which is
  // not a miss. A device that never enrolled gets no row.
  disable(deviceId: string): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      const state = this.state(deviceId);
      if (state === undefined || state.enabled === 0) return;
      this.db.prepare("UPDATE device_checks SET enabled = 0, next_attempt_at = NULL WHERE device_id = ?").run(deviceId);
      const round = this.openRound(state);
      if (round === undefined) return;
      if (now >= round.closes_at) this.close(round, "missed", null, round.closes_at);
      else this.close(round, "skipped", "disabled", now);
    })();
  }

  // GET .../check. What happened to the last rounds, and nothing about the
  // phone.
  view(deviceId: string, accountId: string): CheckView {
    return this.db.transaction(() => {
      this.settle(deviceId);
      return this.viewOf(deviceId, accountId);
    })();
  }

  // GET .../checks, newest first. Never the check_id: a round is named by its
  // own id here.
  rounds(deviceId: string, limit: number): RoundView[] {
    return this.db.transaction(() => {
      this.settle(deviceId);
      const rows = this.db.prepare(`SELECT ${ROUND_COLUMNS} FROM check_rounds WHERE device_id = ? ORDER BY opened_at DESC, rowid DESC LIMIT ?`).all(deviceId, limit) as RoundRow[];
      return rows.map(({ device_id: _device, ...round }) => round);
    })();
  }

  // POST .../checks/{check_id}/receipt. Null when this device has no round
  // with that check_id. A receipt counts when its round is open by this
  // server's clock. The two notes in the body are stored and decide nothing.
  receipt(deviceId: string, accountId: string, checkId: string, notes: { attempt?: unknown; received_at?: unknown }): ReceiptAnswer | null {
    if (!/^chk_[0-9a-f]{32}$/.test(checkId)) return null;
    const now = this.clock.now();
    return this.db.transaction(() => {
      let round = this.db.prepare(`SELECT ${ROUND_COLUMNS} FROM check_rounds WHERE device_id = ? AND nonce_hash = ?`).get(deviceId, sha256(checkId)) as RoundRow | undefined;
      if (round === undefined) return null;
      if (round.result === null && now >= round.closes_at) {
        this.close(round, "missed", null, round.closes_at);
        round = this.round(round.id) ?? round;
      }
      let counted: boolean;
      if (round.result === null) {
        this.close(round, "received", null, now);
        const attempt = typeof notes.attempt === "number" && Number.isInteger(notes.attempt) && notes.attempt >= 1 && notes.attempt <= round.attempts ? notes.attempt : null;
        const deviceTime = typeof notes.received_at === "number" && Number.isSafeInteger(notes.received_at) ? notes.received_at : null;
        this.db.prepare("UPDATE check_rounds SET receipt_at = ?, device_received_at = ?, attempt_received = ? WHERE id = ?").run(now, deviceTime, attempt, round.id);
        this.counters.add(LOCAL_KEY, "checks_received");
        counted = true;
      } else if (round.result === "received") {
        // The same receipt again. Same answer, and nothing is written.
        counted = true;
      } else {
        this.db.prepare("UPDATE check_rounds SET late_receipt_at = ? WHERE id = ? AND late_receipt_at IS NULL").run(now, round.id);
        counted = false;
      }
      const view = this.viewOf(deviceId, accountId);
      return { counted, next_due_at: view.next_due_at, notice_after: view.notice_after };
    })();
  }

  // The devices the scan should look at now: oldest due first, then by id, and
  // no more than `limit`. The rest wait for the next scan in the same order.
  due(limit: number): string[] {
    const rows = this.db
      .prepare("SELECT device_id FROM device_checks WHERE enabled = 1 AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at, device_id LIMIT ?")
      .all(this.clock.now(), limit) as { device_id: string }[];
    return rows.map((row) => row.device_id);
  }

  // One device's turn in the scan. Everything is decided and written in one
  // transaction, and the attempt is on record when this returns. The caller
  // sends the push afterwards. If the process stops in between, the attempt
  // stays on record and is never sent again.
  //
  // Null means there is nothing to send: the round closed, was skipped, or is
  // being held back behind an alarm.
  plan(deviceId: string): PlannedCheck | null {
    const now = this.clock.now();
    return this.db.transaction((): PlannedCheck | null => {
      const state = this.state(deviceId);
      if (state === undefined || state.enabled !== 1 || state.next_attempt_at === null || state.next_attempt_at > now) return null;
      const device = this.device(deviceId);
      if (device === undefined) return null;
      let round = this.openRound(state);
      if (round !== undefined && now >= round.closes_at) {
        this.close(round, "missed", null, round.closes_at);
        return null;
      }
      // The pack is asked for at every attempt, so one that lapses between two
      // pushes of a round stops the second.
      if (!holdsPack(this.db, this.clock, device.account_id, CHECK_PACK, this.packIncludes)) return this.skip(state, round, "pack", now);
      if (device.push_token === "") return this.skip(state, round, "no_token", now);
      if (device.last_alarm_push_at !== null && now - device.last_alarm_push_at < ALARM_HOLD_S) {
        const until = device.last_alarm_push_at + ALARM_HOLD_S;
        this.db.prepare("UPDATE device_checks SET next_attempt_at = ? WHERE device_id = ?").run(round === undefined ? until : Math.min(until, round.closes_at), deviceId);
        return null;
      }
      round ??= this.open(deviceId, now);
      const attempt = round.attempts + 1;
      if (attempt > MAX_ATTEMPTS) {
        this.db.prepare("UPDATE device_checks SET next_attempt_at = ? WHERE device_id = ?").run(round.closes_at, deviceId);
        return null;
      }
      // The primary key on (round_id, attempt) makes a second record of the
      // same attempt fail the whole transaction.
      this.db.prepare("INSERT INTO check_attempts (round_id, attempt, recorded_at) VALUES (?, ?, ?)").run(round.id, attempt, now);
      this.db.prepare("UPDATE check_rounds SET attempts = ? WHERE id = ?").run(attempt, round.id);
      const offset = ATTEMPT_OFFSETS_S[attempt];
      const next = offset === undefined ? round.closes_at : Math.min(round.opened_at + offset, round.closes_at);
      this.db.prepare("UPDATE device_checks SET next_attempt_at = ? WHERE device_id = ?").run(next, deviceId);
      return {
        roundId: round.id,
        attempt,
        checkId: this.checkIdFor(round.id),
        platform: device.platform,
        pushToken: device.push_token,
        ...(device.apns_environment === null ? {} : { apnsEnvironment: device.apns_environment }),
      };
    })();
  }

  // What the provider said about an attempt. A refused token ends the round.
  // Anything else that is not an acceptance used the attempt and changes
  // nothing more.
  record(roundId: string, attempt: number, outcome: AttemptOutcome, status: number): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      const written = this.db.prepare("UPDATE check_attempts SET outcome = ?, status = ? WHERE round_id = ? AND attempt = ? AND outcome IS NULL").run(outcome, status, roundId, attempt);
      // No row: the device was released while the push was on its way.
      if (written.changes === 0) return;
      const round = this.round(roundId);
      if (round === undefined) return;
      if (outcome === "accepted") {
        this.db.prepare("UPDATE device_checks SET last_sent_at = ? WHERE device_id = ?").run(now, round.device_id);
        this.counters.add(LOCAL_KEY, "checks_sent");
      }
      if (outcome === "refused" && round.result === null) this.close(round, "refused", null, now);
    })();
  }

  private viewOf(deviceId: string, accountId: string): CheckView {
    const state = this.state(deviceId);
    const base = {
      misses: state?.misses ?? 0,
      last_sent_at: state?.last_sent_at ?? null,
      last_received_at: state?.last_received_at ?? null,
    };
    if (state === undefined || state.enabled !== 1) return { enabled: false, state: "off", reason: "disabled", ...base, next_due_at: null, notice_after: null };
    if (!holdsPack(this.db, this.clock, accountId, CHECK_PACK, this.packIncludes)) return { enabled: true, state: "off", reason: "pack", ...base, next_due_at: null, notice_after: null };
    const times = { next_due_at: state.next_due_at, notice_after: this.noticeAfter(state) };
    const device = this.device(deviceId);
    if (device === undefined || device.push_token === "") return { enabled: true, state: "no_token", reason: null, ...base, ...times };
    return { enabled: true, state: stateOf(state), reason: null, ...base, ...times };
  }

  // The second at which this device will have missed two rounds in a row if no
  // check arrives from now on. Each round that has yet to close is assumed to
  // close with no receipt.
  private noticeAfter(state: StateRow): number {
    if (state.misses >= 2) return state.second_miss_at ?? this.clock.now();
    const round = this.openRound(state);
    if (round !== undefined) return state.misses === 1 ? round.closes_at : state.next_due_at + ROUND_LENGTH_S;
    // No round is open. The next one opens when it is due, or now if that
    // moment has already passed.
    const opens = Math.max(state.next_due_at, this.clock.now());
    if (state.misses === 1) return opens + ROUND_LENGTH_S;
    return slotAtOrAfter(slotFor(state.device_id), opens + MIN_ROUND_GAP_S) + ROUND_LENGTH_S;
  }

  // Closes this device's open round if the clock has reached its close time,
  // so a read never reports a round as open after it closed. The scan does the
  // same when it gets there. Whichever comes first writes the result, and it
  // is written with the round's own close time either way.
  private settle(deviceId: string): void {
    const state = this.state(deviceId);
    if (state === undefined) return;
    const round = this.openRound(state);
    if (round !== undefined && this.clock.now() >= round.closes_at) this.close(round, "missed", null, round.closes_at);
  }

  private skip(state: StateRow, round: RoundRow | undefined, reason: SkipReason, now: number): null {
    if (round !== undefined) {
      this.close(round, "skipped", reason, now);
      return null;
    }
    // Nothing was open, so the round that was due is written down as skipped
    // and the device waits for its next one.
    const id = `rnd_${randomUUID()}`;
    const next = roundAfter(state.device_id, now);
    this.db
      .prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at, closed_at, attempts, result, reason) VALUES (?, ?, ?, ?, ?, ?, 0, 'skipped', ?)")
      .run(id, state.device_id, sha256(this.checkIdFor(id)), now, now + ROUND_LENGTH_S, now, reason);
    this.db.prepare("UPDATE device_checks SET next_due_at = ?, next_attempt_at = ? WHERE device_id = ?").run(next, next, state.device_id);
    return null;
  }

  // Opens a round. Its close time is fixed here and no later write touches it.
  private open(deviceId: string, now: number): RoundRow {
    const id = `rnd_${randomUUID()}`;
    this.db
      .prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at, attempts) VALUES (?, ?, ?, ?, ?, 0)")
      .run(id, deviceId, sha256(this.checkIdFor(id)), now, now + ROUND_LENGTH_S);
    this.db.prepare("UPDATE device_checks SET round_id = ?, next_due_at = ? WHERE device_id = ?").run(id, roundAfter(deviceId, now), deviceId);
    return this.round(id) as RoundRow;
  }

  // Writes a round's result, once. The guard on `result IS NULL` is what keeps
  // a closed round closed: a late receipt, a second scan and a clock that
  // moved all land here and change nothing.
  private close(round: RoundRow, result: RoundResult, reason: SkipReason | null, closedAt: number): boolean {
    const written = this.db.prepare("UPDATE check_rounds SET result = ?, reason = ?, closed_at = ? WHERE id = ? AND result IS NULL").run(result, reason, closedAt, round.id);
    if (written.changes === 0) return false;
    this.db
      .prepare("UPDATE device_checks SET round_id = NULL, next_attempt_at = CASE WHEN enabled = 1 THEN next_due_at ELSE NULL END WHERE device_id = ? AND round_id = ?")
      .run(round.device_id, round.id);
    if (result === "received") {
      this.db.prepare("UPDATE device_checks SET misses = 0, last_result = 'received', second_miss_at = NULL, last_received_at = ? WHERE device_id = ?").run(closedAt, round.device_id);
    } else if (result === "missed" || result === "refused") {
      this.db
        .prepare("UPDATE device_checks SET second_miss_at = CASE WHEN misses = 1 THEN ? ELSE second_miss_at END, misses = misses + 1, last_result = ? WHERE device_id = ?")
        .run(closedAt, result, round.device_id);
    }
    // A skipped round changes neither the count nor the last result.
    return true;
  }

  // The check_id of a round. It is worked out from the round's id and a key
  // this database holds, and it is written nowhere: the round stores its hash.
  // Working it out again is what lets a later push of the same round, after a
  // restart, carry the same value.
  private checkIdFor(roundId: string): string {
    return `chk_${createHmac("sha256", this.key()).update(roundId).digest("hex").slice(0, 32)}`;
  }

  private key(): string {
    if (this.secret !== undefined) return this.secret;
    this.db.prepare("INSERT OR IGNORE INTO check_secret (id, secret) VALUES (1, ?)").run(randomBytes(32).toString("hex"));
    const row = this.db.prepare("SELECT secret FROM check_secret WHERE id = 1").get() as { secret: string };
    this.secret = row.secret;
    return row.secret;
  }

  private state(deviceId: string): StateRow | undefined {
    return this.db
      .prepare("SELECT device_id, enabled, next_attempt_at, next_due_at, round_id, misses, last_result, second_miss_at, last_sent_at, last_received_at FROM device_checks WHERE device_id = ?")
      .get(deviceId) as StateRow | undefined;
  }

  private round(id: string): RoundRow | undefined {
    return this.db.prepare(`SELECT ${ROUND_COLUMNS} FROM check_rounds WHERE id = ?`).get(id) as RoundRow | undefined;
  }

  private openRound(state: StateRow): RoundRow | undefined {
    if (state.round_id === null) return undefined;
    const round = this.round(state.round_id);
    return round === undefined || round.result !== null ? undefined : round;
  }

  // The device's account, platform and alarm token. The token is read the way
  // the alarm sender reads it, so a check goes to the token an alarm would
  // use. Read only: the check never writes to a device or its tokens.
  private device(deviceId: string): DeviceRow | undefined {
    return this.db
      .prepare(
        `SELECT d.account_id, d.platform, d.apns_environment, d.last_alarm_push_at,
           COALESCE(alarm.token, d.push_token) AS push_token
         FROM devices d
         LEFT JOIN device_tokens alarm ON alarm.device_id = d.id AND alarm.activity_id = ''
           AND alarm.kind = CASE d.platform WHEN 'ios' THEN 'apns' ELSE 'fcm' END
         WHERE d.id = ?`,
      )
      .get(deviceId) as DeviceRow | undefined;
  }
}

function stateOf(state: StateRow): CheckState {
  if (state.last_result === null) return "waiting";
  if (state.last_result === "received") return "received";
  if (state.misses >= 2) return "missed_repeatedly";
  return state.last_result === "refused" ? "token_refused" : "missed_once";
}
