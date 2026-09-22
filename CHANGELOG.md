# Changelog

Versions here are the API contract's versions (`docs/api.md`), not the server
binary's. The binary's version is in `package.json`.

## 1.17.0 - 2026-09-23

### Added

- `updated_at` on every incident object (§3.2). Set on open, moved forward on
  every new message, ack, close, expire and reopen.

### Changed

- `since` on `GET /v1/incidents` compares against `updated_at`, not
  `opened_at` (§3.2). A client that holds an incident as open now hears that
  it was acked, closed or expired on its next list call, whether or not the
  push for that change reached it. The retention window still hides rows by
  `opened_at`.

## 1.16.0 - 2026-09-22

### Added

- `ack`, `close` and `expire` as FCM data-only push kinds (§5.2) and as relay
  `kind` values (§4.1). Android devices hear the state change and stop ringing.
  iOS still gets it through the Live Activity update only.
- `ring_until` on every alarm push (§5.1, §5.2, §4.1). Epoch seconds,
  `opened_at + max_ring_s`, moved by a reopen. The phone may re-arm a silenced
  alarm locally until then and no later.
- `since` on `GET /v1/incidents` (§3.2). Unix timestamp, exclusive, on
  `opened_at`.

### Changed

- `history_days` is a retention window (§4.2). A `relay` or `hosted` server
  deletes closed and expired incidents, and messages with no incident, older
  than the account's window, at least once an hour, and never returns them
  from `GET /v1/incidents` or `GET /{topic}/json`. Open and acked incidents
  are never deleted. A self-hosted server is unchanged: no tier, no deletion.

### Removed

- `history_incidents` from the caps object (§4.2). Free history is 7 days,
  with no count limit. A client that still reads the field treats its absence
  as no limit.

### Server 0.2.0

The code side of 1.16.0. The dispatcher sends `ack`, `close` and `expire` to
Android devices only, as data-only FCM with a 60 s ttl; the relay client
forwards them and the relay router accepts them. Delivery events carry
`ringUntil`, and both payload builders write `ring_until`. `GET /v1/incidents`
takes `since`. New `src/retention/`: `pruneHistory` runs hourly on a relay or
hosted server, `historyCutoff` hides the same rows from the incidents list and
the poll route in between, and a self-hosted server does neither.

## 1.15.0 - 2026-09-20

### Added

- A `name` on every topic token (§3.1). `POST /v1/topics` takes `token_name`
  and returns it. `POST /v1/topics/{name}/tokens` takes `name` and returns it.
  `GET /v1/topics/{name}/tokens` returns `name` on every row.
- `PATCH /v1/topics/{name}/tokens/{token_id}` (§3.1). Renames one token. The
  body's `name` is required. An unknown topic or token id answers
  `404 {"error":"not found"}`.

### Changed

- A name is trimmed, then cut to 40 characters. A longer name is shortened, not
  refused.
- A name that is missing or empty after trimming becomes `Token N`, where N is
  the topic's current token count plus one. Existing tokens are backfilled the
  same way on migration, per topic, oldest first.

### Notes

- Names are not unique inside a topic. Deleting `Token 2` of three and minting
  another leaves two rows called `Token 3` until one is renamed. Holding
  uniqueness needs a per-topic counter that outlives deletes, which costs more
  state than the confusion is worth.
- Nothing here is required of a client. Every request that worked before still
  works and now gets a name it did not ask for.
- `DELETE /v1/topics/{name}/tokens/{token_id}` is unchanged, including the
  `409 {"error":"topic must retain a token"}` on the last one.

## 1.14.0 - 2026-09-20

### Added

- `POST /v1/account/join-token` (§3.7). Mints a fresh `aj_` for the account the
  device already belongs to, and retires the one before it. Until now `aj_` was
  minted once, at account creation, so every account made before 1.11.0 holds
  none and an account whose token was lost had no way back to one. There is no
  backfill, on purpose. Any device on the account may call it.
