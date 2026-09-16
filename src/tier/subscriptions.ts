import type Database from "better-sqlite3";

// Every device on an account holds a row for every topic that account owns, so a
// handset that joined after a topic was made still rings for it. Both sweeps run
// inside the transaction that inserted the device or the topic.
//
// The primary key is (device_id, topic_hash), so INSERT OR IGNORE makes either
// sweep safe to run again. Neither one checks a cap: a sweep is bookkeeping, not
// a user asking for something, and the cap was already applied where the device
// or the topic was created.
//
// account_id is written because the p4 quota query in relay/router.ts and
// unsubscribeDevice still read the row by it.

export function sweepDeviceIntoTopics(db: Database.Database, accountId: string, deviceId: string): void {
  db.prepare("INSERT OR IGNORE INTO subscriptions (account_id, device_id, topic_hash) SELECT account_id, ?, topic_hash FROM topics WHERE account_id = ?").run(deviceId, accountId);
}

export function sweepTopicIntoDevices(db: Database.Database, accountId: string, topicHash: string): void {
  db.prepare("INSERT OR IGNORE INTO subscriptions (account_id, device_id, topic_hash) SELECT account_id, id, ? FROM devices WHERE account_id = ?").run(topicHash, accountId);
}
