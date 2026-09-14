# Changelog

Versions here are the API contract's versions (`docs/api.md`), not the server
binary's. The binary's version is in `package.json`.

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
