# Crit Alarm Server: API Contract

**Version:** 1.17.0
**Status:** draft, 2026-09-23. Lives in `critalarm-server/docs/api.md`. The app's client code and tests pin to this file. Changes here are versioned changes.

**1.17.0** fixes what `since` on `GET /v1/incidents` means. 1.16.0 compared it against `opened_at`, so a client that held an incident as open never heard that it was acked, closed or expired unless the push for that change reached it. Every incident now carries `updated_at` (§3.2), the server bumps it on open, every new message, ack, close, expire and reopen, and `since` compares against it. A client keeps the newest `updated_at` it holds and merges whatever comes back. The retention window (§4.2) still hides rows by `opened_at`.

**1.16.0** is about what happens after the alarm rings and how long the server keeps what it rang about. Four changes. First, the Android push learns the three state kinds `ack`, `close` and `expire` (§4.1, §5.2): until now only the iOS Live Activity heard them, so a second Android phone on the same account rang on until somebody touched it. Second, every alarm push carries `ring_until` (§5.1, §5.2), the epoch second after which the phone must not ring for that incident on its own; the app needs it to re-arm a silenced alarm locally without a network call. Third, `GET /v1/incidents` accepts `since` (§3.2), so a client that keeps its own copy can ask for what is new. Fourth, `history_days` stops being a display hint and becomes retention (§4.2): a hosted or relay server deletes incidents and messages older than the account's window and never returns them, and `history_incidents` goes away. A self-hosted server is not sent a tier and deletes nothing, as before.

**1.15.0** gives every topic token a name (§3.1). A token was only ever identified by its `token_id`, so a client listing a topic's tokens had nothing to show but `tok_` strings, which say nothing about what the token is for and read close enough to a `tk_` value that people try to publish with one. `POST /v1/topics` takes `token_name`, `POST /v1/topics/{name}/tokens` takes `name`, the listing returns `name`, and `PATCH /v1/topics/{name}/tokens/{token_id}` renames one. All of it is optional on the way in: a request that omits a name gets a server-assigned `Token N`, so every existing client keeps working untouched and every token has a name to show.

**1.14.0** does two things for accounts. `POST /v1/account/join-token` mints a fresh `aj_` for the account a device already belongs to (§3.7). Until now `aj_` was minted once, when the account was created, so every account made before 1.11.0 holds none and an account whose token was lost had no way back to one. Minting on demand also means the value exists only while somebody is looking at the screen that shows it. Second, one account may now hold more than one sign-in identity, so the same person can use Sign in with Apple on an iPhone and Google on an Android phone and land on the same account (§3.7). `POST /v1/account/link` takes an `intent` field: `sign_in` is what every existing client already sends by leaving it out, and behaves exactly as it did; `link` adds an identity to the account this device already has. The app has to say which it meant, because the server cannot tell a person adding their second provider from a second person signing in on a borrowed handset.

**1.13.0** adds account deletion (§3.7). `DELETE /v1/account` erases this device's account and everything under it: devices, push tokens, topics, their tokens, messages, incidents, the sign-in identity and its sessions. An account with no identity is deleted on `dv_` alone; one with an identity needs the identity too. An `open` incident blocks it. The operator has the same erase on the command line, `critalarm account delete` (§4.4). Apple and Google both require in-app deletion once an app has sign-in.

**1.12.0** adds sign-in (§3.7). An account already exists before anyone signs in, so signing in attaches a human identity to an account rather than creating one. Three routes: `POST /v1/account/link`, `POST /v1/account/merge` and `POST /v1/account/switch`. Identities are Sign in with Apple and Google; there is no email or password on any tier. Sign-out needs no route, because `DELETE /relay/v1/devices/{device_id}` plus a fresh registration is exactly what it is. `app_user_id` on the RevenueCat webhook stops being the `account_id` and becomes a lookup, so one account can hold more than one subscription and a webhook arriving after a merge still lands on the surviving account (§4.3). Sign-in replaces the support path for a lost token (§4.2).

