# Crit Alarm Server — API Contract

**Version:** 1.2.0
**Status:** draft, 2026-09-13. Lives in `critalarm-server/docs/api.md`. The app's client code and tests pin to this file. Changes here are versioned changes.

**1.2.0** gives a device a list of push tokens instead of one. iOS Live Activities need two extra tokens per device: a push-to-start token and one update token per running activity. §4.2 gains `POST` and `DELETE /relay/v1/devices/{device_id}/tokens`, and §5.3 defines the Live Activity APNs payloads. `push_token` on registration and on `PATCH` still works and still means the alarm token.

**1.1.0** reconciles §3, §4.2 and §4.3 with `planning/research/identity.md` and PRD §6.7 and §6.9: device registration now issues a device token and returns an account id, `/v1/` authorization is scoped by server mode, and caps are counted per account instead of per device. Tier names are unchanged.

Two surfaces:

1. **ntfy-compatible publish + poll.** Copied from ntfy's docs, subset only. Anything ntfy accepts that is not listed here is accepted and ignored, never rejected.
2. **Crit Alarm API** under `/v1/`. Everything ntfy does not have: topics, tokens, incidents, ack.

Base URL is the server's `base-url` config. All examples use `https://alerts.example.com`.

---

## 1. Publish (ntfy-compatible)

### 1.1 Endpoint

```
POST /{topic}
PUT  /{topic}
```

Body is the message text. Empty body publishes the message `triggered`, as ntfy does.

Topic names: `[-_A-Za-z0-9]{1,64}`. Anything else → `400`.

### 1.2 Auth

Required. No public topics. Any one of:

```
Authorization: Bearer tk_xxxxxxxxxxxx
Authorization: Basic base64(anything:tk_xxxxxxxxxxxx)
?auth=<base64 of "Bearer tk_xxxxxxxxxxxx">      (ntfy's query-param form, for tools that cannot set headers)
```

Token must belong to `{topic}`. Wrong or missing → `401 {"code":40101,"http":401,"error":"unauthorized"}`.

### 1.3 Headers accepted

Header names are case-insensitive. Each has ntfy's aliases.

| Header | Aliases | Type | Default | Used for |
|---|---|---|---|---|
| `X-Title` | `Title`, `ti`, `t` | string | topic name | notification title |
| `X-Priority` | `Priority`, `prio`, `p` | `1`–`5` or `min`,`low`,`default`,`high`,`urgent`,`max` | `3` | delivery class; `5` opens an incident on a critical topic |
| `X-Tags` | `Tags`, `tag`, `ta` | comma list | — | stored, shown in app; emoji shortcodes rendered like ntfy |
| `X-Click` | `Click` | URL | — | opened on tap |
| `X-Markdown` | `Markdown`, `md` | `true`/`1`/`yes` | off | body rendered as markdown in app |

Priority name → number: `min`=1, `low`=2, `default`=3, `high`=4, `urgent`=5, `max`=5.

Also accepted via query string with the same short names: `?t=`, `?p=`, `?ta=`, `?m=` (message).

### 1.4 Headers accepted and ignored (v1)

`X-Actions`, `X-Attach`, `X-Filename`, `X-Icon`, `X-Email`, `X-Call`, `X-Delay`/`At`/`In`, `X-Template`, `X-Cache`, `X-Firebase`, `X-UnifiedPush`. Accepting them keeps existing ntfy integrations from erroring. Returning `200` for a delayed message that is not actually delayed is wrong, so `X-Delay` specifically returns `400 {"error":"scheduled delivery not supported"}`.

### 1.5 JSON publish

```
POST /
Content-Type: application/json
Authorization: Bearer tk_...

{
  "topic":    "prod",          // required
  "message":  "db01 is down",  // optional, default "triggered"
  "title":    "Uptime Kuma",   // optional
  "priority": 5,               // optional, 1-5, default 3
  "tags":     ["warning"],     // optional
  "click":    "https://...",   // optional
  "markdown": false            // optional
}
```

Unknown fields ignored. `actions`, `attach`, `delay`, `email`, `call` accepted and ignored except `delay` → `400`.

### 1.6 Response

```
200 OK
Content-Type: application/json

{
  "id":       "m_7f3k2p9q",
  "time":     1757462400,
  "expires":  1757505600,
  "event":    "message",
  "topic":    "prod",
  "title":    "Uptime Kuma",
  "message":  "db01 is down",
  "priority": 5,
  "tags":     ["warning"],
  "incident_id": "inc_9a8b7c"     // Crit Alarm extension. present only when an incident was opened or joined
}
```

Field set and order match ntfy's message object so ntfy client libraries parse it unchanged. `incident_id` is additive.

### 1.7 Behaviour by priority

