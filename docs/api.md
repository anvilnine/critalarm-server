# Crit Alarm Server: API Contract

**Version:** 1.8.0
**Status:** draft, 2026-09-16. Lives in `critalarm-server/docs/api.md`. The app's client code and tests pin to this file. Changes here are versioned changes.

**1.8.0** fixes a contradiction in the `critical_topics` cap. The prose said the cap counts topics with the critical switch on; the enforcement table said a subscription counted against it once it was the account's n+1th distinct topic. The server implemented the table, so a device hit "critical topics limit reached" on its third ordinary topic. Subscribing does not change how many critical topics an account owns, so subscribe is no longer a cap point. `POST /relay/v1/devices/{id}/subscriptions` no longer answers 429.

**1.7.0** adds `"content-available": 1` to the iOS payload on a critical topic (§5.1). Without it iOS never wakes the app, and the app is the only thing that schedules the alarm, so the phone played a sound and never rang. Additive: no field changed or went away, and Android is untouched.

**1.6.0** drops Apple Critical Alerts. Apple turned the entitlement down, so every iOS alert now carries `"interruption-level": "time-sensitive"` and a plain `alarm.caf` sound (§5.1). This is a wire change: the server used to send a critical payload, and APNs was rejecting it. Nothing else moved. The priority ladder, the per-topic `critical` switch, incidents, and `caps.critical_topics` all behave exactly as they did in 1.5.0.

**1.5.0** is what a route by route audit of a running server turned up. Creating a topic that already exists answers `409` instead of crashing, and topic creation now returns a `token_id` so the token it hands you can be revoked (§3.1). `caps.critical_topics` says where it is counted and enforced (§4.2). The rest is documentation catching up with behaviour that was already correct: the relay `kind` enum gains `p5` (§4.1), `GET /v1/health` is written down (§3.6), §1.6 lists `click` and `markdown`, and §1.8, §2 and §3 name the error bodies, the rate limit and the `since` rules the server already applies.

**1.4.0** closes the two gaps the wiring pass found, gives caps real per-tier numbers, and adds one route for the dashboard. Poll now accepts the management credential, so the app can read priority 1 to 3 history without holding a topic token (§2). Re-registering a device that kept its `device_id` but lost its `dv_` token no longer locks it out (§4.2). `caps` gains `history_incidents` and `history_days` (§4.2). `POST /v1/topics/{name}/send` lets a dashboard publish without ever holding a `tk_` (§3.5). The Android half of the identity storage rule is corrected: Keystore with auto-backup on does not work (§4.2).

