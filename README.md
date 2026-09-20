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
| `data-dir` | `DATA_DIR` | `/data` | SQLite volume |

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