**1.11.0** adds `aj_`, the account join token, so a second handset can attach itself to an account it can already see (§4.1, §4.2), and `DELETE /relay/v1/devices/{device_id}`, so a device can be released from one (§4.2). `caps.devices` on `free` goes from 1 to 5, the same as every other tier. The iOS row of the device storage table splits in two, because one iCloud-synced Keychain item holding both the account and the device identity makes an iPad restore an iPhone's `device_id`, which puts two handsets on one device row where each overwrites the other's push token. `mode` becomes a setting rather than something the server infers, and a self-hosted server is now promised in writing to have no caps, no tiers and no billing, permanently.

**1.10.0** adds `GET /v1/topics/{name}/tokens`, so a client can see which tokens a topic has (§3.1). `DELETE /v1/topics/{name}/tokens/{token_id}` has existed since 1.5.0 and is keyed on a `token_id`, but nothing ever handed one out except topic creation and `POST .../tokens`, both of which return it once. A client that did not write it down at that moment could never revoke anything. The listing returns `token_id` and `created_at` only. The server stores a SHA-256 hash of each token and not the token, so it cannot return a token value here even if it wanted to, and a token is still shown exactly once, when it is made.

**1.9.0** writes down what `limit` on `GET /v1/incidents` does (§3.2). It defaults to 20 when the parameter is absent and its maximum is 200; ask for more and the server gives you 200. The default was already the server's behaviour and was never documented, so a client that left the parameter off got 20 rows while believing it had asked for everything. There is no paging in v1, so 200 is the most incidents a client can read in one call.

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

**On a `relay` or `hosted` server this route never returns a message older than the account's `history_days` (§4.2).** `since=all` means everything inside that window. A `selfhosted` server has no window and returns whatever it still holds.

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
  { "name":"prod", "critical":false, "token_name":"CI server" }   // critical and token_name optional
→ 201 { ...topic, "token":"tk_...", "token_id":"tok_...", "token_name":"CI server" }   // token returned ONCE, on creation only
→ 409 {"code":40901,"http":409,"error":"topic already exists"}
→ 429 {"error":"cap","cap":"critical_topics"}                // only when critical is true

PATCH  /v1/topics/{name}
  { "critical":true, "repeat_interval_s":30, "max_ring_s":1800, "desk_timer_s":600 }
→ 200 { ...topic }
→ 429 {"error":"cap","cap":"critical_topics"}                // only when flipping critical on

DELETE /v1/topics/{name}
→ 204

GET    /v1/topics/{name}/tokens
→ 200 [{ "token_id":"tok_...", "name":"CI server", "created_at":... }]  // ids and names; never a token value
→ 404 {"error":"not found"}

POST   /v1/topics/{name}/tokens
  { "name":"Grafana" }                             // optional
→ 201 { "token":"tk_...", "token_id":"tok_...", "name":"Grafana" }   // additional token; token returned once

PATCH  /v1/topics/{name}/tokens/{token_id}
  { "name":"Grafana prod" }                        // required
→ 200 { "token_id":"tok_...", "name":"Grafana prod", "created_at":... }
→ 404 {"error":"not found"}

