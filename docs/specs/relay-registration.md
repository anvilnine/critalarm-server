# Relay registration and topic binding

Applies to contract 1.20.0 (`docs/api.md` §3.8 and §4.1). This note covers the relay side.

## What a relay key could do before

`POST /relay/v1/servers` used to hand an `rk_` key to anyone who asked. The route
(`src/relay/router.ts` line 26 before this change) closes it by mounting only when the operator set
`RELAY_REGISTRATION_SECRET`, so a stranger's self-hosted server got `401` and never rang a phone.

The route was closed because a key was not tied to a server:

- `POST /relay/v1/servers` stored `base_url` as the caller typed it and checked nothing about it (`router.ts` line 31).
- `POST /relay/v1/push` looked the key up by hash (`SELECT 1 FROM relay_servers`, `router.ts` line 38) and read
  nothing else from the row. The `base_url` was never compared with anything.
- `topic_hash` is `sha256(base_url + "/" + topic)` (`src/relay/hash.ts`), and the app computes it
  from a server's public URL and a topic name. Any key holder who could compute a hash could push it.
- The push then looked up every device subscribed to that hash and dispatched to it (line 47). The only
  guard was the drop for accounts that own the hash on this relay.

So one key rang the subscribers of any other server's topic.

## How 1.20.0 closes it

Two checks.

1. **Registration proves `base_url` and names the relay.** The caller sends a random `challenge`.
   The relay calls `GET {base_url}/v1/relay-challenge/{challenge}` and issues a key only for a `200`
   whose body carries the same `challenge` and a `relay` that is one of the relay's own public host
   names. The relay builds that list from configuration: the hosts of its `BASE_URL` and `RELAY_URL`
   plus `RELAY_PUBLIC_HOSTS`, each made with the same `relayHost` function the challenge route uses,
   so the case and default-port rules match on both sides. It never reads the `Host` header, which
   the caller chooses. An empty list fails every challenge. A stranger who registers somebody else's URL fails, because that server
   answers `404` to a value it did not make. A second relay that receives a registration and replays
   the same `base_url` and `challenge` to the first fails too, because the server answered with the
   host of the relay it was talking to, and that is not one of the first relay's hosts, whatever
   `Host` the replay carries. The server takes
   `relay` from the host of its `RELAY_URL`, and its client sends registration and push requests with
   redirects turned off, so a `RELAY_URL` that redirects cannot carry the body, the secret or the key
   to another address. It fails as a network error, and the log line says why.
2. **A push proves its topic belongs to the key.** The relay keeps the `base_url` a key was
   registered with. A push carries `topic`. The relay computes `sha256(base_url + "/" + topic)`
   and answers `403 topic mismatch` unless it equals `topic_hash`. The relay does not store `topic`, log it, or put it on the event.

The topic name rule makes the split unambiguous. A topic name is `[-_A-Za-z0-9]{1,64}`, so it
has no `/`. The last `/` in the hashed string always sits between the `base_url` and the name.
Two different `(base_url, topic)` pairs cannot produce one string, so server A cannot choose a
`topic` that makes the hash of server B's topic under A's `base_url`.

A key is also the only key for its `base_url`. A new registration for the same URL replaces the
old row in one transaction, and the old key answers `401`.

### What the server does with a `topic mismatch`

A topic's hash is stored when the topic is created and never worked out again, so a changed
`BASE_URL` leaves old topics with old hashes. On `403 topic mismatch` the client works out
`sha256(BASE_URL + "/" + topic)` from the `BASE_URL` set now.

- It equals the event's hash: the topic is right and the key was registered under an older
  `BASE_URL`. The client drops the key, registers again through the backoff and retries that push
  once. A second mismatch throws and the client does not loop.
- It differs: the topic was created under another `BASE_URL`. The client keeps the key, registers
  nothing, and logs one line per topic (not per alarm). Phones subscribed to that topic do not ring
  through the relay. The operator deletes the topic, creates it again and adds it to the phone again.

### Alarms lost while registration waits

A failed registration backs off for 30 seconds, doubling to one hour. When the relay answers `429`
the cap is 5 minutes, so a stranger who holds the relay's global limits cannot keep a keyless
server out for an hour. The client logs one line for
the first failure and again when the reason changes. It counts the forwards it drops for lack of a
key, and the next registration line (a success, or a changed reason) carries the count as
`skipped_forwards`. There is no line per event. No line holds the key, the secret, the challenge or
a topic name on the relay side.

Keys issued before this version are marked `legacy` by the migration. They may push without
`topic`, and a `topic` they send is checked. Every key issued from now on needs `topic`.

## Relay name (1.21.0)

Contract 1.21.0 (`docs/api.md` §3.1 and §4.1) closes the first item under "What is still open": a
guessed URL and topic name no longer lead to the hash.

- A `selfhosted` server gives every topic a `relay_name`, 32 bytes from `crypto.randomBytes` as 43
  characters of base64url. Migration 23 adds the column. The server fills it for topics that exist
  at startup, before the first request. Nothing changes it afterwards and no request sets it.
- The relay client pushes `sha256(BASE_URL + "/" + relay_name)` with `topic` set to the relay name.
  It works the hash out from the `BASE_URL` it runs with on every push.
- The relay needs no change. A relay name has the shape of a topic name (`[-_A-Za-z0-9]{1,64}`), so
  the check in `router.ts` that hashes `base_url + "/" + topic` accepts it.
