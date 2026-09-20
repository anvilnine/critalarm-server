import type Database from "better-sqlite3";

// A migration is either plain SQL or a step that needs to do something SQL
// alone cannot express. `foreignKeysOff` asks the runner to turn foreign key
// enforcement off before it opens the transaction, because PRAGMA foreign_keys
// is a no-op once a transaction is open.
type Migration = string | { foreignKeysOff: true; up: (db: Database.Database) => void };

const migrations: Migration[] = [
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
  // api.md §4.2. aj_, the account join token. Account-scoped, so it survives
  // every device being removed, and stored as a sha256 hash like dv_ and tk_.
  // The unique index counts NULLs as distinct, so accounts made before this
  // migration keep a null and are simply not joinable until one is minted.
  `
    ALTER TABLE accounts ADD COLUMN join_token_hash TEXT;
    CREATE UNIQUE INDEX accounts_join_token_hash ON accounts(join_token_hash);
  `,
  // The tombstone a merge needs. Without it a merge has to delete the losing
  // account, and that delete cascades through devices, topics, subscriptions
  // and relay_p4_usage. A merged account keeps its row, points at the winner,
  // and a late RevenueCat id for it resolves one hop to the winner.
  `ALTER TABLE accounts ADD COLUMN merged_into TEXT REFERENCES accounts(id);`,
  // The device cap counts rows in devices by account on every registration and
  // had no index for it. subscriptions(topic_hash) already has one, added in
  // version 7, so it is not repeated here.
  `CREATE INDEX devices_by_account ON devices(account_id);`,
  // Billing moves off accounts.rc_app_user_id, which is UNIQUE and so cannot
  // hold two subscribers on one account. entitled_tier is what this one billing
  // id pays for right now; the account's tier is the highest of them, so one
  // lapsed subscription no longer downgrades an account another still pays for.
  // last_event_at is per billing id, because subscriptions on one account
  // expire independently.
  //
  // billing_events is the dedup and ordering log: a repeat event id is skipped
  // and an event older than its billing id's last_event_at is dropped, and both
  // are recorded with applied = 0 so a support question has an answer.
  // tier_changes names the event behind every tier move.
  `
    CREATE TABLE account_billing_ids (
      app_user_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      linked_at INTEGER NOT NULL,
      last_event_at INTEGER,
      entitled_tier TEXT NOT NULL DEFAULT 'free' CHECK (entitled_tier IN ('free', 'relay', 'hosted'))
    );
    CREATE INDEX account_billing_ids_by_account ON account_billing_ids(account_id);

    CREATE TABLE billing_events (
      event_id TEXT PRIMARY KEY,
      app_user_id TEXT NOT NULL,
      account_id TEXT REFERENCES accounts(id),
      type TEXT NOT NULL,
      event_at INTEGER NOT NULL,
      applied INTEGER NOT NULL,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE tier_changes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      from_tier TEXT,
      to_tier TEXT NOT NULL,
      reason TEXT NOT NULL,
      event_id TEXT,
      changed_at INTEGER NOT NULL
    );

    CREATE TABLE account_merges (
      id TEXT PRIMARY KEY,
      from_account TEXT NOT NULL,
      into_account TEXT NOT NULL,
      merged_at INTEGER NOT NULL,
      detail TEXT NOT NULL
    );

    INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier)
      SELECT rc_app_user_id, id, created_at, NULL, tier FROM accounts WHERE rc_app_user_id IS NOT NULL;
  `,
  // A stale copy of devices.account_id, written once when the row was inserted
  // and never updated. Left in place, a merge makes unsubscribeDevice filter on
  // the old account, delete nothing, and still answer 204: the user taps "stop
  // alerting this device" and the alarm keeps ringing. No index on the column,
  // so a native DROP COLUMN works and every reader now joins devices.
  `ALTER TABLE subscriptions DROP COLUMN account_id;`,
  { foreignKeysOff: true, up: rebuildAccountsWithoutRcAppUserId },
  // api.md §3.7, the identity storage. The first four tables and three indexes
  // are better-auth's own schema, copied verbatim from what better-auth 1.7.5
  // generates for SQLite. They are created here rather than by `npx auth
  // migrate` so one `migrate()` call still leaves a complete database and the
  // server needs no second migration tool at boot.
  //
  // Note the name clash: better-auth's `user`/`session`/`account` are the human
  // and their OAuth credentials, while our `accounts` (plural) is the tenant
  // that owns topics, devices and billing. They are different things.
  //
  // account_identities is the map between them, and it is ours. One better-auth
  // user points at exactly one `accounts` row, and one `accounts` row carries at
  // most one identity. Both constraints exist as a backstop only: every caller
  // checks first and answers 409, because a constraint firing would be a 500 and
  // api.md §3.7 says these two cases must not be decided that way.
  //
  // Contract 1.14.0 takes the second of those two away: migration 15 below
  // rebuilds this table without the UNIQUE on account_id, so one account can
  // hold a Google identity and an Apple one.
  `
    CREATE TABLE "user" (
      "id" text not null primary key,
      "name" text not null,
      "email" text not null unique,
      "emailVerified" integer not null,
      "image" text,
      "createdAt" date not null,
      "updatedAt" date not null
    );

    CREATE TABLE "session" (
      "id" text not null primary key,
      "expiresAt" date not null,
      "token" text not null unique,
      "createdAt" date not null,
      "updatedAt" date not null,
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null references "user" ("id") on delete cascade
    );
    CREATE INDEX "session_userId_idx" on "session" ("userId");

    CREATE TABLE "account" (
      "id" text not null primary key,
      "accountId" text not null,
      "providerId" text not null,
      "userId" text not null references "user" ("id") on delete cascade,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" date,
      "refreshTokenExpiresAt" date,
      "scope" text,
      "password" text,
      "createdAt" date not null,
      "updatedAt" date not null
    );
    CREATE INDEX "account_userId_idx" on "account" ("userId");

    CREATE TABLE "verification" (
      "id" text not null primary key,
      "identifier" text not null,
      "value" text not null,
      "expiresAt" date not null,
      "createdAt" date not null,
      "updatedAt" date not null
    );
    CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");

    -- No foreign key on user_id. better-auth owns the "user" table and may
    -- rebuild it on a version upgrade; a reference from here would block that.
    CREATE TABLE account_identities (
      user_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
      linked_at INTEGER NOT NULL
    );
  `,
  { foreignKeysOff: true, up: rebuildAccountIdentitiesWithoutUniqueAccount },
  // api.md §3.1, contract 1.15.0. Every topic token gets a name. The column
  // stays nullable on purpose: adding a NOT NULL column to a table that already
  // holds rows needs a default value, and any default here would be wrong for
  // the rows that are already there. The backfill below names every existing
  // row, and both write paths always send a name, so it is never null in
  // practice.
  //
  // The backfill counts, per topic, how many of that topic's tokens sort at or
  // before this one by (created_at, rowid), which is the order listTokens
  // returns. Counting the row itself makes that count its position starting at
  // 1, so the oldest token in each topic becomes Token 1 whatever the other
  // topics hold.
  `
    ALTER TABLE topic_tokens ADD COLUMN name TEXT;
    UPDATE topic_tokens SET name = 'Token ' || (
      SELECT COUNT(*) FROM topic_tokens AS earlier
      WHERE earlier.topic_id = topic_tokens.topic_id
        AND (earlier.created_at, earlier.rowid) <= (topic_tokens.created_at, topic_tokens.rowid)
    );
  `,
];

