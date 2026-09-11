# Contract issues

- Topic ownership column and lifecycle are not specified for hosted provisioning.
- Timer defaults, paid caps, RevenueCat entitlement mapping, priority-4 push detail, and rate limits need deployment decisions.
- Credential configuration names are not specified.
- Hosted mode excludes relay forwarding and full content.
- Topic-token creation documents only `token`, while deletion requires a non-secret `token_id`. The implementation returns additive `token_id` with the token so callers can safely use the documented deletion path without placing a bearer token in a URL.
- `docs/api.md` §4.1 has no `expire` relay kind, but acceptance asks B to receive an expire push. Implementation logs expiry on A and does not invent a relay wire value.
- `docs/api.md` §1.7 requires noncritical priority-5 forwarding, but §4.1 has no wire kind for it. Implementation stores it without an incident and does not forward it.
- ACK has no relay wire event. Acceptance proves ACK-stop by absence of repeats until `reopen`.
- A `relay-content: none` request contains neither topic name nor `max_ring_s`; relay cannot produce §5.1's topic-named fallback or exact TTL. Implementation uses generic fallback and 1800-second TTL.
- Mode inference is underspecified because `relay-url` has a default while its presence distinguishes hosted from relay mode. Implementation uses explicit configuration presence for mode and returns effective default URL from `/v1/info`.
- A topic hash may have subscribers from multiple accounts, but §4.1 does not define response when only some accounts exceed `p4_daily`. Implementation delivers to eligible accounts and returns 202 unless every matching subscribed account is capped.