**1.3.0** adds `GET /relay/v1/internal/stats`, an internal counter read for the relay operator. Nothing public changed. §4.4 defines it.

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
| `X-Priority` | `Priority`, `prio`, `p` | `1`-`5` or `min`,`low`,`default`,`high`,`urgent`,`max` | `3` | delivery class; `5` opens an incident on a critical topic |
| `X-Tags` | `Tags`, `tag`, `ta` | comma list | - | stored, shown in app; emoji shortcodes rendered like ntfy |
| `X-Click` | `Click` | URL | - | opened on tap |
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
  "click":    "https://...",      // present only when the publish set it
  "markdown": true,               // present only when the publish set it
  "incident_id": "inc_9a8b7c"     // Crit Alarm extension. present only when an incident was opened or joined
}
```

Field set and order match ntfy's message object so ntfy client libraries parse it unchanged. `incident_id` is additive.

**Ids are opaque.** Every id is a prefix and a UUID: `m_`, `inc_`, `tok_`, `acc_`, `top_`, and the credential prefixes `tk_`, `dv_`, `ad_`, `rk_`. The short ids in these examples are for readability. Do not size a column, a buffer, or a regex to them; treat an id as a string of unbounded length.

### 1.7 Behaviour by priority

| Priority | Topic `critical` | Result |
|---|---|---|
| 5 | on | Incident opened (or joined if one is open). Repeat loop starts. `incident_id` returned. |
| 5 | off | Stored. Forwarded as Time-Sensitive / high. No incident. |
| 4 | - | Stored. Forwarded as Time-Sensitive / high. |
| 1-3 | - | Stored. App polls. Not forwarded to relay. |

### 1.8 Errors

ntfy's shape:

```
{"code":40101,"http":401,"error":"unauthorized"}
{"code":40001,"http":400,"error":"invalid topic name"}
{"code":40901,"http":409,"error":"topic already exists"}
{"code":41301,"http":413,"error":"message too large"}      // body > 4096 bytes
{"code":42901,"http":429,"error":"rate limited"}
```

Publishing is rate limited to **30 requests per 60 seconds per IP**. Over that returns `42901`. The window is a rolling 60 seconds, not a clock minute.

Errors outside ntfy's shape carry a plain `{"error":"..."}` and no numeric code. The ones a client will meet:

| Body | When |
|---|---|
| `{"error":"invalid priority"}` | priority outside 1-5 or an unknown name |
| `{"error":"invalid request"}` | a malformed body or an unknown enum value in a query filter |
| `{"error":"incident state conflict"}` | `409` from ack or close against the wrong state (§3.2) |
| `{"error":"scheduled delivery not supported"}` | `X-Delay`, `At`, `In`, or JSON `delay` (§1.4) |
| `{"error":"streaming not supported"}` | `501` from `/json` without `poll=1`, `/sse`, `/ws`, `/raw` (§2) |
| `{"error":"not found"}` | `404`, including a row owned by another account |
| `{"error":"cap","cap":"..."}` | `429` from a cap (§4.2) |

---

## 2. Poll (ntfy-compatible)

```
GET /{topic}/json?poll=1[&since=<message id | unix ts | duration like 10m | all>]
Authorization: Bearer tk_...     # a publish token for this topic
Authorization: Bearer ad_...     # or the management credential, selfhosted
Authorization: Bearer dv_...     # or the management credential, relay and hosted
```

Returns newline-delimited JSON, one message object per line (shape as §1.6), oldest first. `since` omitted = last 12 hours. `poll=1` is required; streaming (`/json` without `poll`, `/sse`, `/ws`, `/raw`) is **not supported in v1** and returns `501`.

The app uses this for priority 1 to 3 history and for filling gaps after reconnect.

**Two credentials reach this route.** A `tk_` publish token reaches the one topic it was issued for, which is what an alerting source holds. A management credential (§3, `ad_` in `selfhosted`, `dv_` in `relay` and `hosted`) reaches every topic its owner can already see through `GET /v1/topics`, and reaches nothing else. The app holds a management credential and never holds a `tk_`, because a topic token is shown once on creation and then goes out to a monitoring tool. Without this, the app cannot read its own low-priority history.

Scoping is the same as §3. A management credential that does not own the topic answers `404`, never `403`, so it cannot be used to probe which topic names exist. An unknown or out of scope token answers `401`.

**What `since` accepts, and where the boundary falls.**

| Form | Example | Boundary |
|---|---|---|
| message id | `since=m_7f3k2p9q` | exclusive. That message is not returned. An id the server does not know answers `200` with an empty body. |
| unix timestamp | `since=1757462400` | exclusive |
| duration | `since=10m` | inclusive |
| `all` | `since=all` | everything the server still holds |
| omitted | | inclusive, last 12 hours |

The split between exclusive and inclusive is deliberate: paging with the last id you saw must not hand you that message twice, while a duration is a window you asked to see all of.

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
  { "name":"prod", "critical":false }       // critical optional, defaults false
→ 201 { ...topic, "token":"tk_...", "token_id":"tok_..." }   // token returned ONCE, on creation only
→ 409 {"code":40901,"http":409,"error":"topic already exists"}
→ 429 {"error":"cap","cap":"critical_topics"}                // only when critical is true

PATCH  /v1/topics/{name}
  { "critical":true, "repeat_interval_s":30, "max_ring_s":1800, "desk_timer_s":600 }
→ 200 { ...topic }
→ 429 {"error":"cap","cap":"critical_topics"}                // only when flipping critical on

DELETE /v1/topics/{name}
→ 204

POST   /v1/topics/{name}/tokens
→ 201 { "token":"tk_...", "token_id":"tok_..." }   // additional token; token returned once

DELETE /v1/topics/{name}/tokens/{token_id}
→ 204
→ 409 {"error":"topic must retain a token"}        // refusing to delete the last one
```