// Which tables name `table` in a REFERENCES clause right now. Read from the
// stored schema rather than assumed, because the whole point of the assertion
// below is that a rename can move these without saying so.
function referencingTables(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
    .all() as { name: string; sql: string }[];
  const clause = new RegExp(`REFERENCES\\s+"?${table}"?\\s*\\(`);
  return rows.filter((row) => clause.test(row.sql)).map((row) => row.name).sort();
}

// Drops accounts.rc_app_user_id. The column is UNIQUE, so it carries an
// implicit index and SQLite refuses a native DROP COLUMN; the table has to be
// rebuilt. Four things make the obvious rebuild eat the schema, all four
// measured on SQLite 3.53.4 rather than assumed:
//
//   1. migrate() runs every migration inside db.transaction().
//   2. PRAGMA foreign_keys is a no-op inside a transaction, so enforcement
//      cannot be turned off in here. This entry carries foreignKeysOff, which
//      the runner honours before it opens the transaction. PRAGMA
//      legacy_alter_table is a no-op inside a transaction too, so it is no help
//      either.
//   3. With enforcement on, DROP TABLE accounts runs an implicit DELETE FROM
//      first, and every ON DELETE CASCADE child empties: devices, topics,
//      relay_p4_usage, account_billing_ids, and whatever hangs off those.
//   4. ALTER TABLE accounts RENAME TO x rewrites the REFERENCES clause of every
//      table that points at accounts, so the children follow the old table to
//      its temporary name. This happens with enforcement off as well.
//
// So (4) is used on purpose instead of fought:
//
//   1. Rename accounts to accounts_s16_old. Every child clause now reads
//      REFERENCES accounts_s16_old.
//   2. Create accounts_s16_new without rc_app_user_id, carrying join_token_hash
//      and merged_into. Its own merged_into clause names `accounts`, the name
//      it ends up with, and SQLite allows a clause naming a table that does not
//      exist yet.
//   3. Copy every row across.
//   4. Drop accounts_s16_old. Enforcement is off, so there is no implicit
//      DELETE and nothing cascades. The unique index on join_token_hash
//      followed the rename in step 1 and dies with the table.
//   5. Rename accounts_s16_new to accounts_s16_old. Nothing references
//      accounts_s16_new, so no clause moves, and the children's REFERENCES
//      accounts_s16_old now resolve to the new table.
//   6. Rename accounts_s16_old to accounts. The rewrite from (4) now works for
//      us and puts every child clause back on accounts.
//   7. Recreate the unique index on join_token_hash, or the account join token
//      loses its uniqueness guarantee.
//   8. Check it. Every table that referenced accounts before step 1 must
//      reference it again, and PRAGMA foreign_key_check must come back empty.
//      Either check failing throws, and the transaction rolls all of it back.
function rebuildAccountsWithoutRcAppUserId(db: Database.Database): void {
  const before = referencingTables(db, "accounts");
  db.exec(`
    ALTER TABLE accounts RENAME TO accounts_s16_old;

    CREATE TABLE accounts_s16_new (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL CHECK (tier IN ('free', 'relay', 'hosted')),
      created_at INTEGER NOT NULL,
      join_token_hash TEXT,
      merged_into TEXT REFERENCES accounts(id)
    );

    INSERT INTO accounts_s16_new (id, tier, created_at, join_token_hash, merged_into)
      SELECT id, tier, created_at, join_token_hash, merged_into FROM accounts_s16_old;

    DROP TABLE accounts_s16_old;
    ALTER TABLE accounts_s16_new RENAME TO accounts_s16_old;
    ALTER TABLE accounts_s16_old RENAME TO accounts;

    CREATE UNIQUE INDEX accounts_join_token_hash ON accounts(join_token_hash);
  `);

  const after = referencingTables(db, "accounts");
  const lost = before.filter((name) => !after.includes(name));
  if (lost.length > 0) {
    throw new Error(`accounts rebuild left ${lost.join(", ")} pointing at something else`);
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(`accounts rebuild broke foreign keys: ${JSON.stringify(violations)}`);
  }
}

