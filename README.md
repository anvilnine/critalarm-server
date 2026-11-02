# critalarm-server

The Crit Alarm server. One binary that is your alarm server, the push relay, or
both, depending on what you put in the config.

It speaks ntfy's publish and poll API, so anything that already posts to ntfy
(Uptime Kuma, Healthchecks, Home Assistant, a shell script) works against it
unchanged. On top of that it adds the part ntfy has no concept of: a priority-5
message on a topic you marked critical opens an **incident**, and the incident
keeps ringing your phone on a repeat loop until you acknowledge it.

Status: early implementation. Contract-compatible publish, incidents, timers, and relay forwarding are present.

## Publish to it

Anything that can make an HTTP request works:

```bash
curl -X POST https://alerts.example.com/prod \
  -H "Authorization: Bearer tk_xxxxxxxxxxxx" \
  -H "X-Priority: 5" \
  -H "X-Title: Database down" \
  -d "pg_isready failed 3 times in 90 s"
```

There is also a command line publisher, so a cron job or a CI step does not
have to get the headers right by hand:

```bash
npm install -g @anvilnine/critalarm-cli

critalarm send prod "pg_isready failed 3 times in 90 s" -t "Database down" -p 5
```

It publishes and nothing else. Topics, tokens and incidents need a management
credential, which lives in the app. Source and docs:
[anvilnine/critalarm-cli](https://github.com/anvilnine/critalarm-cli),
[critalarm.app/cli](https://critalarm.app/cli).

## Configuration

| Option | Environment | Default | Purpose |
|---|---|---|---|
| `base-url` | `BASE_URL` | required | Public URL used for topic hashes |
| `mode` | `MODE` | inferred | `selfhosted`, `relay` or `hosted`. Unset means the server infers it from the push credentials and `relay-url`; set it to `selfhosted` if you bring your own APNs or FCM key |
| `relay-url` | `RELAY_URL` | `https://relay.critalarm.app` | Relay destination; with push credentials and no `mode`, an explicit value means hosted mode |
| `relay-content` | `RELAY_CONTENT` | `none` | `none` keeps body on server; `full` includes title/body in push |
| `relay-plain-hash` | `RELAY_PLAIN_HASH` | `on` | Self-hosted mode. `on` also pushes the hash made from the topic's name, for apps that do not use the relay name yet. `off` pushes the relay name's hash only. See "Relay names" below |
| - | `RELAY_REGISTRATION` | `open` | Relay and hosted modes. `open` lets a server get a relay key by answering a challenge at its `base_url`. `closed` answers 403 to every caller that sends no registration secret |
| - | `RELAY_REGISTRATION_SECRET` | unset | A relay with this set also accepts a caller that sends it, with no challenge and no check on the `base_url` it names. Its holder can register any `base_url`, so it is for the operator's own servers and is never given to anyone else. A self-hosted server sends it when it is set. More than 5 wrong secrets in 60 seconds from one client answers 429 |
| `behind-proxy` | `BEHIND_PROXY` | `false` | Who may name the client address for rate limits. `false`: nobody, the socket peer is the client. `cloudflare`: `cf-connecting-ip` only. A number from 1 to 10: that many of your own proxies append to `x-forwarded-for`, and the client is that many entries from the right. An entry that is not an IP address falls back to the socket peer. The old `true` is read as `cloudflare` and warns at startup; behind one nginx, Caddy or Traefik set `1`. With any value but `false`, the origin must accept connections from the proxy only |
| - | `RELAY_PUBLIC_HOSTS` | unset | Relay and hosted modes. Comma-separated host names this relay answers to, added to the hosts of `BASE_URL` and `RELAY_URL`. A challenge answer must name one of them, or registration fails with 422. Set it when servers reach the relay under a name that is neither of those |
| `data-dir` | `DATA_DIR` | `/data` | SQLite volume |

## Self-hosting and the relay

A self-hosted server forwards each alarm to a relay (`RELAY_URL`), which passes
it on to the phone. The server needs a relay key for that, and gets one on its
own:

1. At startup, once the server is listening and holds no key, it asks the relay
   for one and sends `BASE_URL` with a random challenge. A server that already
   holds a key does nothing until a push is refused.
2. The relay calls back `BASE_URL/v1/relay-challenge/<challenge>` and checks
   that the server answers with the same value.
3. The relay issues a key, and the server stores it.

For step 2 to work, `BASE_URL` must be a public `https` address with a host
name (not an IP address) that the internet can reach, on port 443 or 8443 (443
is the default), and your reverse proxy must pass `/v1/` through to the server.
The challenge answer names the relay it was made for, taken from `RELAY_URL`.
The relay accepts it only when that is one of its own public host names, so
`RELAY_URL` must be the relay's final address and must not redirect. An address
that only works on a home network or a private overlay will not register.

If registration fails, the server writes one JSON line to its log with the
event `relay_registration_failed`, the reason and what to check. It writes the
line again only when the reason changes. After a failure it waits 30 seconds
before the next attempt, doubling the wait up to one hour, so a wrong
`BASE_URL` does not hammer the relay. A success is logged as `relay_registered`.
If the relay replaces or forgets the key, the server registers again by itself.
While registration waits, the server counts the alarms it could not forward.
The next registration line (`relay_registered`, or `relay_registration_failed`
with a new reason) carries them as `skipped_forwards`.

If you change `BASE_URL`, the relay answers `topic mismatch` to the old key.
For the hash made from a relay name (below), the server works the hash out from
the new `BASE_URL` on every push, so it drops the key, registers again and
retries once. For the hash made from the topic's name, the server works out the
hash of the topic from the new `BASE_URL`. When it
matches, the key is the old one: the server drops it, registers again and
retries that push once, and logs `relay_key_replaced`. When it differs, the
topic was created under the old `BASE_URL`. The key stays, and the server logs
`relay_topic_other_base_url` once for that topic. Phones subscribed to such a
topic do not ring through the relay. Delete the topic, create it again and add
it to the phone again.

Each push to the relay carries the name its hash was made from. The relay uses
it to check that the topic hash belongs to your server, then drops it. With
`RELAY_CONTENT=none` (the default) the relay never sees the title or body of an
alert.

### Relay names

Every topic on a self-hosted server has a `relay_name`: 32 random bytes written
as 43 characters of base64url. The server makes it when the topic is created,
and fills it in for older topics at startup. It never changes and no request
can set it. A device that signs in with a management credential reads it on the
topic object (`GET /v1/topics`, `POST /v1/topics`, `PATCH /v1/topics/{name}`).
The server never writes it to a log.

The app subscribes to `sha256(BASE_URL + "/" + relay_name)`. The hash made from
the topic's name alone can be worked out by anyone who knows your address and
guesses a name like `prod`, and anyone may subscribe a phone to a hash. The
relay name closes that.

For every event the server sends the relay one push on the relay name's hash,
with the relay name as `topic`. While `RELAY_PLAIN_HASH` is `on` it also sends
the older push, made from the topic's name, so an app that does not know the
relay name still rings. The relay sees these names:

- `on`: the relay name and the topic's name.
- `off`: the relay name only.

Turn `RELAY_PLAIN_HASH` off once every phone runs an app that uses the relay
name. Until then, someone who guesses the topic's name can still subscribe to
the older hash. A phone that has not updated stops ringing when you turn it
off.

## Run it

```bash
npm install
npm start          # listens on PORT, default 8080
```

```bash
npm test           # unit tests
npm run type-check # tsc --noEmit
docker build -t critalarm-server .
```

## Docker

Every push to `main` publishes a multi-arch image (`linux/amd64`,
`linux/arm64`) to GitHub's registry.

```bash
docker pull ghcr.io/anvilnine/critalarm:latest
```

```bash
docker run -d --name critalarm \
  -p 8080:8080 \
  -v critalarm-data:/data \
  -e BASE_URL=https://alarm.example.com \
  ghcr.io/anvilnine/critalarm:latest
```

Tags: `latest` and the short commit sha on `main`, plus the semver tags
(`1.2.3`, `1.2`, `1`) when a `v*` tag is pushed. `release.yml` runs the type
check and the tests first and publishes nothing if they fail.

## Releasing

```bash
npm run release            # patch, 0.1.0 -> 0.1.1
npm run release -- minor
npm run release -- major
```

The script bumps the version in `package.json`, runs the tests and the type
check, asks you to confirm, then commits, tags `v<version>` and pushes both
`main` and the tag. It refuses to run if you are not on `main`, if the working
tree is dirty, if `main` and `origin/main` disagree, if the tag already exists,
or if the checks fail.

Pushing a `v*` tag does two things: it publishes the semver image tags, and it
deploys the hosted production server. **A push to `main` does not deploy
production.** It publishes `latest` and `sha-*` and stops there. This is an
alarm server, so the copy that wakes people up changes when someone asks for it
and not before. The deploy also stops unless the tagged commit is already on
`main`, so a tag pushed on an unmerged branch publishes its image and deploys
nothing. The script pushes `main` before the tag for that reason.

The deploy writes the released version into the image tag variable on the
hosting platform, starts the service, then polls `GET /v1/info` until it reports
the version that was just released. `/v1/info` reads the version from
`package.json`, so a deploy that quietly kept the old container fails the
workflow instead of going green.

A maintainer has to set four repository secrets for the deploy to work. Without
them the deploy job stops on its first step and says which one is missing.

| Secret | What goes in it |
|---|---|
| `COOLIFY_URL` | Base URL of the Coolify instance, no trailing slash |
| `COOLIFY_TOKEN` | Coolify API token with read, write and deploy permission |
| `COOLIFY_SERVICE_UUID` | UUID of the production service in Coolify |
| `PRODUCTION_BASE_URL` | Public base URL of the production server, no trailing slash |

The service's compose file in Coolify has to pin the image through a variable,
`image: ghcr.io/anvilnine/critalarm:${CRITALARM_IMAGE_TAG}`. The workflow
rewrites that variable to `<version>@sha256:<digest>`. The digest is what stops
compose from reusing an old image that is already on the host: the host has
never seen it, so it has to pull. The entry also carries `pull_policy: always`,
which Coolify's deploy ignores, so nothing here relies on it.

## Docs

- `docs/api.md` is the contract. The app's client code and tests pin to it, and
  it is versioned. This repo is its home; every other repo holds a copy.
- `docs/ARCHITECTURE.md` is how the pieces fit, the incident state machine, the
  data model, and where each folder goes.
- `CHANGELOG.md` tracks the contract's version.

## Security

Never put a push credential in this repo. APNs `.p8` keys, FCM service accounts
and the RevenueCat webhook secret belong in the deployment. Report anything you
find to security@critalarm.app.

## Licence

[AGPL-3.0](LICENSE). You can run it, read it, change it, and host it. If you
host a modified version for other people, publish your changes.