DELETE /v1/topics/{name}/tokens/{token_id}
→ 204
→ 409 {"error":"topic must retain a token"}        // refusing to delete the last one
```

`critical` defaults to `false` on creation. A topic that rings has to be switched on deliberately, so the default stays `false`.

`relay_content` is read-only here; it is server config.

**A token name is optional on the way in and always present on the way out.** `token_name` on topic creation and `name` on `POST .../tokens` may be left off; `name` on the `PATCH` may not. A name is trimmed and then cut to 40 characters, so a longer one is shortened rather than refused. A name that is empty after trimming counts as missing, and a missing name becomes `Token N`, where N is the topic's current token count plus one. Names are not unique inside a topic, so two tokens may carry the same one. That has a visible edge: delete `Token 2` of three and mint another, and the topic holds two rows called `Token 3` until somebody renames one. Making that impossible needs a per-topic counter that survives deletes, which is more state than the problem is worth.

**Every token has a `token_id`, including the one creation hands back.** `DELETE /v1/topics/{name}/tokens/{token_id}` is keyed on it, so a token returned without one could never be revoked, and the creation token is the one that actually ships out to a monitoring tool. A topic always keeps at least one token; deleting the last one answers `409`.

**A token value is returned once and never again.** The server keeps a SHA-256 hash of the token, not the token, so it has nothing to show a second time. `GET /v1/topics/{name}/tokens` lists `token_id`, `name` and `created_at`, and never a token value. It is how a client that lost the value still finds the id to revoke, ordered oldest first. There is no paging: a topic holds few enough tokens that the whole list fits in one answer.

**Creating a topic that already exists answers `409`, not `500`.** Names are unique per account. A client that retries after a dropped `201` will hit this, so it must be a clean, JSON answer.

**Out of range numbers on `PATCH` are ignored, not rejected.** A value outside what the server accepts leaves the stored value unchanged and still answers `200` with the current topic. Read the response rather than assuming the write landed.

### 3.2 Incidents

```
GET  /v1/incidents[?limit=20][&since=<unix ts>][&state=open|acked|closed|expired][&topic=prod]
→ 200 [{ "id":"inc_9a8b7c", "topic":"prod", "state":"open",
          "opened_at":..., "acked_at":null, "closed_at":null, "last_message_at":...,
          "updated_at":..., "messages":[ { ...message object } ] }]

GET  /v1/incidents/{id}
→ 200 { ...incident }                       // used by iOS NSE to fetch title/body in relay-content: none

POST /v1/incidents/{id}/ack                 // stage 1, "I'm up"
→ 200 { ...incident, "state":"acked", "desk_timer_fires_at":... }
→ 409 if state is not open

POST /v1/incidents/{id}/close               // stage 2, "At my desk"
→ 200 { ...incident, "state":"closed" }
→ 409 if state is not acked
```

**`limit` defaults to 20 and stops at 200.** Leave it off and you get 20, which is the trap: a
client that omits it is not asking for everything, it is asking for 20. Ask for more than 200 and
you get 200. Below 1, or anything that is not a whole number, answers
`400 {"error":"invalid request"}`.

Newest first, by `opened_at`. There is no paging in v1, so 200 is the most incidents one call can
return, and a client that wants a longer history cannot reach past it yet. Send `limit` explicitly
on every call.

**`since` is a unix timestamp in seconds, exclusive, on `updated_at`.** Only incidents that changed
after that second are returned. `updated_at` is set when the incident opens and moves forward on
every new message, ack, close, expire and reopen, so an incident the client already holds comes
back when its state changes. It combines with `state`, `topic` and `limit`. Anything that is
not a whole number answers `400 {"error":"invalid request"}`. This is the form a client uses when
it keeps its own copy: send the newest `updated_at` it holds and merge what comes back. Unlike the
poll route (§2), no message id, duration or `all` form is accepted here.

**On a `relay` or `hosted` server this route never returns an incident older than the account's
`history_days` (§4.2).** The server deletes such rows on a schedule and hides them in between. A
`selfhosted` server has no window.


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

**`mode` is a setting, not a guess.** The operator sets it to `hosted`, `relay` or `selfhosted`. When it is absent the server infers it from whether push credentials and a relay URL are configured, which is what earlier versions always did. Inference gets one case wrong: an operator who self-hosts with their own APNs key has a push provider and no relay URL, so they are inferred as `relay`, which switches on anonymous accounts, caps and billing on their own hardware. Such an operator sets `mode: selfhosted` explicitly.

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

### 3.7 Accounts and sign-in

**Not available in `selfhosted` mode.** A self-hosted server has one operator, one `ad_` token and no accounts to sign in to. Every route in this section answers `501 {"error":"not supported in selfhosted mode"}` there. It is `501` and not `404` so that a client can tell "this server does not do sign-in" apart from "you typed the path wrong", which means these routes are mounted in `selfhosted` mode purely to refuse.

**Signing in does not create an account.** The account already exists: registration made it (§4.2) and it has owned topics, subscriptions, caps and billing ever since. Signing in attaches an identity to it. Reading it the other way round is the single most expensive mistake available here, because it implies moving data that never has to move.

**The credential.** Two things are proven at once: who the person is, and which account this handset brings. One `Authorization` header cannot carry two secrets, so the device token stays in the header exactly as on every other `/v1/` route, and the identity travels in the body. The `identity_token` is issued by the server's own auth surface, not by Apple or Google directly.

```
POST /v1/account/link                                   // sign up, sign in, or add a provider
  Authorization: Bearer dv_...
  { "identity_token":"...", "intent":"sign_in" }        // intent is "sign_in" or "link".
                                                        // Absent means "sign_in".