- A second sign-in identity on one account (§3.7). `POST /v1/account/link`
  takes `intent`, either `sign_in` or `link`. `link` attaches a new identity to
  the account the device already has, so one person can sign in with Apple on an
  iPhone and Google on an Android phone and reach the same account.
- Two outcomes on `POST /v1/account/link`: `linked`, and `already_linked` for a
  repeat of the same request.
- One error on `POST /v1/account/link`: `409 {"error":"identity has another
  account"}`, which is `link` aimed at an identity that is spoken for.

### Changed

- `account_identities.account_id` is no longer unique. One account may carry
  several identities. `user_id` stays the primary key, so one identity still
  points at exactly one account.
- `DELETE /v1/account` accepts any one of the account's identities, not a
  particular one, and its erase now covers every identity on the account with
  their sessions and provider tokens.
- The `409 {"error":"account has another identity"}` case narrows. It is the
  shared-handset case only, which is `intent: "sign_in"` against an account that
  is already claimed.

### Not changed, with one exception

- A client that never sends `intent` behaves as it did in 1.12.0 everywhere
  except one case: signing in again with the identity that already points at
  this device's own account used to answer `claimed` and now answers
  `already_linked`. Both mean signed in and nothing moved. A client that reads
  an unknown outcome as success is unaffected; one that switches on the string
  needs the case.
- `linked` is `link` only. `already_linked` is reachable under either intent,
  because a retry after a dropped reply has to be safe on both.
- `link` against an account that holds no identity yet answers `claimed`. No
  screen reaches it, and a client that sends it anyway gets the sensible answer
  rather than an error.
- Nothing reads a join token back. The server keeps a hash, not the token, so
  the mint reply is the only place the value appears.

## 1.13.0 - 2026-09-17

### Added

- Account deletion (§3.7). `DELETE /v1/account` erases the device's account and
  everything under it. `dv_` alone deletes an account with no identity; an
  account with an identity needs `identity_token` too. An `open` incident
  answers 409. Answers `501` in `selfhosted` mode like the rest of §3.7.
- `critalarm account delete <acc_id>` and `--email <address>` (§4.4), the same
  erase for a request that arrives by email.

## 1.12.0 - 2026-09-17

### Added

- Sign-in (§3.7). `POST /v1/account/link` attaches an identity, and answers 409
  with the choice when the person has to decide. `POST /v1/account/merge` folds
  the device's account into the identity's. `POST /v1/account/switch` starts
  fresh instead. Identities are Sign in with Apple and Google.
- All three answer `501` in `selfhosted` mode, and are mounted there only to
  refuse, so a client can tell "this server does not do sign-in" apart from a
  wrong path.

### Changed

- `app_user_id` on the RevenueCat webhook is a lookup, not the `account_id`
  (§4.3). An account may hold several, tier is the highest live entitlement
  across them, repeat and out-of-order events must not apply, and no
  payment-problem event may lower a tier.
- Signing in is the documented recovery path for a lost device token (§4.2),
  replacing the support path.
- The accounts paragraph in §4.2 no longer says there is no sign-up screen, and
  no longer claims sign-in is one column on the account row.

### Not added, on purpose

- No sign-out route. Signing out is `DELETE /relay/v1/devices/{device_id}` plus
  a fresh registration, both of which already exist as of 1.11.0. Any other
  shape bricks the handset: clearing `dv_` while keeping `device_id` is a
  permanent 401, and keeping the token is not a sign-out at all.

### Why

Crit Alarm's anonymous account was always a real account that happened to lack a
human. So sign-in attaches an identity to an account that exists, and the common
path moves no data at all. Writing it the other way round, as "sign-in creates an
account and the device's data migrates into it", is the expensive reading and it
is the one the old §4.2 wording implied.

Two branches carry the real risk and both are written down as requirements rather
than left to an implementer. A merge is refused while either side has a live
incident, because ending somebody's alarm to tidy an account is the wrong trade.
And "start fresh" must revoke the abandoned account's publish tokens, or answer
410 on publish to a tombstoned account, because publishing authenticates on the
topic token alone: otherwise a webhook keeps succeeding, incidents keep opening,
and there is no device left to ring.

