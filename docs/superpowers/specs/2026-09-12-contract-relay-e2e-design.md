# Crit Alarm Contract Verification and Relay Design

> **Session-only planning artifact:** Never stage or commit this file. Keep it on disk for implementation reference.

**Status:** Ready for implementation

**Contract:** `docs/api.md` version 1.1.0

**Implementation plan:** `docs/superpowers/plans/2026-09-12-contract-relay-e2e.md`

## Purpose

Bring current server into observable compliance with `docs/api.md`, then add
server-to-relay forwarding and relay ingress. Final proof uses real containers,
persistent volumes, curl requests, and timestamped logs. Automated coverage
remains unit-only as required by repository rules.

Current source already contains ingress, incident state, device registry, and
provider senders. It assumes hosted mode, rejects production startup without
push credentials, lacks admin-token lifecycle and relay server endpoints, and
always dispatches locally. Design changes only these responsible boundaries.

## Goals

- Start production self-hosted container without APNs or FCM credentials.
- Generate one admin token on first boot, print it once, persist it, show or
  rotate it through `critalarm token` CLI.
- Infer `selfhosted`, `relay`, or `hosted` from configuration.
- Make `/v1/info` and `/v1/` authorization reflect inferred mode.
- Preserve full ntfy-compatible publish and poll contract.
- Preserve incident flapping guard and durable timer state.
- Make two-second test intervals observable with timestamped event logs.
- Forward strict §4.1 events when self-hosted server lacks push credentials.
- Issue and persist relay server key on first forward.
- Accept relay pushes only with relay key and fan out by topic hash.
- Support `relay-content: none` and `relay-content: full` wire shapes.
- Prove persistence by restarting container during active incident.
- Keep contract file unchanged and record irreconcilable requirements in
  `CONTRACT-ISSUES.md`.

## Non-goals

- No contract additions or version bump.
- No new public route, header, query parameter, or response field.
- No streaming poll transport.
- No relay-side repeat scheduler.
- No durable provider delivery queue.
- No sign-in, team membership, or account recovery API.
- No production credential material in repository or test fixtures.
- No widget, integration, or end-to-end test committed to test suite.
- No unrelated cleanup of compressed existing source.

## Contract conflicts and closest readings

### Expiry

§4.1 relay `kind` union is `open|repeat|reopen|p4`. Acceptance asks B to log an
`expire` relay push. Adding `expire` would change wire contract. Incident engine
therefore emits an internal expiry event for A logging, while relay serializer
filters it. Proof shows B receives open/repeat and A reaches expired state.

### Noncritical priority 5

§1.7 says priority 5 on noncritical topic is forwarded, but §4.1 has no wire
kind for that event. Server stores it and returns no incident ID. Direct hosted
delivery may use internal `p5`; relay client does not forward it.

### ACK stop

Contract has no relay ACK event. ACK deletes repeat and expiry timers, installs
desk timer, and changes state to `acked`. Proof is absence of B repeat receipts
between ACK timestamp and later `reopen`.

### Content-none reconstruction

§4.1 content-none payload omits topic and maximum ring duration. B cannot
construct §5.1 topic-specific fallback body or exact TTL. B uses generic
fallback text and 1800-second TTL until contract supplies required fields.

### Mode inference

Architecture uses `relay-url` presence to distinguish hosted from relay mode,
but also gives relay URL a default. Implementation distinguishes explicit URL
presence from effective default value. `/v1/info` still returns effective URL.

These decisions belong in `CONTRACT-ISSUES.md`. Executor must stop if asked to
produce conflicting wire behavior without contract authorization.

## Runtime modes

| Push provider configured | Relay URL explicit | Mode | Management credential | Event delivery |
|---|---:|---|---|---|
| no | no | `selfhosted` | `ad_` | relay client using default URL |
| no | yes | `selfhosted` | `ad_` | relay client using configured URL |
| yes | no | `relay` | `dv_` | local provider dispatch |
| yes | yes | `hosted` | `dv_` | local provider dispatch |

Push provider means complete APNs or FCM configuration. Partial provider
configuration remains startup error. `ALLOW_NOOP_PUSH` may support local tests,
but never affects mode.

Relay and hosted modes mount relay device, subscription, server-key, push, and
RevenueCat routes. Self-hosted mode does not mount them. Hosted mode does not
forward to its relay URL; doing so would duplicate delivery and loop in common
configurations.

## Configuration

`Config` adds:

```ts
export type ServerMode = "selfhosted" | "relay" | "hosted";

export interface Config {
  baseUrl: string;
  relayUrl: string;
  relayUrlExplicit: boolean;
  relayContent: "none" | "full";
  mode: ServerMode;
  listen: string;
  port: number;
  dataDir: string;
  behindProxy: boolean;
  apns?: ApnsConfig;
  fcm?: FcmConfig;
  revenueCat?: RevenueCatConfig;
}
```

Missing default `critalarm.yml` behaves as empty configuration. Missing file at
explicit `CONFIG_PATH`, malformed YAML, malformed URLs, invalid listener, and
partial credentials remain errors. `base-url` remains required.

