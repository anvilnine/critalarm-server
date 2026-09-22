# Crit Alarm architecture

How the pieces fit and where every folder goes. Technical only. Product scope,
pricing and plans live outside this repo.

`docs/api.md` is the contract. Where this file and `api.md` disagree, `api.md`
is right, and the fix goes in `api.md` first.

---

## 2. Components

```mermaid
flowchart LR
    subgraph user["User's systems"]
        UK[Uptime Kuma / Healthchecks /<br/>Home Assistant / script]
    end

    subgraph selfhost["Self-hosted server (user's box)"]
        IN[Ingress<br/>POST /:topic]
        INC[Incident engine]
        ST[(SQLite)]
        FWD[Relay client]
        IN --> INC --> ST
        INC --> FWD
    end

    subgraph relay["Relay (critalarm.app)"]
        RIN[Relay ingress]
        DEV[(Account, device<br/>and subscription registry)]
        PUSH[Push sender]
        MET[(Metrics)]
        RIN --> DEV --> PUSH
        RIN --> MET
    end

    APNS[APNs]
    FCM[FCM]

    subgraph phone["Phone"]
        APP[Crit Alarm app]
        NSE[iOS NSE<br/>fetch body]
    end

    UK -- ntfy publish --> IN
    FWD -- "topic hash, incident id,<br/>priority (+ body if full)" --> RIN
    PUSH --> APNS --> NSE --> APP
    PUSH --> FCM --> APP
    NSE -. "GET /v1/incidents/:id<br/>(relay-content: none)" .-> IN
    APP -- "ack / poll" --> IN
    APP -- "register device" --> RIN
```

In hosted mode the two boxes collapse: the hosted server has push credentials,
so the incident engine calls the push sender directly and `FWD` and `RIN` are
skipped.

**The dashboard is the Flutter app, built for web.** When an account UI ships it
is `flutter build web` out of `critalarm-app`, deployed at `app.critalarm.app`,
calling the same `/v1/` routes with the same device token as the phone. A
self-hosted server may also serve that build at `/ui`. That is optional and
self-hosted only: a hosted deployment serves the dashboard from
`app.critalarm.app`, not from the API host. Next.js is not used. The web build
cannot register for push and cannot run the alarm, so the app gates those
screens on a capability instead of a platform check. No web UI is being built in
this pass. The decision is recorded here so nothing gets written against a
second framework.

## 3. Roles of the one binary

```mermaid
flowchart TB
    BIN[critalarm server]
    BIN --> A["Self-hosted mode<br/>no push creds<br/>relay-url set<br/>base-url required"]
    BIN --> B["Relay mode<br/>APNs + FCM creds<br/>account registry on<br/>accepts relay ingress"]
    BIN --> C["Hosted mode<br/>= self-hosted + relay<br/>in one process"]
```

Mode is inferred from config, not a flag. Without push credentials, server runs
self-hosted and forwards supported events to effective `relay-url` (default
`https://relay.critalarm.app`). Push credentials without explicit `relay-url`
select relay mode; push credentials plus explicit `relay-url` select hosted mode.
Relay endpoints and account/device tables exist only in relay and hosted modes.

Mode also decides which credential the `/v1/` routes accept: the admin token in
self-hosted mode, a device token scoped to one account in relay and hosted mode.
See `docs/api.md` §3.

## 4. Incident lifecycle

```mermaid
stateDiagram-v2
    [*] --> Open : priority-5 on critical topic
    Open --> Open : repeat every repeat_interval
    Open --> Expired : max_ring_duration passed
    Open --> Acked : "I'm up" (stage 1)
    Acked --> Closed : "At my desk" (stage 2)
    Acked --> Open : desk_timer expired, no stage 2
    Open --> Closed : resolve (P2, not v1)
    Expired --> [*]
    Closed --> [*]
```

Rules:

- One open incident per topic. A new priority-5 on a topic with an `Open` or
  `Acked` incident joins it (bumps `last_message_at`, does not create a new
  one). This is the flapping guard.