Two cases stay undefined and must answer 409: signing in on a handset whose
account another identity already claimed, and signing up with an identity that
exists elsewhere. Both decide whose data wins, and a unique constraint is not
allowed to decide that at 500.

## 1.11.0 - 2026-09-17

### Added

- `aj_`, the account join token (§4.1, §4.2). Minted when an account is created
  and returned once as `account_join_token`. Presented as a bearer on
  `POST /relay/v1/devices`, it attaches a new `device_id` to that account
  instead of creating a new one.
- `DELETE /relay/v1/devices/{device_id}` (§4.2). Removes a device row, its push
  tokens and its subscriptions. Never removes the account.

### Changed

- `caps.devices` on `free` goes from 1 to 5, the same as `relay` and `hosted`
  (§4.2).
- The iOS row of the device storage table splits in two (§4.2). The account item
  syncs through iCloud Keychain; the device item does not.
- `mode` is a setting the operator writes down, inferred only when it is absent
  (§3.4).
- Written down: a self-hosted server has no caps, no tiers and no billing, and
  that is permanent (§4.2).

### Why

The device cap never stopped a second handset. It stopped a second handset from
joining the same account, and that handset went on working under an account of
its own. Because `p4_daily` is counted per account, the cap paid a heavy user to
split in two and collect twice the quota. Raising free to 5 removes both.

The Keychain split fixes a live bug. One synced item holds `device_id` and its
token, so an iPad on the same Apple ID restores the iPhone's `device_id` and both
handsets land on one `devices` row. Each registration overwrites the other's push
token, and only the handset that registered last rings. Splitting the item needs a
way for the second handset to join the account it can see, which is `aj_`, and a
way to retire the shared row, which is the delete.

`mode` was inferred from whether push credentials existed, so "self-hosted" meant
"cannot send a push at all". An operator who self-hosts with their own APNs key
was inferred as `relay`, which mounted anonymous accounts, the RevenueCat webhook
and paid caps on their own box. Making it explicit fixes that, and writing down
that self-hosting never costs a self-hoster anything removes the reason the
distinction was load-bearing in the first place.

Additive except `caps.devices`, which only widens what a client may do, and the
iOS storage rows, which describe app behaviour rather than a wire format. No
client change is required to keep working.

## 1.10.0 - 2026-09-17

### Added

- `GET /v1/topics/{name}/tokens` lists a topic's tokens as `token_id` and
  `created_at`, oldest first (§3.1). It never returns a token value: the server
  keeps a SHA-256 hash of each token, not the token itself.

### Why

`DELETE /v1/topics/{name}/tokens/{token_id}` has been in the contract since
1.5.0, but a `token_id` was only ever handed out by topic creation and by
`POST /v1/topics/{name}/tokens`, each of which returns it once. A client that
did not save it at that moment had no way to name a token again, so revoking
was unreachable in practice. The app is about to show a topic's tokens and let
one be revoked, and this is the read it needs.

Additive. No existing route, field or status changed.

## 1.9.0 - 2026-09-17

### Added

- `limit` on `GET /v1/incidents` has a written default (20) and a maximum (200),
  and the server now holds to both (§3.2).

The default was real but undocumented. `list()` read `filter.limit ?? 20` and
the route read `limit === undefined ? 20 : Number(limit)`, so a client that left
the parameter off got 20 rows while believing it had asked for everything. The
app did exactly that: it dropped `limit` from the query when a tier's
`history_incidents` cap was `null`, which is every paid tier. So History on a
paid plan showed 20 incidents, and `"history_incidents": null` meaning "no
limit" was never true through this endpoint.

There was also no ceiling. The route checked the value was a whole number of at
least 1 and passed it to SQL `LIMIT ?`, so `limit=99999999` was a question the
server would try to answer.

