# Contract issues

- Topic ownership column and lifecycle are not specified for hosted provisioning.
- Timer defaults, paid caps, RevenueCat entitlement mapping, priority-4 push detail, and rate limits need deployment decisions.
- Credential configuration names are not specified.
- Hosted mode excludes relay forwarding and full content.
- Topic-token creation documents only `token`, while deletion requires a non-secret `token_id`. The implementation returns additive `token_id` with the token so callers can safely use the documented deletion path without placing a bearer token in a URL.