`critical` defaults to `false` on creation. A topic that rings has to be switched on deliberately, so the default stays `false`.

`relay_content` is read-only here; it is server config.

**Every token has a `token_id`, including the one creation hands back.** `DELETE /v1/topics/{name}/tokens/{token_id}` is keyed on it, so a token returned without one could never be revoked, and the creation token is the one that actually ships out to a monitoring tool. A topic always keeps at least one token; deleting the last one answers `409`.

**Creating a topic that already exists answers `409`, not `500`.** Names are unique per account. A client that retries after a dropped `201` will hit this, so it must be a clean, JSON answer.

**Out of range numbers on `PATCH` are ignored, not rejected.** A value outside what the server accepts leaves the stored value unchanged and still answers `200` with the current topic. Read the response rather than assuming the write landed.

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

### 3.5 Send to a topic

```
POST /v1/topics/{name}/send
  { "title":"Backup failed", "message":"nas-backup exited 1", "priority":5, "tags":["warning","skull"] }
→ 200 { "id":"m_7f3k2p9q", "incident_id":"inc_9a8b7c" }    // incident_id null unless an incident opened
```

Publishes to the topic through the same path as §1, so every §1.7 priority rule applies unchanged. A priority-5 post to a topic with `critical: true` opens or joins an incident and returns its id, exactly as `POST /{topic}` does.

`title`, `priority` and `tags` are optional. `message` is required. `priority` defaults to `3`. Values and meanings are §1.3's.

**Why this exists.** A topic token is shown once, on creation, and then goes out to a monitoring tool. The dashboard and the app never hold one, so without this route they cannot send to a topic they own. This route takes the management credential instead, which the app already has.

Same scoping as the rest of §3: a topic the credential does not own answers `404`. A topic name that exists but is out of scope is indistinguishable from one that does not exist.

This route does not mint, return, or require a `tk_`. It never appears in a publish example for an alerting source, which must keep using §1 with its own topic token.

### 3.6 Health

```
GET /v1/health                               // no auth
→ 200 { "ok": true }
```

For a load balancer, a container health check, or an uptime probe. It touches no database row and says nothing about the server beyond the process being up. Use `GET /v1/info` (§3.4) for anything a client needs to make a decision about.

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
  "kind": "open" | "repeat" | "reopen" | "p4" | "p5",   // p5: priority 5 on a topic whose switch is off
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
        "caps":{ "devices":1, "critical_topics":2, "p4_daily":50,
                 "history_incidents":20, "history_days":7 } }

PATCH  /relay/v1/devices/{device_id}                     // re-register: new push token, new app version
  Authorization: Bearer dv_...
  { "push_token":"...", "app_version":"1.0.1" }
→ 200 { "account_id":"acc_...", "tier":"...", "caps":{...} }

POST   /relay/v1/devices/{device_id}/subscriptions
  Authorization: Bearer dv_...
  { "topic_hash":"sha256hex" }
→ 204

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

**`critical_topics` counts topics with the critical switch on.** Not subscriptions, not topics in total. It is enforced in two places, each answering `429 {"error":"cap","cap":"critical_topics"}`:

| Where | When |
|---|---|
| `POST /v1/topics` (§3.1) | the new topic is created with `critical: true` |
| `PATCH /v1/topics/{name}` (§3.1) | the patch flips `critical` from `false` to `true` |

Subscribing is not one of them. A subscription does not change how many topics the account
has the switch on for, so counting them there contradicted the rule above. A topic is already
capped when it is created or when its switch is flipped on, so there is no way around the cap.

Turning a topic's switch off frees a slot at once. Deleting a critical topic frees one too.

The app shows this as "N of M topics used", where N is the count of the account's topics with the switch on and M is `caps.critical_topics`. Both numbers come from data the app already holds, so it never hardcodes either.

**The numbers.**

