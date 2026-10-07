import { createHash } from "node:crypto";

// api.md §4.5. The numbers of the weekly check, in seconds, and the one piece
// of arithmetic the schedule needs.

export const HOUR_S = 3_600;
export const DAY_S = 86_400;
export const WEEK_S = 7 * DAY_S;

// A round stays open this long from the moment it opens.
export const ROUND_LENGTH_S = DAY_S;
// When each of a round's pushes is due, counted from the moment it opened.
export const ATTEMPT_OFFSETS_S = [0, 6 * HOUR_S, 18 * HOUR_S] as const;
export const MAX_ATTEMPTS = ATTEMPT_OFFSETS_S.length;
// No push of a round goes to a device this soon after an alarm push to it.
export const ALARM_HOLD_S = 30 * 60;
// The next round is at the device's first slot at least this long after the
// last one opened. A round that opened on its slot is therefore followed by
// one exactly a week later. A first round, or one that opened late, is
// followed by one between three and ten days later, on the slot.
export const MIN_ROUND_GAP_S = 3 * DAY_S;
// A round is kept this long, whatever the tier.
export const ROUND_RETENTION_S = 90 * DAY_S;

// 1970-01-05 00:00 UTC, the first Monday after the epoch. Slots are counted
// from Monday 00:00 UTC.
const FIRST_MONDAY_S = 4 * DAY_S;

// A device's fixed second of the week, from its id. Slots spread the load and
// nothing depends on two devices having different ones.
export function slotFor(deviceId: string): number {
  const head = createHash("sha256").update(deviceId).digest("hex").slice(0, 8);
  return Number.parseInt(head, 16) % WEEK_S;
}

// The first second at or after `time` that falls on `slot`.
export function slotAtOrAfter(slot: number, time: number): number {
  const into = (((time - FIRST_MONDAY_S - slot) % WEEK_S) + WEEK_S) % WEEK_S;
  return into === 0 ? time : time + (WEEK_S - into);
}

// When the round after one that opened at `openedAt` is due.
export function roundAfter(deviceId: string, openedAt: number): number {
  return slotAtOrAfter(slotFor(deviceId), openedAt + MIN_ROUND_GAP_S);
}