| Priority | Topic `critical` | Result |
|---|---|---|
| 5 | on | Incident opened (or joined if one is open). Repeat loop starts. `incident_id` returned. |
| 5 | off | Stored. Forwarded as Time-Sensitive / high. No incident. |
| 4 | — | Stored. Forwarded as Time-Sensitive / high. |
| 1–3 | — | Stored. App polls. Not forwarded to relay. |

### 1.8 Errors

ntfy's shape:

```
{"code":40101,"http":401,"error":"unauthorized"}
{"code":40001,"http":400,"error":"invalid topic name"}
{"code":41301,"http":413,"error":"message too large"}      // body > 4096 bytes
{"code":42901,"http":429,"error":"rate limited"}
```

---

## 2. Poll (ntfy-compatible)

```
GET /{topic}/json?poll=1[&since=<message id | unix ts | duration like 10m | all>]
Authorization: Bearer tk_...
```

Returns newline-delimited JSON, one message object per line (shape as §1.6), oldest first. `since` omitted = last 12 hours. `poll=1` is required; streaming (`/json` without `poll`, `/sse`, `/ws`, `/raw`) is **not supported in v1** and returns `501`.

The app uses this for priority 1–3 history and for filling gaps after reconnect.

---

## 3. Crit Alarm API

All `/v1/` routes require a management credential. Which one depends on the server's `mode` (§3.4).

| Mode | Credential | What it reaches |
|---|---|---|
| `selfhosted` | admin token `ad_...` | the whole server. One operator, one server, no tenants. |
| `relay`, `hosted` | device token `dv_...` (§4.2) | only the account that device belongs to. |

```
Authorization: Bearer ad_xxxxxxxxxxxxxxxxxxxx     # selfhosted
Authorization: Bearer dv_xxxxxxxxxxxxxxxxxxxx     # relay, hosted
```

The admin token is generated on first boot, printed to the log, and retrievable with `critalarm token show`. It is the only credential the app holds for a self-hosted server. Rotating it: `critalarm token rotate`.

A hosted server never hands an app an admin token. One global credential shared by every client would expose every tenant's topics, so `ad_` is refused in `relay` and `hosted` mode and `dv_` is refused in `selfhosted` mode.

A device token reaches only rows owned by its account. A topic or incident belonging to another account answers `404`, never `403`, so the token cannot be used to probe which topic names exist.

Wrong, missing, or out of scope → `401`.

### 3.1 Topics

```
GET    /v1/topics
→ 200 [{ "name":"prod", "critical":true, "repeat_interval_s":30, "max_ring_s":1800, "desk_timer_s":600, "relay_content":"none", "created_at":... }]

POST   /v1/topics
  { "name":"prod" }
→ 201 { ...topic, "token":"tk_..." }        // token returned ONCE, on creation only

PATCH  /v1/topics/{name}
  { "critical":true, "repeat_interval_s":30, "max_ring_s":1800, "desk_timer_s":600 }
→ 200 { ...topic }

DELETE /v1/topics/{name}
→ 204

POST   /v1/topics/{name}/tokens
→ 201 { "token":"tk_..." }                  // additional token; returned once

DELETE /v1/topics/{name}/tokens/{token_id}
→ 204
```

`critical` defaults to `false` on creation. This default is an Apple entitlement commitment; do not change it.

`relay_content` is read-only here; it is server config.

### 3.2 Incidents

```
GET  /v1/incidents?limit=20[&state=open|acked|closed|expired][&topic=prod]
→ 200 [{ "id":"inc_9a8b7c", "topic":"prod", "state":"open",
          "opened_at":..., "acked_at":null, "closed_at":null, "last_message_at":...,
          "messages":[ { ...message object } ] }]

GET  /v1/incidents/{id}
→ 200 { ...incident }                       // used by iOS NSE to fetch title/body in relay-content: none

POST /v1/incidents/{id}/ack                 // stage 1, "I'm up"
→ 200 { ...incident, "state":"acked", "desk_timer_fires_at":... }
→ 409 if state is not open

POST /v1/incidents/{id}/close               // stage 2, "At my desk"
→ 200 { ...incident, "state":"closed" }
→ 409 if state is not acked
```

State machine:

```
open ──ack──▶ acked ──close──▶ closed
 │ ▲            │
 │ └── desk_timer expired (reopen)
 └── max_ring expired ──▶ expired
```

### 3.3 Test alarm

```
POST /v1/test?topic=prod
→ 200 { "incident_id": "..." }
```

Publishes a priority-5 message titled `Crit Alarm test` to the topic through the normal path. Exists so "Ring me now" is a single call. Requires the topic to be `critical: true`; otherwise `409 {"error":"topic is not critical"}`.

### 3.4 Server info

```
GET /v1/info                                 // no auth
→ 200 { "name":"critalarm", "version":"0.1.0", "base_url":"https://alerts.example.com",
        "relay_url":"https://relay.critalarm.app", "relay_content":"none",
        "mode":"selfhosted" | "relay" | "hosted" }
```