→ 200 { "account_id":"acc_...", "outcome":"claimed" }
        // the identity was new. It now points at this device's own account.
        // Nothing moved. This is the common path and it is cheap.
→ 200 { "account_id":"acc_...", "outcome":"attached" }
        // the identity already had an account, and this device's account was
        // empty, so there was nothing to decide. The device now belongs to the
        // identity's account and the empty one is tombstoned. dv_ does not change.
→ 200 { "account_id":"acc_...", "outcome":"linked" }
        // intent "link" only. The identity was new and this device's account
        // already held one, so the account now holds both. Nothing moved.
→ 200 { "account_id":"acc_...", "outcome":"already_linked" }
        // the identity already points at this device's own account. Sending the
        // same link twice is safe, which is what a retry after a dropped reply is.
→ 409 { "error":"choose",                               // the app must ask, per device
        "into_account":"acc_...",                       // the identity's account
        "topics":3, "incidents":12 }                    // what this device's account would bring
→ 409 { "error":"account has another identity" }        // intent "sign_in", and this device's
                                                        // account is already claimed
→ 409 { "error":"identity has another account" }        // intent "link", and the identity already
                                                        // points at a different account
→ 401
```

**`intent` is the app telling the server which screen the person was on.** Two requests can carry the same device token and the same brand new identity and mean opposite things. On the sign-in screen it means "this is me, put me on my account", and if the device's account already belongs to somebody else that is the shared-handset case and answers `409`. On the account screen, under a button that says add another way to sign in, it means "also let me in with this one", and the identity joins the account the device already has. The server has no way to tell those apart on its own, so it does not try.

A client that never sends `intent` behaves exactly as it did in 1.12.0, with one exception. Signing in again with the identity that already points at this device's own account used to answer `claimed`; it now answers `already_linked`. Both mean the person is signed in and nothing moved, so a client that treats an unknown outcome as success is unaffected, and one that switches on the string needs the new case.

**`linked` is `link` only. `already_linked` is not.** `linked` is the one outcome a client has to ask for. `already_linked` is reachable under either intent, because "this identity is already on this account" is true whichever screen the person came from, and a retry after a dropped reply has to be safe on both.

**`link` against an account that holds no identity yet answers `claimed`, not `linked`.** Nothing is being added to, so it is the ordinary first claim. No screen should reach this, because the button that sends `link` only exists once somebody is signed in, but a client that sends it anyway gets the sensible answer rather than an error.

An empty account means no topics and no incidents. That test matters more than it looks: registration runs long before any sign-in screen and creates an account unconditionally, so "a device with no account" cannot happen, and without the empty case every second-handset sign-in would prompt about an account holding nothing.

```
POST /v1/account/merge                                  // fold this device's account into the identity's
  Authorization: Bearer dv_...
  { "identity_token":"...", "into_account":"acc_..." }
→ 200 { "account_id":"acc_...", "merged_from":"acc_..." }
→ 409 { "error":"live incident", "incident_id":"inc_..." }   // acknowledge it first, then retry
→ 409 { "error":"already merged" }                      // either side is already a tombstone
→ 409 { "error":"same account" }                        // both credentials resolve to one account
→ 401
```

A merge keeps every `tk_` token working, on both sides. Topics are merged row by row and never renamed: a rename would make every live token answer `401` and would change the `topic_hash` every device is subscribed to, so a webhook would keep publishing while nobody was paged.

A merge is refused, not forced, while either side has an `open` or `acked` incident. Closing an alarm to tidy up an account is the wrong trade, and the person is the only one who should acknowledge it.

Merged history becomes mutually readable back to the beginning, because polling reads by topic. That is a reason to word the confirmation plainly, not to hide it.

```
POST /v1/account/switch                                 // start fresh instead of merging
  Authorization: Bearer dv_...
  { "identity_token":"...", "into_account":"acc_..." }
