# Changelog

Versions here are the API contract's versions (`docs/api.md`), not the server
binary's. The binary's version is in `package.json`.

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