// api.md §3.7, contract 1.14.0. Drops the UNIQUE on
// account_identities.account_id so one account can hold a Google identity and an
// Apple one. The column is UNIQUE, which carries an implicit index, and SQLite
// has no way to drop a constraint in place, so the table is rebuilt the way
// migration 3 rebuilds accounts.
//
// This rebuild is the short version of that one, because account_identities is a
// child and nothing references it:
//
//   1. Create the new table with the same three columns and no UNIQUE.
//   2. Copy every row across.
//   3. Drop the old table. Enforcement is off (foreignKeysOff above), so there
//      is no implicit DELETE and no cascade, the same reason migration 3 needs
//      it. account_identities cascades off accounts, and dropping it with
//      enforcement on would still be safe here, but the row copy is worth more
//      than the guess.
//   4. Rename the new table into place. No other table names
//      account_identities in a REFERENCES clause, so no clause moves.
//   5. Add a plain index on account_id. The unique index that used to serve
//      "which identities does this account hold" went with the constraint, and
//      that lookup runs on every link, switch, merge and delete.
//   6. Check it. Every row has to arrive, user_id has to still be the primary
//      key, and PRAGMA foreign_key_check has to come back empty. Any of the
//      three failing throws, and the transaction rolls all of it back.
function rebuildAccountIdentitiesWithoutUniqueAccount(db: Database.Database): void {
  const before = (db.prepare("SELECT COUNT(*) AS count FROM account_identities").get() as { count: number }).count;
  db.exec(`
    CREATE TABLE account_identities_s30_new (
      user_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      linked_at INTEGER NOT NULL
    );

    INSERT INTO account_identities_s30_new (user_id, account_id, linked_at)
      SELECT user_id, account_id, linked_at FROM account_identities;

    DROP TABLE account_identities;
    ALTER TABLE account_identities_s30_new RENAME TO account_identities;

    CREATE INDEX account_identities_account_id ON account_identities(account_id);
  `);

  const after = (db.prepare("SELECT COUNT(*) AS count FROM account_identities").get() as { count: number }).count;
  if (after !== before) {
    throw new Error(`account_identities rebuild carried ${after} of ${before} rows`);
  }
  const keyed = (db.pragma("table_info(account_identities)") as { name: string; pk: number }[]).filter((column) => column.pk > 0).map((column) => column.name);
  if (keyed.length !== 1 || keyed[0] !== "user_id") {
    throw new Error(`account_identities rebuild left the primary key on ${keyed.join(", ")}`);
  }
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(`account_identities rebuild broke foreign keys: ${JSON.stringify(violations)}`);
  }
}

