import type Database from "better-sqlite3";

const migrations = [
  `
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL CHECK (tier IN ('free', 'relay', 'hosted')),
      rc_app_user_id TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_token_hash TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      push_token TEXT NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE subscriptions (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      topic_hash TEXT NOT NULL,
      PRIMARY KEY (device_id, topic_hash)
    );

    CREATE TABLE topics (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      topic_hash TEXT NOT NULL,
      critical INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0, 1)),
      repeat_interval_s INTEGER NOT NULL,
      max_ring_s INTEGER NOT NULL,
      desk_timer_s INTEGER NOT NULL,
      relay_content TEXT NOT NULL CHECK (relay_content IN ('none', 'full')),
      created_at INTEGER NOT NULL,
      UNIQUE (account_id, name),
      UNIQUE (account_id, topic_hash)
    );

    CREATE TABLE topic_tokens (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE incidents (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('open', 'acked', 'closed', 'expired')),
      opened_at INTEGER NOT NULL,
      acked_at INTEGER,
      closed_at INTEGER,
      last_message_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX incidents_one_active_per_topic
      ON incidents(topic_id) WHERE state IN ('open', 'acked');

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
      tags TEXT NOT NULL DEFAULT '[]',
      click TEXT,
      markdown INTEGER NOT NULL DEFAULT 0 CHECK (markdown IN (0, 1)),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE timers (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('repeat', 'expire', 'desk')),
      fire_at INTEGER NOT NULL,
      UNIQUE (incident_id, kind)
    );

    CREATE INDEX messages_by_incident ON messages(incident_id, created_at);
    CREATE INDEX timers_due ON timers(fire_at);
  `,
  `
    ALTER TABLE incidents ADD COLUMN max_ring_s INTEGER NOT NULL DEFAULT 0;
    UPDATE incidents
      SET max_ring_s = (
        SELECT max_ring_s FROM topics WHERE topics.id = incidents.topic_id
      )
      WHERE max_ring_s = 0;
  `,
  `
    CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE relay_servers (
      id TEXT PRIMARY KEY, base_url TEXT NOT NULL, version TEXT NOT NULL,
      relay_key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
    CREATE TABLE relay_client_credentials (
      relay_url TEXT PRIMARY KEY, relay_key TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE relay_p4_usage (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      day_start INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (account_id, day_start)
    );
  `,
  `
    CREATE TABLE device_tokens (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('apns', 'fcm', 'la_start', 'la_update')),
      activity_id TEXT NOT NULL DEFAULT '',
      incident_id TEXT,
      token TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, kind, activity_id)
    );
    CREATE INDEX device_tokens_by_incident ON device_tokens(incident_id, kind);

    INSERT INTO device_tokens (device_id, kind, activity_id, incident_id, token, updated_at)
      SELECT id, CASE platform WHEN 'ios' THEN 'apns' ELSE 'fcm' END, '', NULL, push_token, last_seen
      FROM devices WHERE push_token <> '';
  `,
  `
    CREATE TABLE counters (
      day TEXT NOT NULL,
      relay_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, relay_key, metric)
    );
    CREATE INDEX counters_by_day ON counters(day);

    CREATE TABLE counters_zeroed (
      relay_key TEXT PRIMARY KEY,
      zeroed_at INTEGER NOT NULL
    );
  `,
  `ALTER TABLE devices ADD COLUMN app_version TEXT;`,
  `CREATE INDEX subscriptions_by_topic_hash ON subscriptions(topic_hash);`,
];

export function migrate(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
  );

  const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = ?");
  const markApplied = db.prepare("INSERT INTO schema_migrations (version) VALUES (?)");

  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (applied.get(version) === undefined) {
      db.transaction(() => {
        db.exec(sql);
        markApplied.run(version);
      })();
    }
  }
}