Now: absent means 20, above 200 gives 200, and below 1 or non-numeric still
answers `400 {"error":"invalid request"}`. Clamping rather than rejecting keeps
existing clients working.

No paging in v1, so 200 is the most one call can return. A cursor is the next
step and is not in this version. Until it lands, a client cannot read further
back than 200 incidents, and the contract says so rather than leaving clients
to find out.

Clients should send `limit` explicitly on every call. `caps.history_incidents`
is what a tier may show; it is not sent to the server and does not change what
this endpoint returns.

## 1.8.0 - 2026-09-16

### Fixed

- `critical_topics` no longer counts ordinary topics. Subscribing is no longer
  a cap point (§4.2, §7).

The contract said two different things. The prose read "`critical_topics` counts
topics with the critical switch on. Not subscriptions, not topics in total." The
enforcement table right below it listed a third place, the subscribe endpoint,
tripping when "the new subscription would be the account's `n+1`th distinct
topic". That row counted every topic, critical or not.

The server implemented the table. `subscribeDevice` counted
`COUNT(DISTINCT topic_hash)` across the account's subscriptions and compared it
to `critical_topics`. On the free tier that cap is 2, so creating a third topic
of any kind answered `429 {"error":"cap","cap":"critical_topics"}`, even with
the critical switch off. The app creates a topic and then subscribes its own
device to it, so users saw "Critical topics limit reached" on a plain topic.

The prose wins. The cap counts topics with the switch on, and it is enforced in
two places: creating a topic with `critical: true`, and patching `critical` from
false to true. `POST /relay/v1/devices/{id}/subscriptions` no longer answers
429.

Nothing gets past the cap. A topic is counted when it is created or when its
switch is flipped on, and a subscription cannot change either of those.

Clients lose an error response they could receive. A client that handled 429 on
subscribe keeps compiling; that branch stops being reachable.

## 1.7.0 - 2026-09-16

### Added

- `"content-available": 1` in the iOS payload on a critical topic (§5.1).

The iOS app schedules the AlarmKit alarm from its background-push handler.
iOS only calls that handler when the push carries `content-available`. Without
it the phone showed a notification, played `alarm.caf`, and no alarm ever rang.

It goes out on exactly the same pushes as the sound: priority 5, `critical` on,
with an incident id. Quieter pushes stay asleep, because waking the app costs
battery and Apple throttles background pushes.

Additive. No field changed or went away. FCM is untouched.

## 1.6.0 - 2026-09-16

Apple Critical Alerts is gone. Apple turned the entitlement down, and APNs
rejects a critical payload from an app that does not hold it, so every iOS
alert the server sent was failing.

Behaviour change, in §5.1:

- The APNs alert payload now sends `"sound": "alarm.caf"` and
  `"interruption-level": "time-sensitive"`. It used to send
  `"sound": { "critical": 1, "name": "alarm.caf", "volume": 1.0 }` and
  `"interruption-level": "critical"`. There is no flag. If Apple ever approves
  the entitlement, putting it back is its own change.
- When the sound is attached did not change: a priority-5 message on a topic
  with the `critical` switch on, opening or joining an incident. Only the shape
  of the value changed, from a critical sound object to a plain string.

Wording, in §3.1:

- The `critical` default of `false` was explained as an Apple entitlement
  commitment. That reason no longer holds. The default is unchanged, and it is
  now explained for what it is: a topic that rings has to be switched on
  deliberately.

Nothing else moved. The priority ladder, the per-topic `critical` switch,
incidents, and `caps.critical_topics` behave exactly as they did in 1.5.0. The
switch still decides whether a priority-5 message opens an incident and whether
Android rings through with a full-screen intent.

## 1.5.0 - 2026-09-15

What a route by route audit of a running dev server turned up. Two behaviour
changes, one product decision written down, and a batch of documentation
catching up with behaviour that was already right.

Behaviour changes, both in §3.1:

- `POST /v1/topics` with a name the account already owns now answers
  `409 {"code":40901,"http":409,"error":"topic already exists"}`. It used to let
  the unique-constraint error escape as a `500` with a `text/plain` body. A
  client retrying after a dropped `201` is the ordinary way to hit this.