- Repeats reuse the incident ID as the push collapse key (`apns-collapse-id`,
  FCM `collapse_key`) so the phone shows one alert.
- Stage-two re-ring: `Acked` back to `Open` restarts the repeat loop with the
  original `max_ring_duration` counted from the re-open time.
- All timers are rows, not in-memory. See §7.

## 5. Priority mapping

| ntfy priority | Topic critical toggle | iOS | Android |
|---|---|---|---|
| 5 | on | Time-Sensitive, incident opened | Full-screen alarm, incident opened |
| 5 | off | Time-Sensitive, no incident | High-priority notification, no incident |
| 4 | off or on | Time-Sensitive | High-priority |
| 1 to 3 | off or on | Standard, app polls | Standard, app polls |

Only priority 5 on a critical topic creates an incident and enters the retry
loop. Everything else is fire and forget, ntfy-style.

Apple denied the Critical Alerts entitlement for `app.critalarm`, so iOS never
rings through the silent switch or Do Not Disturb. The loudest iOS delivery is a
Time-Sensitive push. The topic critical switch still decides whether an incident
opens and whether the repeat loop runs, and it still drives the Android
full-screen alarm.

## 6. API

Do not restate the routes here. `docs/api.md` is the contract, it is versioned,
and a second copy in this file goes stale the first time the contract moves.

What matters architecturally:

- Two surfaces on one server. The ntfy-compatible publish and poll routes sit
  at the root so existing ntfy integrations work unchanged. Everything ntfy has
  no concept of (topics, tokens, incidents, ack) sits under `/v1/`.
- Anything ntfy accepts that Crit Alarm does not implement is accepted and
  ignored, never rejected. The one exception is `X-Delay`, because answering
  `200` to a scheduled message that will never be scheduled is a lie.
- The relay surface (`/relay/v1/`) is served only when push credentials are
  configured.

## 7. Data model

```mermaid
erDiagram
    TOPIC ||--o{ TOKEN : has
    TOPIC ||--o{ MESSAGE : receives
    TOPIC ||--o{ INCIDENT : opens
    INCIDENT ||--o{ MESSAGE : groups
    INCIDENT ||--o{ TIMER : schedules
    ACCOUNT ||--o{ DEVICE : owns
    ACCOUNT ||--o{ SUBSCRIPTION : owns
    DEVICE ||--o{ SUBSCRIPTION : has
    SUBSCRIPTION }o--|| TOPIC : "by topic_hash"

    TOPIC {
        text id PK
        text name
        text base_url
        text topic_hash
        bool critical
        int repeat_interval_s
        int max_ring_s
        int desk_timer_s
        text relay_content
    }
    TOKEN {
        text id PK
        text topic_id FK
        text hash
        datetime created_at
    }
    MESSAGE {
        text id PK
        text topic_id FK
        text incident_id FK
        text title
        text body
        int priority
        datetime created_at
    }
    INCIDENT {
        text id PK
        text topic_id FK
        text state
        datetime opened_at
        datetime acked_at
        datetime closed_at
        datetime last_message_at
    }
    TIMER {
        text id PK
        text incident_id FK
        text kind
        datetime fire_at
    }
    ACCOUNT {
        text id PK
        text tier
        text join_token_hash
        text merged_into FK
        datetime created_at
    }
    ACCOUNT_BILLING_ID {
        text app_user_id PK
        text account_id FK
        text entitled_tier
        datetime last_event_at
    }
    DEVICE {
        text id PK
        text account_id FK
        text device_token_hash
        text platform
        text push_token
        datetime last_seen
    }
    SUBSCRIPTION {
        text device_id FK
        text topic_hash
    }
```

`ACCOUNT`, `ACCOUNT_BILLING_ID`, `DEVICE` and `SUBSCRIPTION` exist only in relay
and hosted mode. Self-hosted never stores a device, and has no tier, no caps and
no billing at all.

An account owns a subscription through its devices, not directly: a subscription
names only the device. Holding the account on the row as well meant a device
whose account changed kept a stale copy, so unsubscribing filtered on the old
value, deleted nothing, and still answered 204.