→ 200 { "account_id":"acc_..." }
→ 401
```

The device joins the identity's account and its old account is tombstoned, carrying nothing with it.

**This is the branch that can silently stop paging somebody.** Publishing authenticates on the topic token alone and never looks at the account, so an abandoned account's `tk_` tokens keep accepting publishes, keep opening incidents, and have no device left to ring. A `200` and nobody woken. So either the old account's tokens are revoked as part of the switch, or publishing to a topic whose account is tombstoned or deviceless answers `410 {"error":"account is gone"}`. One of the two is required. The prompt must also say the old tokens will stop working, because that is the part a person cannot guess.

```
POST /v1/account/join-token                             // mint a fresh aj_ for this account
  Authorization: Bearer dv_...
→ 200 { "join_token":"aj_..." }                          // shown once. Any older aj_ stops working
→ 401
```

Every call mints a new token and retires the one before it, so the reply is the only place the value ever appears. Nothing reads the current token back, because the server keeps a hash of it and not the token itself.

An account created before 1.11.0 carries no join token at all, and this is the only way it gets one. There is no backfill, on purpose: a token minted into a database that nothing can deliver to a handset is worse than an empty column. The same route is the way back after a lost phone, and the way to cut off a token somebody read over a shoulder.

Any device on the account may call it, the same way any device may delete a topic.

Not rate limited, because nothing else in §3.7 is. `link`, `merge`, `switch` and the account delete all run bare; the limiter is wired into the publish path only. Minting in a loop costs one row update and hands out a token that immediately retires the one before it, so the damage is bounded. Putting a limiter on the §3.7 write routes is worth doing as one job covering all of them, not as a rule this route alone carries.

```
DELETE /v1/account                                      // erase this device's account
  Authorization: Bearer dv_...
  { "identity_token":"..." }                            // required once the account has an identity.
                                                        // Any one of them is enough
→ 204
→ 401                                                   // bad dv_, or the account has an identity and
                                                        // identity_token is missing, invalid, or someone else's