| Cap | `free` | `relay` | `hosted` |
|---|---|---|---|
| `devices` | 1 | 5 | 5 |
| `critical_topics` | 2 | `null` | `null` |
| `p4_daily` | 50 | 1000 | 1000 |
| `history_incidents` | 20 | `null` | `null` |
| `history_days` | 7 | 90 | 90 |

`null` means no limit. A client that does not understand `null` must treat it as no limit, never as zero.

These are launch guesses, set by gut and adjusted from relay metrics after 30 days. One rule is not a guess and never changes: **no tier caps the alarm.** There is no cap on incidents opened, on repeats, or on how long a critical alarm rings. Plans cap the things a team needs, not the thing one person came for.

**`history_incidents` and `history_days` are display caps, enforced by the app.** The relay returns them; the app trims the list it shows. A self-hosted server keeps whatever it keeps, is never sent a tier, and never deletes anything because of a cap. The relay is the only place a plan exists, and the app mirrors it for the UI.

**Ring until acked has no cap field.** The app offers the "no limit" option when `tier != "free"` and disables it otherwise. The ring ceiling itself is the server's `max_ring_s` config, which the account holder owns.

**`device_id` must survive a reinstall.** The app generates it once and stores it where deleting the app does not. Losing it orphans the account, silently breaks every webhook the user configured, and detaches a live subscription from its purchase.

| Platform | Where | Survives |
|---|---|---|
| iOS | Keychain, `kSecAttrAccessibleAfterFirstUnlock`, iCloud Keychain sync on | reinstall, and moving to a new iPhone |
| Android | `SharedPreferences` with `android:allowBackup="true"` | reinstall, when the user has Android backup on |

**Store `device_token` in the same place, with the same lifetime.** This is the rule that matters, and it is easy to get wrong in a way that bricks a phone. If the `device_id` outlives the `dv_` token, the app re-registers an id the server already knows, cannot present the token the server demands, and is locked out for good. Whatever holds one must hold the other, so that they are both there or both gone.

Android does not use Keystore-backed storage here, which is a change from 1.3.0 and deliberate. Keystore keys are destroyed on uninstall while Android's auto-backup restores the encrypted blob, so the restored bytes have no key left to decrypt them and the read throws. Encrypting the token at rest is not worth trading for a credential that cannot be read back. App-private storage is not readable on an unrooted device, and the token is scoped to one account's alerts.

**Registering a `device_id` the server already knows.**

| Request | Result |
|---|---|
| valid `dv_` for that device | `200`, push token and `app_version` updated, `account_id`, `tier` and `caps` returned. No `device_token` field, because the caller already holds it. |
| no token, wrong token, or another device's token | `401`. No second token is minted. |

The `200` case is the same work as `PATCH /relay/v1/devices/{device_id}`, and an app that already holds a token should send the `PATCH`. `POST` accepts it so that a retry after a dropped response does the right thing instead of failing.

A client must never read `device_token` as an empty string and store it. The field is absent on this path, not blank.

Recovery from a genuinely lost token is a support path, not an API call, in v1. The storage rule above is what keeps that path close to unused.

### 4.3 RevenueCat → relay

```
POST /webhooks/revenuecat
Authorization: Bearer <shared secret from RevenueCat dashboard>
```

Body is RevenueCat's webhook event. `app_user_id` is the **`account_id`**, which the app sets on the RevenueCat SDK right after registration. Updates `tier` on the account, so every device under it changes tier in one write.

Using `device_id` here would attach the purchase to a handset. A reinstall or a second handset would then leave the server with two records for one paying person and no way to join them.

### 4.4 Internal stats

```
GET /relay/v1/internal/stats
GET /relay/v1/internal/stats?by=key
Authorization: Bearer <STATS_KEY>
→ 200 (Cache-Control: no-store)
→ 400 {"error":"invalid request"}          // ?by= anything other than key
→ 401 {"error":"unauthorized"}             // missing or wrong key
→ 404 {"error":"Not found"}                // self-hosted mode, or no STATS_KEY set
```