export const migrationCount = migrations.length;

// `upTo` stops after that version. Production always runs the whole list; the
// schema tests use it to build a database at an older version, fill it, and
// then migrate the rest of the way.
export function migrate(db: Database.Database, upTo: number = migrations.length): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
  );

  const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = ?");
  const markApplied = db.prepare("INSERT INTO schema_migrations (version) VALUES (?)");

  for (const [index, migration] of migrations.entries()) {
    const version = index + 1;
    if (version > upTo) break;
    if (applied.get(version) !== undefined) continue;
    const step = typeof migration === "string"
      ? { foreignKeysOff: false as const, up: (target: Database.Database) => target.exec(migration) }
      : migration;
    // Has to happen out here: PRAGMA foreign_keys does nothing once a
    // transaction is open, and a migration that rebuilds a parent table needs
    // enforcement off or DROP TABLE cascades the parent's children away.
    const wasEnforcing = step.foreignKeysOff && db.pragma("foreign_keys", { simple: true }) === 1;
    if (wasEnforcing) db.pragma("foreign_keys = OFF");
    // The pragma does nothing if a transaction is already open, and it does it
    // silently. A rebuild that runs with enforcement still on drops the parent
    // table and cascades its children away, so stop here instead.
    if (step.foreignKeysOff && db.pragma("foreign_keys", { simple: true }) !== 0) {
      throw new Error(`migration ${version} needs foreign keys off and could not turn them off; is a transaction already open?`);
    }
    try {
      db.transaction(() => {
        step.up(db);
        markApplied.run(version);
      })();
    } finally {
      if (wasEnforcing) db.pragma("foreign_keys = ON");
    }
  }
}