→ 409 { "error":"live incident", "incident_id":"inc_..." }   // an alarm is ringing. Acknowledge it, then retry
```

An account with no identity is deleted on `dv_` alone. Every device on it holds the same authority, the way every device can already delete a topic. An account with an identity needs one of its identities as well, because a handset left in a drawer must not be able to wipe a signed-in account. An account holding two identities accepts either one: both belong to the same person, and asking for both would strand anybody who lost access to one.

Only an `open` incident blocks. An `acked` one does not: nothing is ringing, and a person must never be stuck unable to leave.

The erase covers the account, every tombstone that points at it, its devices and their push tokens, its topics with their tokens, messages and incidents, its billing ids, and every sign-in identity on it with their sessions and provider tokens. Billing events stay as the dedup log with their account reference cleared, so a late webhook still finds its event id and applies nothing (§4.3). Before erasing, the server asks Apple and Google to revoke the provider tokens it holds. That call is best effort and never blocks the delete.

After `204` every credential of the account is dead: `dv_`, `aj_` and every `tk_`. The app treats it like signing out and registers again with a new `device_id`. The other devices on the account get `401` on their next call and do the same.

Deleting the account does not cancel a store subscription. The app must say so before it calls this route.

**Signing out needs no route.** It is `DELETE /relay/v1/devices/{device_id}` (§4.2) followed by a fresh registration with a new `device_id`. That leaves the old account intact and reachable by signing in again, and it gives the handset a working credential on a new anonymous account.

Doing it any other way bricks the handset. Clearing `dv_` while keeping `device_id` is a permanent `401`: the app only registers when it has no token, and registering a known `device_id` needs the token it no longer has. Keeping the token is not a sign-out at all, because every `/v1/` route authenticates on it.

**Two cases are deliberately undefined and must answer `409`, never `500`.** Signing in (`intent: "sign_in"`) on a device whose account is already claimed by a different identity, which is the shared-handset case; and linking (`intent: "link"`) an identity that already points at another account. Both are decisions about whose data wins, and a unique constraint is not allowed to make them.

One constraint does go, on purpose. `account_identities.account_id` stops being unique, because an account holding two identities is the whole point of 1.14.0. `user_id` stays the primary key: one sign-in identity still points at exactly one account, and that is what makes `linked` and `already_linked` tell apart.

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
  "kind": "open" | "repeat" | "reopen" | "p4" | "p5"    // p5: priority 5 on a topic whose switch is off
        | "ack" | "close" | "expire",                    // state changes, never ring (§5.2)
  "ring_until": 1757464200,                  // epoch seconds, opened_at + max_ring_s; null on p4 and the state kinds
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
        "account_join_token":"aj_...",                  // create path only. absent on a join
        "account_id":"acc_...",
        "tier":"free"|"relay"|"hosted",
        "caps":{ "devices":5, "critical_topics":2, "p4_daily":50, "history_days":7 } }

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

DELETE /relay/v1/devices/{device_id}                        // release this device from its account
  Authorization: Bearer dv_...
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

**Three secrets, three jobs.** `tk_` (§1.2) is a publish token. It goes to Uptime Kuma, a cron job, a CI pipeline, anywhere outside the user's control, and it can only publish to one topic. `dv_` is the device's own secret. It manages topics, subscriptions and incidents, and it never leaves the app. Never send `dv_` to an alerting source and never publish with it.

`aj_` is the account join token. It is minted when an account is created, returned once alongside `device_token`, re-minted on demand by `POST /v1/account/join-token` (§3.7), and it authorises one thing: attaching a new device to that account. It is account-scoped, so revoking it touches no device and removing a device breaks no future join. It is not `account_id`, which is returned on every registration and is not a secret. It never publishes and it never manages a topic.

**Accounts.** Registration with an unknown `device_id` creates an anonymous account and links the device to it. The account is the owner of topics, subscriptions, caps and billing; the device is one of possibly several handsets attached to it. PRD §6.9 requires many devices per account before teams ship, and PRD §7 caps the *number of devices*, which only an account can count.

An account can also carry a human identity, which is what §3.7 is for. Signing up on a device writes an identity against the account that device already has, so no topic, token or subscription moves. Signing in on a device whose own account already holds content asks the person to merge or start fresh. Identities are Sign in with Apple and Google. There is no email or password on any tier.

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
| `devices` | 5 | 5 | 5 |
| `critical_topics` | 2 | `null` | `null` |
| `p4_daily` | 50 | 1000 | 1000 |
| `history_days` | 7 | 90 | 90 |

`null` means no limit. A client that does not understand `null` must treat it as no limit, never as zero.

**`devices` is the same on every tier on purpose.** The cap never stopped anyone from using a second handset, because a second handset can register its own account and go on working. It only made that path uglier, and because `p4_daily` is counted per account, it paid a heavy user to split into two accounts and collect twice the quota. The field stays in the response so a later team tier can move it without a contract change.

**A self-hosted server has no caps, no tiers and no billing.** It is never sent a tier, it never enforces one, and no plan exists on it. This is permanent, not a v1 limitation. The relay is the only place a plan lives.

These are launch guesses, set by gut and adjusted from relay metrics after 30 days. One rule is not a guess and never changes: **no tier caps the alarm.** There is no cap on incidents opened, on repeats, or on how long a critical alarm rings. Plans cap the things a team needs, not the thing one person came for.

**`history_days` is a retention window, not a display hint.** On a `relay` or `hosted` server, incidents and messages older than the account's window are deleted on a schedule (at least once an hour) and are never returned by `GET /v1/incidents` (§3.2) or `GET /{topic}/json` (§2) in the meantime. An incident in state `open` or `acked` is never deleted, whatever its age, and neither are its messages; the window applies to `closed` and `expired` incidents and to messages with no incident. When a plan lapses the window shrinks to the free value and the next run prunes to it. The app shows the same window on the free tier and shows everything it holds on a paid tier: the phone keeps its own copy, so an upgrade reveals rows the server may already have deleted. `history_incidents` was removed in 1.16.0; a client that still reads it must treat its absence as no limit. A self-hosted server keeps whatever it keeps, is never sent a tier, and never deletes anything because of a cap.

**Ring until acked has no cap field.** The app offers the "no limit" option when `tier != "free"` and disables it otherwise. The ring ceiling itself is the server's `max_ring_s` config, which the account holder owns.

**`device_id` must survive a reinstall.** The app generates it once and stores it where deleting the app does not. Losing it orphans the account, silently breaks every webhook the user configured, and detaches a live subscription from its purchase.

| Platform | Where | Survives |
|---|---|---|
| iOS, account | Keychain, `kSecAttrAccessibleAfterFirstUnlock`, iCloud Keychain sync **on**, service `app.critalarm.account` | reinstall, a new iPhone, and every other device on the same Apple ID |
| iOS, device | Keychain, `kSecAttrAccessibleAfterFirstUnlock`, iCloud Keychain sync **off**, service `app.critalarm.device_identity` | reinstall and device-to-device transfer, on that handset only |
| Android | `SharedPreferences` with `android:allowBackup="true"` | reinstall, when the user has Android backup on |

**Two Keychain items on iOS, not one.** The synced item holds `account_id` and the account join token. The unsynced item holds this handset's `device_id` and its `dv_` token. One synced item holding all four makes an iPad restore the iPhone's `device_id`, which puts two handsets on one `devices` row, and each one overwrites the other's push token on registration. Whichever registered last is the only one that rings. Changing `kSecAttrSynchronizable` on an existing install needs a read with `kSecAttrSynchronizableAny` first, because the attribute is part of the lookup, so flipping it without that read makes the old item invisible and orphans the install.

**Store `device_token` in the same place, with the same lifetime.** This is the rule that matters, and it is easy to get wrong in a way that bricks a phone. If the `device_id` outlives the `dv_` token, the app re-registers an id the server already knows, cannot present the token the server demands, and is locked out for good. Whatever holds one must hold the other, so that they are both there or both gone.

Android does not use Keystore-backed storage here, which is a change from 1.3.0 and deliberate. Keystore keys are destroyed on uninstall while Android's auto-backup restores the encrypted blob, so the restored bytes have no key left to decrypt them and the read throws. Encrypting the token at rest is not worth trading for a credential that cannot be read back. App-private storage is not readable on an unrooted device, and the token is scoped to one account's alerts.

**Registering a `device_id` the server already knows.**

| Request | Result |
|---|---|
| valid `dv_` for that device | `200`, push token and `app_version` updated, `account_id`, `tier` and `caps` returned. No `device_token` field, because the caller already holds it. |
| no token, wrong token, or another device's token | `401`. No second token is minted. |

The `200` case is the same work as `PATCH /relay/v1/devices/{device_id}`, and an app that already holds a token should send the `PATCH`. `POST` accepts it so that a retry after a dropped response does the right thing instead of failing.

A client must never read `device_token` as an empty string and store it. The field is absent on this path, not blank.

**Joining an account that already exists.**

```
POST /relay/v1/devices
  Authorization: Bearer aj_...
  { "device_id":"dev_<uuid>", "platform":"ios", "push_token":"...", "app_version":"1.0.0" }