- `POST /v1/topics` returns `token_id` next to `token`, and
  `POST /v1/topics/{name}/tokens` documents the `token_id` it already returned.
  `DELETE /v1/topics/{name}/tokens/{token_id}` is keyed on that id, so a token
  handed out without one could never be revoked, and the creation token is the
  one that actually ships to a monitoring tool. This also makes the
  "topic must retain a token" `409` reachable; it was dead code.

Product decision, §4.2:

- `caps.critical_topics` counts topics with the critical switch on, not
  subscriptions and not topics in total. It is enforced when a topic is created
  critical, when a `PATCH` flips the switch on, and on the account's `n+1`th
  distinct subscription. Turning a switch off or deleting a critical topic frees
  a slot at once. Previously only the subscription path enforced it, so an
  account could own any number of critical topics.

Documentation catching up, no behaviour change:

- §4.1: the relay push `kind` enum gains `p5`, which the server already emits
  for a priority-5 message on a topic whose switch is off. §4.4 already named it.
- §3.6: `GET /v1/health` is written down. It was live and undocumented.
- §1.6: the message object lists `click` and `markdown`, both of which the
  server already echoes when the publish sets them.
- §1.6: ids are a prefix plus a UUID. The short ids in the examples are for
  readability; a client must not size a column or a regex to them.
- §1.8: adds the `40901` code, states the publish rate limit as 30 requests per
  60 seconds per IP, and tables the plain `{"error":"..."}` bodies that carry no
  numeric code.
- §2: tables what `since` accepts and where each boundary falls. A message id
  and a unix timestamp are exclusive; a duration and the default 12 hour window
  are inclusive. An unknown message id answers `200` with an empty body.
- §3.1: out of range numbers on `PATCH` are ignored, leaving the stored value
  unchanged, and still answer `200`.

## 1.4.0 - 2026-09-15

Closes the two gaps the app wiring pass found, puts real numbers on the caps,
adds one route for the dashboard, and corrects the Android identity storage rule.
A self-hosted server that ignores the relay is unaffected by everything except
§2 and §3.5.

- §2: `GET /{topic}/json?poll=1` now accepts a management credential (`ad_` in
  `selfhosted`, `dv_` in `relay` and `hosted`) as well as a `tk_` publish token.
  A management credential reaches every topic its owner can see through
  `GET /v1/topics` and nothing else; a topic it does not own answers `404`.
  Without this the app could not read its own priority 1 to 3 history, because a
  topic token is shown once on creation and then goes out to a monitoring tool.
- §3.5: added `POST /v1/topics/{name}/send` taking `{title, message, priority,
  tags}` and publishing through the §1 path, so every §1.7 priority rule applies
  unchanged. It takes the management credential, which lets a dashboard send to a
  topic without ever holding a `tk_`. `message` is required, `priority` defaults
  to `3`.
- §4.2: `caps` gains `history_incidents` and `history_days`. Both are display
  caps the app enforces by trimming the list it shows. A self-hosted server is
  never sent a tier and never deletes anything because of a cap.
- §4.2: caps carry real per-tier numbers instead of one conservative row for
  every tier. `free` is 1 device, 2 critical topics, 50 priority-4 pushes a day,
  20 incidents and 7 days of history. `relay` and `hosted` are 5 devices,
  unlimited critical topics, 1000 a day and 90 days. `null` means no limit and
  must never be read as zero. No tier caps the alarm.
- §4.2: ring until acked gets no cap field. The app offers the "no limit" option
  when `tier != "free"`, and the ring ceiling stays the server's `max_ring_s`.
- §4.2: registering a `device_id` the server already knows is now defined.
  With a valid `dv_` for that device it answers `200` and omits `device_token`,
  doing the same work as the `PATCH`. Without one it answers `401` and mints
  nothing. The `device_token` field is absent on that path, never an empty
  string, which a client must not store.