Billing is a lookup, not an identity. One account can hold several
`ACCOUNT_BILLING_ID` rows, because merging two accounts brings both sides'
subscriptions, and the account's tier is the highest live entitlement across
them. `merged_into` is how a webhook that arrives after a merge still finds the
surviving account.

**Why the account row exists.** A device is a handset. It gets replaced, wiped
and reinstalled. The account is the thing that owns topics, subscriptions, caps
and the purchase, and it survives all three. Registration creates one silently,
so there is still no sign-up screen. Adding sign-in later fills in one column
and migrates nothing. See `docs/api.md` §4.2.

**Deleting an account.** `DELETE /v1/account` and `critalarm account delete` run
the same erase, `deleteAccount` in `src/v1/accounts.ts`, in one transaction. It
takes the account, every tombstone whose `merged_into` chain ends at it, and
everything that cascades from those rows. Two tables do not cascade and are
handled by hand: `tier_changes` rows go, and `billing_events` rows stay with
`account_id` cleared, because they are the dedup log a late webhook still has to
land in. The better-auth `user` row is deleted by hand as well, since
`account_identities` carries no foreign key to it, and deleting it takes the
person's sessions and their stored OAuth tokens. Before the transaction the
server asks Apple and Google to revoke those tokens. That call is best effort
and never blocks the delete. See `docs/api.md` §3.7.

**Two secrets, two jobs.** A topic token authorizes publishing and goes out to
whatever monitoring tool fires the alert. A device token authorizes managing
topics and incidents and never leaves the app. Never mix them.

**Timers as rows.** `TIMER.kind` is one of `repeat`, `expire`, `desk`. One
`setInterval` every 5 s selects `fire_at <= now`, handles each, then deletes or
reschedules. On boot the same scan runs once. A crash loses at most 5 seconds
of ringing, not the incident.

**How long rows live.** `history_days` is retention, not a number to show. On a
relay or hosted server `pruneHistory` in `src/retention/prune.ts` walks the
accounts once an hour, one transaction each, and deletes closed and expired
incidents older than that account's window along with their messages, plus any
message with no incident. An open or acked incident is never deleted, whatever
its age. The job has its own `setInterval`, separate from the 5 s timer scan,
and its first run is 60 s after boot. Between runs `historyCutoff` in
`src/retention/window.ts` hides the same rows from `GET /v1/incidents` and
`GET /{topic}/json`, so a read never shows what the next run will delete. A
self-hosted server has no tier and no window: it prunes nothing, filters
nothing, and there is no setting that turns this on. See `docs/api.md` §4.2.

## 8. Push path detail

```mermaid
sequenceDiagram
    participant M as Monitoring tool
    participant S as Self-hosted server
    participant R as Relay
    participant A as APNs
    participant N as iOS NSE
    participant P as App

    M->>S: POST /prod (Priority: 5)
    S->>S: open incident, schedule repeat+expire
    S->>R: POST /relay/v1/push {hash, id, 5, open}
    R->>R: lookup devices by hash, check caps
    R->>A: time-sensitive push, collapse-id = id, body = fallback
    A->>N: deliver (mutable-content)
    N->>S: GET /v1/incidents/id
    S-->>N: title, body
    N->>P: display with real body and the alarm sound
    loop every repeat_interval until ack
        S->>R: {..., repeat}
        R->>A: same collapse-id
    end
    P->>S: POST /v1/incidents/id/ack
    S->>S: state=Acked, schedule desk timer
```

If the NSE fetch fails (server down, proxy misconfigured, 30 s budget), the
fallback body is shown. The sound still plays because it is in the APNs payload,
not the fetched body. It plays at the phone's notification volume and it obeys
the silent switch, because Apple denied the Critical Alerts entitlement.

`relay-content: full` skips the NSE fetch: title and body are in the push.

## 9. Config (self-hosted)

```yaml
base-url: https://alerts.example.com   # required. must match what the app subscribes to
relay-url: https://relay.critalarm.app # default
relay-content: none                    # none | full
listen: :8080
data-dir: /data
behind-proxy: true
```