→ 201 { "device_token":"dv_...",                        // this handset's own token
        "account_id":"acc_...",                         // the account the aj_ belongs to
        "tier":"...", "caps":{...} }
```

A `device_id` the server has never seen, presented with a valid `aj_`, joins that account instead of creating a new one. The same request with no bearer creates a new anonymous account, which is what every existing client does and which does not change. An `aj_` matching no account answers `401`. A join that would exceed `caps.devices` answers `429 {"error":"cap","cap":"devices"}` and issues no token.

The registration response carries `account_join_token` only when the call created the account. A join never returns one, because the caller already holds it.

**Releasing a device.**

```
DELETE /relay/v1/devices/{device_id}
  Authorization: Bearer dv_...
→ 204                                                   // the device row, its push tokens and its subscriptions are gone
→ 401                                                   // wrong token, or another device's token
→ 404                                                   // unknown device_id
```

Deleting a device never deletes the account, its topics or its `tk_` tokens, even when it was the last device. The account stays reachable through `aj_` or through sign-in. Two things need this route: signing out has to release the device server-side, or the handset holds a `device_id` the server knows with no token to prove it owns it and is locked out for good; and the iOS two-item migration has to retire the shared row that an iPhone and an iPad were both using, or that row lingers holding one of their push tokens and rings the wrong phone.

Signing in is the recovery path for a lost token (§3.7). Someone who signs in on a replacement handset gets a new `device_id` and a new `dv_` attached to the account their identity points at. The storage rule above is still what keeps that path rare, because it is the only path back for someone who never signed up.

### 4.3 RevenueCat → relay

```
POST /webhooks/revenuecat
Authorization: Bearer <shared secret from RevenueCat dashboard>
```

Body is RevenueCat's webhook event. `app_user_id` is **looked up** to find the account it belongs to. The app sets it to the `account_id` right after registration, so for an account that has never merged the two are the same string, but the server resolves it through its own record rather than treating it as a primary key. That record survives a merge: after account A folds into B, a webhook for A's old `app_user_id` lands on B.

An account may hold more than one `app_user_id`, because a merge brings both sides' subscriptions with it. Tier is then the **highest live entitlement** across them, never the last event to arrive. Without that rule, one lapsed subscription downgrades an account somebody else is still paying for.

Two things the server must not do with this webhook. It must not apply an event it has already applied, because events are retried. And it must not apply an event older than the last one applied for that `app_user_id`, because they arrive out of order, and an `EXPIRATION` overtaking a renewal cancels a live subscription. A billing failure is not an expiry: no event that only reports a payment problem may lower a tier. Crit Alarm is an alarm, and a card that failed on a Tuesday is not a reason to stop ringing.

Updates `tier` on the resolved account, so every device under it changes tier in one write.

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

**Deleting an account.** The same erase as `DELETE /v1/account` (§3.7), for a deletion request that arrives by email:

```
critalarm account delete acc_...              # by account id
critalarm account delete --email <address>    # by the sign-in email
```

It prints what it removed as counts. It does not check for a live incident, because the operator is acting on a written request. An unknown id or address exits non-zero and deletes nothing.

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
  "kind": "open",
  "ring_until": 1757464200
}
```

