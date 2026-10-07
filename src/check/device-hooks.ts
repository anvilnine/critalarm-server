import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import type { DeliveryEvent } from "../domain-events.js";
import type { PushSender } from "../push/types.js";

// The two places the weekly check learns something from the rest of the
// server. Both are one small write and neither imports the check store.

const ringingKinds: ReadonlySet<DeliveryEvent["kind"]> = new Set(["open", "repeat", "reopen"]);

// api.md §4.5: no check is started for a device within 30 minutes after an
// open, a repeat or a reopen was sent to it. This notes when that was.
//
// It wraps an alarm sender and changes nothing about the send: the device and
// the event go through untouched, the result comes back untouched, and an
// error from the sender is thrown on as it was. The note is written after the
// send has returned, and a failure to write it is swallowed, because the hold
// is a courtesy and the alarm is not.
export function notingAlarmPushes(sender: PushSender, db: Database.Database, clock: Clock): PushSender {
  const note = db.prepare("UPDATE devices SET last_alarm_push_at = ? WHERE id = ?");
  return {
    async send(device, event) {
      const result = await sender.send(device, event);
      if (ringingKinds.has(event.kind)) {
        try {
          note.run(clock.now(), device.id);
        } catch {
          // Never the alarm's problem.
        }
      }
      return result;
    },
  };
}

// api.md §4.5: a device that registers a new push token while it has misses
// becomes due at once. A round that is already open is left alone, because its
// remaining pushes will go to the new token anyway.
export function checkDueAfterNewToken(db: Database.Database, clock: Clock, deviceId: string): void {
  const now = clock.now();
  db.prepare("UPDATE device_checks SET next_due_at = ?, next_attempt_at = ? WHERE device_id = ? AND enabled = 1 AND misses > 0 AND round_id IS NULL").run(now, now, deviceId);
}