Production self-hosted mode requires no push or RevenueCat credentials.
Production relay and hosted modes require RevenueCat shared secret because
webhook route is mounted.

## Persistent identity

Self-hosted management uses one internal owner ID, `acc_selfhosted`. This is an
implementation detail, not tenant behavior. Reusing existing `account_id`
foreign keys avoids parallel topic/incident query paths. Architecture data-model
text must explain this internal row even though devices never exist in
self-hosted mode.

Migration adds:

```sql
CREATE TABLE server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE relay_servers (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  version TEXT NOT NULL,
  relay_key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE relay_client_credentials (
  relay_url TEXT PRIMARY KEY,
  relay_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE relay_p4_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (account_id, day_start)
);
```

Admin token must be retrievable, so raw value is stored in `server_settings`
inside protected data volume. Topic, device, and relay-server credentials remain
hashed where contract never requires later retrieval. Relay client key remains
raw locally because A must reuse it as bearer credential.

First self-host boot transaction creates internal account and `ad_` token.
Startup prints token only when transaction created it. Later boots print config
summary without token. Rotation replaces value atomically.

CLI commands:

```text
critalarm token show
critalarm token rotate
```

CLI opens same SQLite path selected by server configuration. It never starts
HTTP server or timer scanner.

## Management API authentication

Mode-aware middleware is sole `/v1/` authorization boundary:

- `selfhosted`: accept valid `ad_`, bind `acc_selfhosted`, reject every `dv_`.
- `relay|hosted`: accept valid `dv_`, bind token account/device, reject every
  `ad_`.
- Missing, malformed, wrong, or out-of-scope credentials return 401.
- Cross-account rows remain 404 to prevent enumeration.
- `/v1/info` stays public.

Undocumented `/v1/health` is removed rather than normalized because contract
forbids inventing routes.

New topics store configured `relay_content`, retain `critical=false`, generate
one publish token, and return that token only from creation response.

## Domain events and timers

Incident package emits internal domain events without importing push or relay:

```ts
type DomainEventKind = "open" | "repeat" | "reopen" | "p4" | "p5" | "expire";
```

Existing delivery fields remain available: topic hash/name, incident/message
IDs, priority, title/body, server URL, critical flag, max ring duration, and
relay content mode.

`expire` exists only for logging and state evidence. Relay client and provider
dispatcher filter it. `p5` supports direct hosted time-sensitive delivery but
is filtered by relay client because wire contract lacks matching kind.

Timers remain rows with kinds repeat, expire, desk. Scanner checks every 250 ms
so a two-second configured interval fires near its deadline. State transitions
remain transactional:

```text
priority-5 critical -> open + repeat/expire rows
open repeat due      -> repeat event + rescheduled row
open ACK             -> acked + only desk row
acked desk due       -> reopen + new repeat/expire rows
acked close          -> closed + no timers
open expire due      -> expired + no timers + local expiry event
```

Startup scans overdue rows once before normal cadence. Recreated service and
restarted container use same database rows; no incident timeout lives only in
memory.

## Relay client

Topic hash function is centralized:

```ts
sha256(baseUrl + "/" + topic)
```

No slash normalization occurs because contract defines exact concatenation and
`/v1/info.base_url` is hash source shared with app.

Relay client accepts domain events and serializes only strict wire kinds:

```ts
type RelayPushKind = "open" | "repeat" | "reopen" | "p4";

interface RelayPushPayload {
  topic_hash: string;
  incident_id: string | null;
  message_id: string;
  priority: 4 | 5;
  kind: RelayPushKind;
  title?: string;
  body?: string;
}
```

On first supported event for a relay URL:

1. Read `relay_client_credentials`.
2. If absent, POST exact `{base_url, version}` to `/relay/v1/servers`.
3. Require 201 and valid `rk_` response.
4. Persist key transactionally.
5. POST exact push payload with bearer key.

Later events and process restarts reuse stored key. `relay-content: none` omits
title/body keys. `full` includes both. Half-content never crosses wire.

Relay/provider failure occurs after durable message/incident commit. Runtime
logs sanitized error while publish response remains successful. Existing repeat
schedule provides later delivery opportunity; design adds no independent retry
queue.

## Relay ingress

`POST /relay/v1/servers` validates HTTP(S) base URL and semver-like nonempty
version, creates an independent server row, stores key hash, and returns raw key
once. Contract does not define deduplication or recovery by base URL, so route
does neither.

`POST /relay/v1/push`:

1. Validates strict object shape.
2. Accepts only lowercase 64-hex topic hash.
3. Requires `p4` with priority 4 and null incident ID.
4. Requires incident kinds with priority 5 and non-null incident ID.
5. Requires title and body either both absent or both present.
6. Authenticates `rk_` by stored hash using timing-safe comparison.
7. Resolves originating base URL from relay-server row.
8. Logs accepted hash, kind, incident ID, and message ID without content.
9. Returns 202 and starts best-effort fanout.

Malformed input returns 400; bad/missing key returns 401. Exact cap error uses
existing §4.1 shape.

## Relay fanout and caps

Relay fanout selects every non-stale device subscribed to `topic_hash`, across
accounts. It does not require remote `message_id` to exist in B database.
Hosted direct fanout retains account/message ownership check.

