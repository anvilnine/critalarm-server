import type { CheckAnswer, CheckSender } from "../push/check.js";
import type { AlarmNotes } from "./device-hooks.js";
import type { CheckStore, PlannedCheck } from "./store.js";

// api.md §4.5. The scan that sends weekly checks. Its timer state is rows in
// device_checks, so a restart loses nothing and resends nothing.
//
// It has its own senders and its own loop. The alarm dispatcher does not call
// it, wait for it or read anything it writes.

export interface CheckSenders {
  ios?: CheckSender;
  android?: CheckSender;
}

// How many devices one scan looks at. More than that are due after downtime,
// and they drain in order at this rate, so there is no burst.
export const SCAN_BATCH = 100;
export const SCAN_INTERVAL_MS = 60_000;
// How long one pass may spend. Past it the pass stops and the devices it did
// not reach wait for the next tick, in the same oldest-first order. It is
// shorter than the interval, so passes do not pile up behind a slow provider.
export const SCAN_BUDGET_MS = 45_000;

export interface CheckSchedulerOptions {
  batch?: number;
  budgetMs?: number;
  // Wall time in milliseconds, for the budget. The tests replace it.
  nowMs?: () => number;
  // Alarm pushes noted in memory by the alarm side. The scan writes them down
  // before it decides anything, so the hold it reads is current.
  notes?: AlarmNotes;
}

export class CheckScheduler {
  private running = false;
  private readonly batch: number;
  private readonly budgetMs: number;
  private readonly nowMs: () => number;
  private readonly notes: AlarmNotes | undefined;

  constructor(
    private readonly store: CheckStore,
    private readonly senders: CheckSenders,
    options: CheckSchedulerOptions = {},
  ) {
    this.batch = options.batch ?? SCAN_BATCH;
    this.budgetMs = options.budgetMs ?? SCAN_BUDGET_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.notes = options.notes;
  }

  // One pass. Returns how many attempts it put on record. A pass that is
  // still sending when the next one is due makes that next one do nothing.
  async scan(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const startedAt = this.nowMs();
    let planned = 0;
    try {
      this.notes?.flush();
      for (const deviceId of this.store.due(this.batch)) {
        if (this.nowMs() - startedAt >= this.budgetMs) break;
        let next: PlannedCheck | null;
        try {
          // An alarm may have gone out while the last check was being sent.
          this.notes?.flush();
          next = this.store.plan(deviceId);
        } catch (error: unknown) {
          console.error("check_plan_failed", { device_id: deviceId, reason: error instanceof Error ? error.name : "unknown" });
          continue;
        }
        if (next === null) continue;
        // The attempt is on record from here on. Whatever happens to the send,
        // it is not sent again.
        planned += 1;
        const answer = await this.send(next);
        this.store.record(next.roundId, next.attempt, answer.outcome, answer.status);
        if (answer.outcome !== "accepted") console.log(JSON.stringify({ event: "check_not_accepted", round: next.roundId, attempt: next.attempt, outcome: answer.outcome, status: answer.status }));
      }
    } finally {
      this.running = false;
    }
    return planned;
  }

  private async send(planned: PlannedCheck): Promise<CheckAnswer> {
    const sender = this.senders[planned.platform];
    // No provider configured for this platform. 501, as the alarm path says
    // for the same case.
    if (sender === undefined) return { outcome: "failed", status: 501 };
    try {
      return await sender.sendCheck(
        { platform: planned.platform, pushToken: planned.pushToken, ...(planned.apnsEnvironment === undefined ? {} : { apnsEnvironment: planned.apnsEnvironment }) },
        { checkId: planned.checkId, attempt: planned.attempt },
        // Asked by the sender just before the bytes leave.
        () => this.store.confirm(planned),
      );
    } catch (error: unknown) {
      // Only the error's class is logged. Its message could quote the request.
      console.error("check_send_failed", { round: planned.roundId, reason: error instanceof Error ? error.name : "unknown" });
      return { outcome: "failed", status: 0 };
    }
  }
}

export function startCheckScheduler(scheduler: CheckScheduler, intervalMs: number = SCAN_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    void scheduler.scan().catch((error: unknown) => {
      console.error("check_scan_failed", { reason: error instanceof Error ? error.name : "unknown" });
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
