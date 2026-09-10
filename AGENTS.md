# Crit Alarm — rules for every agent

You are building Crit Alarm. Read, in this order, before touching code:
1. docs/api.md          — the contract. Build to this. Never edit it inside a task. (In the app and site repos it is a generated copy; the source is critalarm-server/docs/api.md.)
2. docs/ARCHITECTURE.md — how the pieces fit and the folder layout.
3. The task file you were given. It is self-contained; it includes the product commitments that apply to you.

Commitments made to Apple that no task may break: critical delivery defaults OFF per topic; every topic has a token; the app never generates alerts and never inspects content; the alarm stops on acknowledge; the user can disable critical delivery per topic or in Settings.

## Non-negotiables
- Critical delivery on a topic defaults to OFF. Never change this default.
- Every topic has a token. There are no public topics.
- The `incident` package does not import from `push` or `relay`. It emits events.
- Timers are database rows, never in-memory only.
- Do not add features not in your task. If you think one is needed, write it in the PR description under "Suggested follow-ups" and stop.
- Do not invent API routes, fields, or headers. If api.md does not cover what you need, stop and report; do not guess.

## Tests
- Unit tests only. No widget tests, no integration tests, no e2e.
- Server: every state transition in the incident machine has a test using a fake clock. Every ntfy header alias has a test. Every error code in api.md §1.8 has a test.
- App: unit-test models, the API client against the mock server, and any pure logic. Do not test widgets.
- UI is verified by screenshot. Attach one to the PR for any screen you touch.

## Code
- TypeScript strict. No `any`. Node 22.
- Flutter: follow the design system in the repo. Cubit/Bloc, go_router, freezed — as the template does. Do not introduce a state-management library.
- Astro: follow the template. No new frameworks.
- Small commits with plain messages. One task = one branch = one PR.

## Definition of done
- The acceptance list in the task file passes.
- `npm test` / `flutter test` / `npm run build` passes.
- PR description has: what was built, how to verify it by hand, screenshots for UI, suggested follow-ups.
- Nothing outside the task's file scope was changed. If you had to, say why.

## Running under /goal
- Your task file ends with a `/goal` line. That line is your stopping condition. Nothing else is.
- The evaluator judges from what you show in the transcript. After every meaningful step, paste the command you ran and its output: test summary, `git diff --name-only`, build result. Work you did not show did not happen.
- Do not declare done. Show the evidence and let the evaluator decide.
- If you hit the turn cap without meeting the condition, write BLOCKED.md with what remains and stop.

## When stuck
Write what you tried and what blocked you in the PR or a `BLOCKED.md` in the task folder. Do not work around a blocker by changing the contract or another package.

---

## This repo

`critalarm-server`. Public, AGPL-3.0. The server and the relay are the same
binary; which one you get is decided by config, not a flag (ARCHITECTURE §3).

**Stack.** Node 22, TypeScript strict, Hono, SQLite through `better-sqlite3`.
One long-lived process, because the incident repeat loop is a timer scan over
database rows. No build step in dev: `tsx` runs the TypeScript directly.

**Commands.**

| What | Command |
|---|---|
| Test | `npm test` |
| Build | `npm run build` (this is `tsc --noEmit`; nothing is emitted, the runtime is `tsx`) |
| Type check | `npm run type-check` |
| Run it | `npm start`, listens on `PORT` or 4100 |

**Folder layout** (ARCHITECTURE §12). Today only `src/index.ts`,
`src/server-node.ts`, `src/rate-limit.ts`, `src/middleware/` and
`src/telemetry.ts` exist. Everything below is where new code goes:

```
src/
  ingress/       ntfy-compatible handlers
  incident/      state machine, timer scan. no push imports.
  relay/         client (forward) + server (accept), both, switched by config
  push/          apns.ts, fcm.ts
  store/         better-sqlite3, migrations
  tier/          caps, revenuecat webhook
  config.ts
  main.ts
docs/api.md      the contract
Dockerfile       node:22-alpine, multi-arch
docker-compose.example.yml
```

**Where the docs are.**

- `docs/api.md` is the contract, and this repo is its home. Every other repo
  holds a generated copy. No PR may change it. If it is wrong, stop and say so.
- `docs/ARCHITECTURE.md` is the technical extract. Change it when the design
  changes, not to describe code you just wrote.
- `CHANGELOG.md` tracks the contract's version, not the binary's.
- There is no `docs/design-system/` here. The server has no UI.

**Public repo.** Never commit a key, a `.p8`, a service account, a `.env`, or a
price. Push credentials live in the deployment, not here.
