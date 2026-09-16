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
// A row holds no account of its own. devices.account_id is the one copy, so a
// merge that moves a device to another account moves its subscriptions with it
// and nothing goes stale.

export function sweepDeviceIntoTopics(db: Database.Database, accountId: string, deviceId: string): void {
  db.prepare("INSERT OR IGNORE INTO subscriptions (device_id, topic_hash) SELECT ?, topic_hash FROM topics WHERE account_id = ?").run(deviceId, accountId);
}

export function sweepTopicIntoDevices(db: Database.Database, accountId: string, topicHash: string): void {
  db.prepare("INSERT OR IGNORE INTO subscriptions (device_id, topic_hash) SELECT id, ? FROM devices WHERE account_id = ?").run(topicHash, accountId);
}