- §4.2: the Android half of the identity storage rule is corrected. 1.3.0 asked
  for Keystore-backed storage with auto-backup on, which cannot work: uninstall
  destroys the Keystore key while backup restores the encrypted blob, so the
  restored bytes have no key to decrypt them. Android now stores `device_id` and
  `device_token` in `SharedPreferences` with `android:allowBackup="true"`. iOS is
  unchanged. The rule that matters is stated plainly: the token lives in the same
  place as the id with the same lifetime, because an id that outlives its token
  locks the phone out for good.

## 1.3.0 - 2026-09-13

Added an internal counter read for the relay operator. No public route changed,
and a self-hosted server is unaffected.

- §4.4: added `GET /relay/v1/internal/stats`, authorized by a bearer token from
  the `STATS_KEY` environment variable. Returns lifetime `totals`,
  `servers_total`, `devices_active_7d` and the last 30 days as rows. Answers
  `401` without the key and `404` in self-hosted mode or when `STATS_KEY` is
  unset. Never cached, and it carries no topic names, message text or account
  ids.
- §4.4: `?by=key` adds a per relay key breakdown for abuse review.
- §4.4: counters are written on the event, never worked out on read. Rows are
  keyed by `(day, relay_key, metric)` over the four metrics
  `pushes_delivered`, `alarms_rung`, `acks` and `incidents_opened`. A push the
  provider refused is not counted, a `reopen` counts as an alarm but not as a
  new incident, and work a relay does for its own hosted accounts is stored
  under the key `local`.
- §4.4: added `critalarm stats zero-key <relay_key>`, which drops an abusive key
  out of every total and keeps its rows.

## 1.2.0 - 2026-09-13

A device now has a list of push tokens instead of one, so iOS Live Activities
can be started, updated and ended. No existing route changed.

- §4.2: added `POST /relay/v1/devices/{device_id}/tokens` with a `kind` of
  `apns`, `fcm`, `la_start` or `la_update`. Posting the same `kind` and
  `activity_id` again replaces the stored token.
- §4.2: added `DELETE /relay/v1/devices/{device_id}/tokens/{kind}` and
  `DELETE /relay/v1/devices/{device_id}/tokens/{kind}/{activity_id}`.
- §4.2: `POST /relay/v1/devices` and `PATCH /relay/v1/devices/{device_id}` still
  take `push_token`. The server stores it as kind `apns` on iOS and kind `fcm`
  on Android, so an app that never calls `/tokens` is unaffected.
- §5.3: added the Live Activity APNs payloads. Start carries
  `attributes-type: CritAlarmIncidentAttributes` and `attributes`; update and
  end carry `content-state`, and end carries `dismissal-date`.

## 1.1.0 - 2026-09-10

Reconciled the contract with the ntfy identity research and PRD §6.7, §6.9 and
§7. Nothing else in the repo depended on it yet, so nothing broke.

- §3: `/v1/` authorization is scoped by server mode. The admin token `ad_` is
  self-hosted only. Relay and hosted mode use the device token `dv_`, which
  reaches only its own account. A topic owned by another account answers `404`,
  not `403`, so the token cannot be used to probe topic names.
- §4.2: device registration returns a device token `dv_`, once. Every later
  device call needs it. Before this, registration and the subscription routes
  had no authorization at all.
- §4.2: added `PATCH /relay/v1/devices/{device_id}` so a device can refresh its
  push token without re-registering.
- §4.2: registration creates an anonymous account and returns `account_id`. No
  sign-up screen, and many devices per account, which PRD §6.9 already required.
- §4.2: caps are counted per account, not per device. Registration over
  `caps.devices` answers `429` and issues no token.
- §4.2: `device_id` must live in the iOS Keychain or Android Keystore so it
  survives a reinstall.
- §4.3: RevenueCat `app_user_id` is the `account_id`, was the `device_id`.

Tier names are unchanged: `free`, `relay`, `hosted`, per PRD §7.

## 1.0.0 - 2026-09-10

First draft of the contract.
