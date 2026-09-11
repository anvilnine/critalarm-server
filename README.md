# critalarm-server

The Crit Alarm server. One binary that is your alarm server, the push relay, or
both, depending on what you put in the config.

It speaks ntfy's publish and poll API, so anything that already posts to ntfy
(Uptime Kuma, Healthchecks, Home Assistant, a shell script) works against it
unchanged. On top of that it adds the part ntfy has no concept of: a priority-5
message on a topic you marked critical opens an **incident**, and the incident
keeps ringing your phone on a repeat loop until you acknowledge it.

Status: early implementation. Contract-compatible publish, incidents, timers, and relay forwarding are present.

## Configuration

| Option | Environment | Default | Purpose |
|---|---|---|---|
| `base-url` | `BASE_URL` | required | Public URL used for topic hashes |
| `relay-url` | `RELAY_URL` | `https://relay.critalarm.app` | Relay destination; explicit value enables hosted mode with push credentials |
| `relay-content` | `RELAY_CONTENT` | `none` | `none` keeps body on server; `full` includes title/body in push |
| `data-dir` | `DATA_DIR` | `/data` | SQLite volume |

## Run it

```bash
npm install
npm start          # listens on PORT, default 4100
```

```bash
npm test           # unit tests
npm run type-check # tsc --noEmit
docker build -t critalarm-server .
```

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
