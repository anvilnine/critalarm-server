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
| - | `RELAY_REGISTRATION` | `open` | Relay and hosted modes. `open` lets a server get a relay key by answering a challenge at its `base_url`. `closed` answers 403 to every caller that sends no registration secret |
| - | `RELAY_REGISTRATION_SECRET` | unset | A relay with this set also accepts a caller that sends it, with no challenge and no check on the `base_url` it names. Its holder can register any `base_url`, so it is for the operator's own servers and is never given to anyone else. A self-hosted server sends it when it is set. More than 5 wrong secrets in 60 seconds from one client answers 429 |
| `behind-proxy` | `BEHIND_PROXY` | `false` | Read the client address from `cf-connecting-ip`, `x-forwarded-for` or `x-real-ip` for rate limits. With `true`, the origin must accept connections from the proxy only, because the address then comes from a header any caller can type |
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
name (not an IP address) that the internet can reach, and your reverse proxy
must pass `/v1/` through to the server. An address that only works on a home
network or a private overlay will not register.

If registration fails, the server writes one JSON line to its log with the
event `relay_registration_failed`, the reason and what to check. It writes the
line again only when the reason changes. After a failure it waits 30 seconds
before the next attempt, doubling the wait up to one hour, so a wrong
`BASE_URL` does not hammer the relay. A success is logged as `relay_registered`.
If the relay replaces or forgets the key, the server registers again by itself.
If you change `BASE_URL`, the relay answers `topic mismatch` to the old key.
The server logs `relay_topic_mismatch`, deletes the key and registers again
with the new address on the next alarm.

Each push to the relay carries the topic name. The relay uses it to check that
the topic hash belongs to your server, then drops it. With `RELAY_CONTENT=none`
(the default) the relay never sees the title or body of an alert.

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
(`1.2.3`, `1.2`, `1`) when a `v*` tag is pushed.

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
and not before.

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
