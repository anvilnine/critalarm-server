import type { CheckAnswer, CheckSender } from "../push/check.js";
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

export class CheckScheduler {
  private running = false;

  constructor(
    private readonly store: CheckStore,
    private readonly senders: CheckSenders,
    private readonly batch: number = SCAN_BATCH,
  ) {}

  // One pass. Returns how many pushes it handed to a sender. A pass that is
  // still sending when the next one is due makes that next one do nothing.
  async scan(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      for (const deviceId of this.store.due(this.batch)) {
        let planned: PlannedCheck | null;
        try {
          planned = this.store.plan(deviceId);
        } catch (error: unknown) {
          console.error("check_plan_failed", { device_id: deviceId, reason: error instanceof Error ? error.name : "unknown" });
          continue;
        }
        if (planned === null) continue;
        // The attempt is on record from here on. Whatever happens to the send,
        // it is not sent again.
        const answer = await this.send(planned);
        sent += 1;
        this.store.record(planned.roundId, planned.attempt, answer.outcome, answer.status);
        if (answer.outcome !== "accepted") console.log(JSON.stringify({ event: "check_not_accepted", round: planned.roundId, attempt: planned.attempt, outcome: answer.outcome, status: answer.status }));
      }
    } finally {
      this.running = false;
    }
    return sent;
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
