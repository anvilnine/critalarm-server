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

1. **Registration proves `base_url`.** The caller sends a random `challenge`. The relay calls
   `GET {base_url}/v1/relay-challenge/{challenge}` and issues a key only for `200` with the same
   value in the body. A stranger who registers somebody else's URL fails, because that server
   answers `404` to a value it did not make.
2. **A push proves its topic belongs to the key.** The relay keeps the `base_url` a key was
   registered with. A push carries `topic`. The relay computes `sha256(base_url + "/" + topic)`
   and answers `403 topic mismatch` unless it equals `topic_hash`. The relay does not store `topic`, log it, or put it on the event.

The topic name rule makes the split unambiguous. A topic name is `[-_A-Za-z0-9]{1,64}`, so it
has no `/`. The last `/` in the hashed string always sits between the `base_url` and the name.
Two different `(base_url, topic)` pairs cannot produce one string, so server A cannot choose a
`topic` that makes the hash of server B's topic under A's `base_url`.

A key is also the only key for its `base_url`. A new registration for the same URL replaces the
old row in one transaction, and the old key answers `401`.

Keys issued before this version are marked `legacy` by the migration. They may push without
`topic`, and a `topic` they send is checked. Every key issued from now on needs `topic`.

## Limits added

- `base_url` must be `https`, a dotted host name (no IP literal, no `localhost`, no `.local`,
  `.localhost`, `.internal`, `.lan`, `.home.arpa`), with no credentials, query, fragment or
  trailing `/`, at most 200 characters.
- The relay resolves the host and refuses unless every address is public. It connects to one of
  the vetted addresses, so a second DNS answer cannot move the target. It follows no redirect,
  waits 5 seconds in total, reads at most 1024 bytes and needs `200` with a matching body.
- 5 registration calls per 60 seconds per client address (in memory) and 20 per UTC day per
  client address (in SQLite, so a restart does not reset it). Both are checked before the outbound request.
- `RELAY_REGISTRATION=closed` answers `403` to every call without the operator's secret and makes no outbound request.
- The operator's secret skips the challenge, the address rules and the limits. It keeps the
  shape checks, and the key it gets is tied to its `base_url` like any other.

## What is still open

- **A guessed URL and topic name still subscribe a stranger.** The hash is computable by anyone who
  knows a server's URL and a topic name. Such a person can subscribe a phone of their own to that
  hash and learn when the topic fires. If that server runs `relay-content: full`, they also read
  the title and body. A key cannot push to the topic, and nothing stops anyone listening to it.
- **A server on a private network cannot register without the operator's secret.** The relay will not call a private address.

A per-server secret salt in the hash would close both, and it needs an app change, so it is not part of this work.