The app calls this first when a server URL is added, to validate the URL and read `base_url` for hash derivation.

---

## 4. Relay API

Only served when push credentials are configured (relay and hosted modes).

### 4.1 Server → relay

```
POST /relay/v1/push
Authorization: Bearer rk_...                 // relay key. issued anonymously on first call to POST /relay/v1/servers

{
  "topic_hash": "sha256hex",                 // sha256(base_url + "/" + topic)
  "incident_id": "inc_9a8b7c",               // null for priority-4 forwards
  "message_id": "m_7f3k2p9q",
  "priority": 5,
  "kind": "open" | "repeat" | "reopen" | "p4",
  "title": "...",                            // only when relay_content: full
  "body": "..."                              // only when relay_content: full
}
→ 202
→ 429 {"error":"cap", "cap":"critical_topics"|"devices"|"p4_daily"}
```

```
POST /relay/v1/servers
  { "base_url":"https://alerts.example.com", "version":"0.1.0" }
→ 201 { "relay_key":"rk_..." }
```

### 4.2 App → relay

```
POST /relay/v1/devices                                  // registration. no auth
  { "device_id":"dev_<uuid>", "platform":"ios"|"android", "push_token":"...", "app_version":"1.0.0" }
→ 201 { "device_token":"dv_...",                        // returned ONCE, on first registration only
        "account_id":"acc_...",
        "tier":"free"|"relay"|"hosted",
        "caps":{ "devices":1, "critical_topics":1, "p4_daily":50 } }

PATCH  /relay/v1/devices/{device_id}                     // re-register: new push token, new app version
  Authorization: Bearer dv_...
  { "push_token":"...", "app_version":"1.0.1" }
→ 200 { "account_id":"acc_...", "tier":"...", "caps":{...} }

POST   /relay/v1/devices/{device_id}/subscriptions
  Authorization: Bearer dv_...
  { "topic_hash":"sha256hex" }
→ 204
→ 429 {"error":"cap", "cap":"critical_topics"}

DELETE /relay/v1/devices/{device_id}/subscriptions/{topic_hash}
  Authorization: Bearer dv_...
→ 204

POST   /relay/v1/devices/{device_id}/tokens                 // add or replace one push token
  Authorization: Bearer dv_...
  { "kind":"apns"|"fcm"|"la_start"|"la_update",
    "token":"...",
    "activity_id":"...",                                    // required when kind is la_update, rejected otherwise
    "incident_id":"inc_9a8b7c" }                            // la_update only, optional
→ 204

DELETE /relay/v1/devices/{device_id}/tokens/{kind}          // drop every token of that kind
DELETE /relay/v1/devices/{device_id}/tokens/{kind}/{activity_id}
  Authorization: Bearer dv_...
→ 204
```

**A device has a list of tokens, not one.** `apns` and `fcm` are the alarm token, one per device, chosen by the device's platform. `la_start` is the iOS push-to-start token for Live Activities, one per device. `la_update` is the update token of one running Live Activity, so there is one per `activity_id`. Android has no Live Activity tokens.

`POST` is a replace, not an append. A second `POST` with the same `kind` and `activity_id` overwrites the stored token and its `incident_id`. Since `apns`, `fcm` and `la_start` have no `activity_id`, a device can only ever hold one of each.

**Backward compatible.** `POST /relay/v1/devices` and `PATCH /relay/v1/devices/{device_id}` still take `push_token` and still work unchanged. The server stores that token as kind `apns` on an iOS device and kind `fcm` on an Android one. An app that never calls `/tokens` behaves exactly as it did in 1.1.0 and gets alarm pushes with no Live Activity.

`incident_id` on an `la_update` token is how the server finds the right activity when an incident changes state. Without it the server can still start activities but cannot update or end them, so send it.

**Two secrets, two jobs.** `tk_` (§1.2) is a publish token. It goes to Uptime Kuma, a cron job, a CI pipeline, anywhere outside the user's control, and it can only publish to one topic. `dv_` is the device's own secret. It manages topics, subscriptions and incidents, and it never leaves the app. Never send `dv_` to an alerting source and never publish with it.

**Accounts.** Registration with an unknown `device_id` creates an anonymous account and links the device to it. There is no sign-up screen and no email on any tier. The account is the owner of topics, subscriptions, caps and billing; the device is one of possibly several handsets attached to it. PRD §6.9 requires many devices per account before teams ship, and PRD §7 caps the *number of devices*, which only an account can count. Adding sign-in later means filling in one column on the account row, with no migration of topics or tokens.

**Caps are per account, not per device.** `caps.devices` is how many handsets the account may register. `caps.critical_topics` and `caps.p4_daily` are counted across the whole account. A registration that would exceed `caps.devices` returns `429 {"error":"cap","cap":"devices"}` and issues no token.