Not public. It is for the operator of a relay, not for apps and not for
servers. It is never cached, it carries no topic names, no message text and no
account ids, and it is not served at all by a self-hosted server. The key comes
from the `STATS_KEY` environment variable. There is no other way to reach it,
and an unset `STATS_KEY` leaves the route unmounted.

**Body.**

```json
{
  "totals": { "pushes_delivered": 41230, "alarms_rung": 8801, "acks": 8120, "incidents_opened": 8611 },
  "servers_total": 214,
  "devices_active_7d": 963,
  "days": [
    { "day": "2026-09-13", "pushes_delivered": 612, "alarms_rung": 130, "acks": 121, "incidents_opened": 128 }
  ]
}
```

`totals` is lifetime. `days` is the last 30 days, newest first, UTC, and only
days that have counts appear. `servers_total` is how many distinct relay keys
have been issued. `devices_active_7d` is how many devices have a `last_seen`
inside the last 7 days.

**Counters are written when something happens, never worked out on read.** Each
row is keyed by `(day, relay_key, metric)`, where `day` is a UTC `YYYY-MM-DD`
and `relay_key` is the sha256 hash of the relay key. Work a relay does for its
own hosted accounts has no relay key and is stored under the literal
`local`.

| Metric | Incremented when |
|---|---|
| `pushes_delivered` | One alarm push that APNs or FCM accepted with a 2xx. A refused push, a 410 or a provider timeout adds nothing. Live Activity pushes are not counted. |
| `alarms_rung` | An `open` or a `reopen` forwarded through `POST /relay/v1/push`, or opened locally. `repeat`, `p4`, `p5`, `close` and `expire` are not alarms. |
| `acks` | An incident acknowledged through `POST /v1/incidents/{id}/ack`. |
| `incidents_opened` | An `open`. A `reopen` is a new alarm on an incident that already exists, so it is not a new incident. |

**`?by=key`** adds a `keys` array for abuse review, one entry per relay key,
busiest first:

```json
{
  "keys": [
    { "relay_key": "sha256hex", "zeroed": false,
      "totals": { "pushes_delivered": 900, "alarms_rung": 300, "acks": 280, "incidents_opened": 295 },
      "days": [ { "day": "2026-09-13", "pushes_delivered": 40, "alarms_rung": 12, "acks": 11, "incidents_opened": 12 } ] }
  ]
}
```

**Zeroing a key.** A key that is flooding the relay is excluded from
`totals`, `days` and `servers_total` without losing its history:

```
critalarm stats zero-key rk_...        # the key the server was issued
critalarm stats zero-key <sha256hex>   # or the hash this endpoint prints
```

Its counter rows stay in the database and it keeps its own entry under
`?by=key` with `"zeroed": true`, so an operator can still see what it did.
Zeroing does not revoke the key. `POST /relay/v1/push` keeps working for it.

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
    "sound": "alarm.caf",                                               // only on a critical topic
    "interruption-level": "time-sensitive",
    "mutable-content": 1,
    "content-available": 1,                                             // only on a critical topic
    "category": "INCIDENT"
  },
  "incident_id": "inc_9a8b7c",
  "server": "https://alerts.example.com",
  "kind": "open"
}
```

**iOS alerts are time-sensitive, never critical.** Apple turned the Critical Alerts entitlement down, and APNs rejects a critical payload from an app that does not hold it. So `"interruption-level"` is always `"time-sensitive"`, and the sound is the plain string `"alarm.caf"` rather than a critical sound object. When the sound is attached is unchanged: a priority-5 message on a topic whose `critical` switch is on, opening or joining an incident. The switch still decides that, and still decides whether Android rings through with a full-screen intent. Only the shape of the iOS payload changed.

**`content-available` is what makes the phone ring.** The iOS app schedules the alarm from its background-push handler, and iOS only calls that handler when the push carries `"content-available": 1`. A payload without it delivers a notification with a sound and no alarm. It goes out on the same pushes as the sound: a priority-5 message on a topic whose `critical` switch is on, opening or joining an incident. Everything quieter is left asleep, because waking the app costs battery and Apple throttles background pushes.

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
