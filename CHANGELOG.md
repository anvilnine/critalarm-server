# Changelog

Versions here are the API contract's versions (`docs/api.md`), not the server
binary's. The binary's version is in `package.json`.

## 1.2.0 — 2026-09-13

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

## 1.1.0 — 2026-09-10

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

## 1.0.0 — 2026-09-10

First draft of the contract.