Device and critical-topic caps remain enforced when device or subscription is
created. P4 daily cap moves from A publisher account to B subscriber accounts:

- Count one P4 message per subscribed account per UTC day, not per device.
- Exclude accounts whose `caps.p4_daily` is exhausted.
- Increment eligible account counters transactionally once before fanout.
- Return 429 `p4_daily` only when at least one subscribed account exists and all
  matching accounts are capped.
- Return 202 for no subscribers or when at least one account accepts event.

When some accounts are capped and some eligible, deliver to eligible accounts
and return 202. This is closest useful reading for one hash shared by multiple
accounts; record ambiguity in `CONTRACT-ISSUES.md`.

## Provider payloads

Relay ingress converts strict payload to internal provider event. Base URL comes
from authenticated server row. Incident kinds are critical; p4 is
time-sensitive.

Content-none behavior:

- APNs uses title `Crit Alarm`, generic critical fallback, mutable-content 1.
- FCM omits title/body data.
- TTL uses documented 1800-second fallback limitation.

Content-full behavior:

- APNs uses received title/body and omits mutable-content.
- FCM includes received title/body data.

APNs critical sound remains limited to priority-5 critical incident events.
FCM remains data-only. Provider rejection never changes relay ingress 202 after
request is accepted; stale APNs token still clears stored device token.

## Logging

Startup line includes mode, base URL, effective relay URL, relay content,
listener, data directory, and proxy flag. It excludes every secret.

First boot has separate admin-token line. It is absent on later boot.

A logs each internal event:

```text
incident_event kind=open topic_hash=... incident_id=... message_id=...
incident_event kind=repeat topic_hash=... incident_id=... message_id=...
incident_event kind=reopen topic_hash=... incident_id=... message_id=...
incident_event kind=expire topic_hash=... incident_id=... message_id=...
```

B logs accepted relay event before asynchronous provider work:

```text
relay_push_received topic_hash=... kind=open incident_id=... message_id=...
```

Logs never include message title/body, publish token, device token, relay key,
push token, or admin token after first creation.

## Failure behavior

- Relay unavailable: A stores message/state, logs delivery failure, continues
  timers, and returns normal publish response.
- Provider unavailable or fake: B logs accepted request, returns 202, then logs
  sanitized provider failure.
- Process restart: due scan handles persisted rows immediately.
- Duplicate priority-5 while incident open or acked: join same incident and
  update last-message time; do not create second timer set.
- ACK: repeat and expiry stop immediately; only desk timer remains.
- Close outside acked and ACK outside open: 409.

## Test strategy

Every production change starts with focused failing unit test, followed by
minimal implementation and focused green run. Required new coverage:

- Config: three modes, explicit/default relay URL, full content, missing default
  YAML, production self-host without push.
- Admin: first issuance, persistence, show, rotate, wrong token.
- V1: admin/device separation, dynamic info, token-once behavior.
- Timer: local expiry event, 250-ms scan bound, every transition with fake clock.
- Hash: exact byte concatenation and SHA-256 output.
- Relay client: key issuance once, persistence, auth, allowed-kind filter,
  none/full payload shapes, failure isolation.
- Relay ingress: key hash, strict validation, receipt log, 202, wrong key.
- Fanout: cross-account same-hash delivery, unrelated hash exclusion, p4 daily
  accounting.
- Push: APNs/FCM none and full shapes.
- Runtime: mode-specific dispatcher and first-boot-only secret log.

Final `npm test` count must exceed captured baseline 130 and exit 0. Final
`npm run build` must exit 0.

## Manual acceptance

One A container proves self-host behavior through ordered curl transcript:
topic/token lifecycle, critical patch, all publish forms, flapping guard,
noncritical priority 5, priorities 4/3, every alias, delayed rejection, exact
error codes, poll/since, ACK/close conflicts, and noncritical test alarm.

Timestamped logs prove two-second repeats, ACK-stop, four-second desk reopen,
six-second expiry, and incident/timer persistence through container restart.

Two containers prove relay behavior. A has no push credentials and points to B.
B has fake complete push configuration. Registered B device subscribes to exact
A topic hash. B logs open, repeat, reopen, and p4. ACK-stop is silence interval.
A logs expiry; B does not receive unsupported expire kind. Relay key survives A
restart.

## Documentation

`docs/ARCHITECTURE.md` §3 documents mode table and dispatch paths. §7 must also
reflect internal self-host account row and actual scanner cadence. README gains
current status plus YAML/environment/default config table. `docs/api.md` remains
byte-for-byte unchanged.

## Completion boundary

Implementation is ready for review only when:

- Full unit suite passes with count above baseline.
- TypeScript build passes.
- Final Docker image starts in each mode used by proof.
- Every required curl request and response appears in transcript.
- Timer and restart evidence is timestamped.
- B logs every strict relay kind required by §4.1 test flow.
- Contract limitations are stated rather than hidden.
- `CONTRACT-ISSUES.md` exists.
- Planning markdown remains untracked and unstaged.
- Implementation and permanent docs are committed on `main` by exact paths.

