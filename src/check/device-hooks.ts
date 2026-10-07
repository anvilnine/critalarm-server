import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import type { DeliveryEvent } from "../domain-events.js";
import type { PushSender } from "../push/types.js";

// The two places the weekly check learns something from the rest of the
// server. Neither imports the check store.

const ringingKinds: ReadonlySet<DeliveryEvent["kind"]> = new Set(["open", "repeat", "reopen"]);

// When an alarm push last reached each device, held in memory until the check
// scan writes it down. Only the newest time per device is kept, so a burst of
// repeats is one write. Nothing on the alarm path writes to the database for
// this: the alarm side puts a number in a map and the scan does the rest.
//
// If the process stops before a flush, the notes not yet written are lost and
// those devices are not held. That is accepted: the hold is a courtesy to the
// phone, and losing it costs at most one check push close to an alarm.
export class AlarmNotes {
  private readonly latest = new Map<string, number>();

  constructor(private readonly write: (deviceId: string, at: number) => void) {}

  add(deviceId: string, at: number): void {
    const known = this.latest.get(deviceId);
    if (known === undefined || at > known) this.latest.set(deviceId, at);
  }

  // Called by the check scan, never by the alarm path. A write that fails is
  // swallowed and its note is kept for the next flush.
  flush(): void {
    for (const [deviceId, at] of [...this.latest]) {
      try {
        this.write(deviceId, at);
        if (this.latest.get(deviceId) === at) this.latest.delete(deviceId);
      } catch {
        // Kept, and tried again next time.
      }
    }
  }
}

export function alarmNoteWriter(db: Database.Database): (deviceId: string, at: number) => void {
  const statement = db.prepare("UPDATE devices SET last_alarm_push_at = ? WHERE id = ? AND (last_alarm_push_at IS NULL OR last_alarm_push_at < ?)");
  return (deviceId, at) => { statement.run(at, deviceId, at); };
}

// api.md §4.5: no check is started for a device within 30 minutes after APNs
// or FCM accepted an open, a repeat or a reopen for it. This notes when that
// was. A push the provider refused, or one that failed, notes nothing.
//
// It wraps an alarm sender and changes nothing about the send: the device and
// the event go through untouched, the result comes back untouched, and an
// error from the sender is thrown on as it was. After the send has returned it
// puts one number in a map, and even that cannot fail the alarm. It does not
// touch the database and waits for nothing.
export function notingAlarmPushes(sender: PushSender, notes: AlarmNotes, clock: Clock): PushSender {
  return {
    async send(device, event) {
      const result = await sender.send(device, event);
      try {
        if (ringingKinds.has(event.kind) && result.status >= 200 && result.status < 300 && !result.stale) notes.add(device.id, clock.now());
      } catch {
        // Never the alarm's problem.
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