**`ring_until` is the last second the phone may ring for this incident on its own.** It is `opened_at + max_ring_s` in epoch seconds, and a `reopen` moves it to the new `opened_at`. It is on `open`, `repeat`, `reopen`, and on a `p5` that joins an open incident; a `p5` on a topic whose switch is off has no incident and carries `null`. A phone that silences an alarm without acknowledging it re-arms locally until this second and no later; after it, only a fresh push from the server may ring. Server time; a client allows a small margin and stops at whichever comes first of `ring_until` and an `expire`.

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
      "ring_until": "1757464200",           // epoch seconds, as a string like every FCM data value
      "title": "...",                       // only when relay_content: full
      "body": "..."                         // only when relay_content: full
    }
  }
}
```

Data-only. The app builds the full-screen alarm notification itself.

**State kinds reach Android too.** When an incident is acknowledged, closed or expires, the server sends a data-only push with `kind` set to `ack`, `close` or `expire`, the same `incident_id` and `server`, no `priority`, no `title`, no `body`, `ring_until` absent, `collapse_key` the incident id and a `ttl` of 60 seconds. The app stops any ringing for that incident, cancels any local re-arm, and updates or removes its card. These pushes never ring and never post a new notification. They exist because an incident is handled on whichever device the user picks up, and every other device has to hear that. iOS gets the same information through the Live Activity update (§5.3), never as an alarm push.

### 5.3 Live Activity (iOS)

Live Activity pushes go to APNs on the Live Activity topic, which is the bundle
id with `.push-type.liveactivity` on the end. They are a second push, sent next
to the alarm push in §5.1, never instead of it. Android devices get none of this;
they hear state changes as the data-only kinds in §5.2.

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