- `relay-plain-hash` (`RELAY_PLAIN_HASH`, default `on`) decides whether the older push, made from
  the topic's name, goes out too. Both pushes carry the same `incident_id`, `message_id`, `kind` and
  `ring_until`. A failure of one does not stop the other, and each push recovers its own key, so a
  `401` on the secret push does not send the plain one twice.
- Key recovery on `401` and on `topic mismatch` works for both pushes. The secret hash is worked out
  fresh, so a `topic mismatch` on it always means the key was registered under an older `BASE_URL`.
  The "topic created under another `BASE_URL`" case applies to the plain hash only.
- The relay counts one event per push (`router.ts` line 213, `src/stats/counters.ts` line 84), so
  with both pushes on, `incidents_opened`, `alarms_rung` and `acks` for that key count twice. The
  `p4_daily` cap counts per account that holds the hash. An account subscribed to both hashes is
  charged twice for one p4 event, which only happens while an app holds both subscriptions.

## Limits added

- `base_url` must be `https`, a dotted host name with at least two labels (no IP literal, no
  `localhost`, no `.local`, `.localhost`, `.internal`, `.lan`, `.home.arpa`), with no credentials,
  query, fragment or trailing `/`, at most 200 characters. The port is none, 443 or 8443. A path
  segment is never `.` or `..`. The stored and hashed string stays exactly what the server sent.
- The relay resolves the host with a `dns.promises.Resolver` (2 second timeout, one try) and its
  `resolve4` and `resolve6` calls. It does not use `dns.lookup`, which runs on the libuv thread pool
  (4 threads) and would let a few hosts whose name server never answers queue every other lookup in
  the process, the relay's push connections included. This also means no `/etc/hosts` and no search
  domains. A host with no A and no AAAA record fails, and every answer from both families must be
  public. For IPv6 that means inside `2000::/3`, outside `2001::/23` (Teredo among it),
  `2001:db8::/32` and `2002::/16` (6to4). Mapped and `64:ff9b::/96` forms are judged by the IPv4
  inside, and `192.88.99.0/24` is refused with the other reserved IPv4 ranges.
- The relay connects to one of the vetted addresses, so a second DNS answer cannot move the target.
  It follows no redirect, reads at most 1024 bytes and needs `200` with a matching body. One
  deadline of 5 seconds covers DNS, connect, TLS, headers and body together. When it fires the
  request is aborted and its socket destroyed, so a peer that sends a byte every few seconds cannot
  hold it.
- Per client: 5 registration calls per 60 seconds (in memory) and 20 per UTC day (in SQLite, so a
  restart does not reset it). A client is an IPv4 address, or the /64 of an IPv6 address, and an
  IPv4-mapped IPv6 address counts as its IPv4. A client key that is not an address is hashed, so a
  header cannot grow the table with long keys.
- Across all clients: at most 60 confirmations started per 60 seconds and 4 running at once. A call
  over either answers `429`, makes no outbound request and is not charged to its client. There is no
  limit per target host, because one would let a stranger lock a real server out of registering.
- With `BEHIND_PROXY=true` the client address comes from a header, so the origin must accept
  connections from the proxy only.
- A registration body over 4096 bytes and a push body over 65536 bytes (JSON escaping can turn a
  4096-byte body into 24 KB, and a title and body of that size must fit) answer `400 invalid request`, judged by `content-length` and by the bytes read.
- `RELAY_REGISTRATION=closed` answers `403` to every call without the operator's secret and makes no outbound request.
- The operator's secret skips the challenge, the address rules and the per-client limits. It checks
  only that `base_url` and `version` are strings, that `base_url` is not empty and at most 200
  characters, and that `version` is at most 200 characters. It does not parse `base_url`. The key it gets is tied to its `base_url` like any other. Whoever holds it
  can register any `base_url`, so it is for the operator's own servers and is never handed to anyone
  else. More than 5 wrong secrets in 60 seconds from one client answer `429`, so it cannot be
  guessed at any speed.

## Keys issued before 1.20.0

A key issued before 1.20.0 is marked `legacy`. It can still push any hash without `topic`, and the
relay does not tie it to a server. Some of these keys may date from when registration needed no
secret, so the operator cannot assume each one belongs to a server they know. Before opening
registration, list them:

```sql
SELECT id, base_url, version, created_at FROM relay_servers WHERE legacy = 1;
```

Delete any row you cannot attribute to a server you know. The server holding that key gets `401`
and registers again through the challenge, which ties its new key to its `base_url`:

```sql
DELETE FROM relay_servers WHERE id = '<id>';
```

No code deletes these rows.

## What is still open

- **A guessed URL and topic name still subscribe a stranger while `relay-plain-hash` is `on`.** The
  hash is computable by anyone who knows a server's URL and a topic name. Such a person can
  subscribe a phone of their own to that hash and learn when the topic fires. If that server runs
  `relay-content: full`, they also read the title and body. A key cannot push to the topic, and
  nothing stops anyone listening to it. With the setting `off`, only the hash made from the relay
  name goes out, and nobody can guess it.
- **Upgrading a server that holds a key from before 1.20.0 can silence old topics.** The 1.20.0 server sends `topic` on every push, so the relay now checks the hash. A topic created under an older `BASE_URL` stops ringing after the upgrade, and the log says so once per topic.
- **A server on a private network cannot register without the operator's secret.** The relay will not call a private address.
- **A registration by challenge costs the relay a DNS query and a connection to a host the caller picks.** The limits above bound how many at a time and per minute. They do not stop a determined caller who uses many /64 networks, which is why the global limits exist.

The relay name closes the first item once `relay-plain-hash` is `off`. It does not touch the second.