`relay-url` may be overridden with `RELAY_URL`. `relay-content` accepts `none`
or `full`; environment override is `RELAY_CONTENT`.

Nothing is printed at startup except the admin token on first boot. To see what
a running server actually loaded, call `GET /v1/info`. It needs no auth and it
answers with `base_url`, `relay_url`, `relay_content` and `mode`, so a
reverse-proxy mistake shows up there instead of in a 401 an hour later.

`LOG_REQUESTS=true` adds one line per request: method, path, status, duration.
Off by default. It carries no tokens, no message bodies and no push tokens, so
it is safe to turn on against a real deployment while chasing something. Push
failures log themselves either way, under `dispatch_failed`, because a publish
that answers 500 because a push provider is misconfigured used to give an
operator nothing at all to go on.

## 10. Trust and abuse

- No public topics. Every topic has a token from creation.
- The topic hash on the relay is `sha256(base_url + "/" + topic)`, ntfy's
  scheme. Knowing the hash lets you receive pokes for a topic, not send them.
  Sending needs the topic token on the user's server.
- The relay server key is issued anonymously on first forward and rate-limited
  per key and per IP.
- Device routes need the device token issued at registration. Registration
  itself is the only unauthenticated relay route.
- A device token reaches only rows owned by its account. Another account's topic
  or incident answers `404`, never `403`, so the token cannot be used to find
  out which topic names exist.
- Relay caps: one new incident per topic hash per 5 min, plus the per-account
  caps the relay returns in `caps` at registration. Caps are counted per
  account, not per device.
- The relay stores no message content in `none` mode. Metrics are counts and
  timings only.

## 11. Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| User's server down | Nothing new is sent, and an already-open incident stops repeating, because repeats originate on the server. | Accept for v1. Document it. P2: relay-side repeat. |
| Relay down | Self-hosted pushes stop. | The relay is one container behind Cloudflare. A second instance is the fix, and it is not v1. Document it. |
| APNs rejects token | Device never rings. | The relay marks the device stale on 410, the app re-registers on next launch, and "Ring me now" surfaces it. |
| Reverse proxy strips headers | Ingress 401s, or the topic hash does not match. | `GET /v1/info`, the `behind-proxy` setting, and a docs page for Caddy, Traefik and nginx. |
| iOS cannot ring through silent mode | Apple denied the Critical Alerts entitlement, so iOS priority 5 arrives as a Time-Sensitive push. | Same code path. Android keeps the full-screen alarm. |
| Phone offline | Push queued by APNs and FCM up to their TTL. | Set `apns-expiration` to `max_ring_duration`. |

The first row is the honest weakness. If the box running Crit Alarm is the box
that died, there are no repeats. For someone running both on one machine the
first push still fires, as long as it is the monitored service that died and not
the host. Say this in the docs.

## 12. Repo layouts

This is the target, not an inventory. Most of it does not exist yet: today the
server has `src/index.ts`, `src/server-node.ts`, `src/rate-limit.ts` and
`src/middleware/`. `src/main.ts` replaces `server-node.ts` as the entry point
when S0 lands the config loader.

```
critalarm-server/
  src/
    ingress/       ntfy-compatible handlers
    incident/      state machine, timer scan. no push imports.
    relay/         client (forward) + server (accept), both, switched by config
    push/          apns.ts, fcm.ts
    store/         better-sqlite3, migrations
    tier/          caps, revenuecat webhook
    config.ts
    main.ts
  docs/api.md      the contract the app tests pin to
  Dockerfile       node:22-alpine, multi-arch
  docker-compose.example.yml

critalarm-app/
  lib/             Flutter. features/{onboarding,topics,incidents,settings}
  ios/CritAlarmNSE/  Swift. fetch + mutate notification.
  android/         full-screen intent channel config
  integration_test/  hits a real server container

critalarm-site/
  src/pages/       landing, compare, works-with
  src/content/docs/  Starlight
```