**`device_id` must survive a reinstall.** The app generates it once and stores it where deleting the app does not: iOS Keychain with `kSecAttrAccessibleAfterFirstUnlock` and iCloud Keychain sync on, Android Keystore-backed storage with auto-backup on. A `device_id` kept in `UserDefaults` or `SharedPreferences` is lost on reinstall, which orphans the account, silently breaks every webhook the user configured, and detaches a live subscription from its purchase. Store `device_token` beside it.

Re-registering a known `device_id` without a valid `dv_` token returns `401`. It does not mint a second token. Recovery from a lost token is a support path, not an API call, in v1.

### 4.3 RevenueCat → relay

```
POST /webhooks/revenuecat
Authorization: Bearer <shared secret from RevenueCat dashboard>
```

Body is RevenueCat's webhook event. `app_user_id` is the **`account_id`**, which the app sets on the RevenueCat SDK right after registration. Updates `tier` on the account, so every device under it changes tier in one write.

Using `device_id` here would attach the purchase to a handset. A reinstall or a second handset would then leave the server with two records for one paying person and no way to join them.

---

## 5. Push payloads

### 5.1 APNs (iOS)

```
headers:
  apns-push-type:   alert
  apns-priority:    10
  apns-collapse-id: <incident_id>
  apns-expiration:  <now + max_ring_s>

payload (relay_content: none):
{
  "aps": {
    "alert": { "title": "Crit Alarm", "body": "Critical alert on prod — open to see details" },
    "sound": { "critical": 1, "name": "alarm.caf", "volume": 1.0 },     // only if entitlement + topic critical
    "interruption-level": "critical" | "time-sensitive",
    "mutable-content": 1,
    "category": "INCIDENT"
  },
  "incident_id": "inc_9a8b7c",
  "server": "https://alerts.example.com",
  "kind": "open"
}
```

`relay_content: full` puts the real title/body in `alert` and drops `mutable-content`.

Category `INCIDENT` registers one action: `ACK` ("I'm up"), which calls `POST /v1/incidents/{id}/ack`.

### 5.2 FCM (Android)

```
{
  "message": {
    "token": "...",
    "android": { "priority": "high", "collapse_key": "<incident_id>", "ttl": "<max_ring_s>s" },
    "data": {
      "incident_id": "inc_9a8b7c",
      "server": "https://alerts.example.com",
      "kind": "open",
      "priority": "5",
      "title": "...",                       // only when relay_content: full
      "body": "..."                         // only when relay_content: full
    }
  }
}
```

Data-only. The app builds the full-screen alarm notification itself.

### 5.3 Live Activity (iOS)

Live Activity pushes go to APNs on the Live Activity topic, which is the bundle
id with `.push-type.liveactivity` on the end. They are a second push, sent next
to the alarm push in §5.1, never instead of it. Android devices get none of this.

**Start.** Sent when an incident opens, to the device's `la_start` token.

```
headers:
  apns-topic:       <bundle_id>.push-type.liveactivity
  apns-push-type:   liveactivity
  apns-priority:    10

{
  "aps": {
    "timestamp": 1757740800,
    "event": "start",
    "attributes-type": "CritAlarmIncidentAttributes",
    "attributes": {
      "incident_id": "inc_9a8b7c",
      "topic": "prod",
      "server": "https://alerts.example.com"
    },
    "content-state": {
      "state": "open",
      "title": "Database down",
      "opened_at": 1757740800
    }
  }
}
```

**Update and end.** Sent when the incident is acknowledged, reopened, closed or
expired, to the `la_update` token registered for that incident. `event` is
`update` for `open` and `acked`, and `end` for `closed` and `expired`.

```
headers:
  apns-topic:       <bundle_id>.push-type.liveactivity
  apns-push-type:   liveactivity
  apns-priority:    10

{
  "aps": {
    "timestamp": 1757740860,
    "event": "update" | "end",
    "content-state": {
      "state": "open" | "acked" | "closed" | "expired",
      "title": "Database down",
      "opened_at": 1757740800
    },
    "dismissal-date": 1757740860        // end only. when iOS removes the activity
  }
}
```

`attributes-type` and `attributes` are start only. iOS rejects them on an
update. `content-state` carries the same three fields every time, so the widget
reads one shape whatever happened.

A device with no `la_start` token gets no activity and no error. A device whose
activity has no `la_update` token keeps the activity on screen until iOS times
it out, because the server has nothing to send the end to. Neither case blocks
or delays the alarm push.

---

## 6. Versioning

- `/v1/` routes: additive changes only. Breaking changes → `/v2/`.
- ntfy-compatible routes: track ntfy's documented behaviour. If ntfy changes its message object, follow it.
- `GET /v1/info.version` is semver. App refuses servers with a major version it does not know.
