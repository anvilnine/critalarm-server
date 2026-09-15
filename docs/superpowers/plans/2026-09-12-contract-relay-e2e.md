# Contract Verification and Relay Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Session-only artifact:** Never stage or commit this file. Keep it on disk for execution reference.

**Goal:** Make one Crit Alarm binary satisfy `docs/api.md`, prove required self-hosted behavior with Docker and curl, and add strict-§4.1 relay forwarding and ingress.

**Architecture:** Keep incident package independent: it emits typed domain events backed by SQLite timers. Runtime selects self-hosted relay forwarding or local push from inferred config mode. Relay client obtains and persists one server key, serializes only contract wire kinds, while relay ingress authenticates key, logs accepted push, and fans out by topic hash.

**Tech Stack:** Node 22, TypeScript strict, Hono, `better-sqlite3`, Zod, Vitest, Docker, curl.

**Spec:** `docs/superpowers/specs/2026-09-12-contract-relay-e2e-design.md` (implements immutable `docs/api.md`)

## Global Constraints

- Never edit `docs/api.md`.
- Critical delivery defaults to `false` for every new topic.
- Every topic receives at least one token; never expose existing topic tokens.
- Incident package must not import from `push` or `relay`.
- Timers remain SQLite rows; process restart must preserve them.
- Unit tests only. Docker and curl are manual acceptance evidence, not committed integration tests.
- Use fake clocks for every incident state transition test.
- TypeScript remains strict with no `any`; Node floor remains 22.
- Touch only files named in this plan. Preserve unrelated user changes.
- Start test baseline is 130 tests across 20 files. Final count must be greater than 130.
- Run on existing `main`; do not create or switch branch.
- After every meaningful step, paste command and output, including test summary, build result, and `git diff --name-only`.
- Use `apply_patch` for edits. Keep shell commands simple; place multi-command curl orchestration in `/tmp/critalarm-e2e.sh`.
- Never stage or commit planning markdown, including this file and anything under `docs/superpowers/`.

## Contract Interpretation Locks

Strict contract creates four proof limitations. Record them in `CONTRACT-ISSUES.md`; do not add wire fields or enum values:

1. §4.1 permits `kind` values `open`, `repeat`, `reopen`, and `p4`; requested relay `expire` is not representable. Emit/log expiry locally on A, but never POST `kind: "expire"` to B.
2. §1.7 requires noncritical priority-5 forwarding, while §4.1 has no noncritical-P5 kind. Store and return it without incident; do not relay it.
3. ACK has no relay wire kind. Prove ACK-stop by showing B receives no later repeat before desk-timer reopen.
4. `relay-content: none` omits topic and `max_ring_s`; B cannot construct §5.1 topic-named fallback or exact provider TTL. Use generic fallback text and 1800-second relay-side TTL, and record mismatch.
5. One topic hash can have subscribers from multiple accounts, but §4.1 does not define a mixed-cap response. Deliver to eligible accounts, return 202 when any account accepts, and return 429 `p4_daily` only when every matching subscribed account is capped.

Mode inference closest reading:

| Push credentials | Explicit `relay-url` | Mode | Delivery path |
|---|---:|---|---|
| absent | absent or present | `selfhosted` | forward contract-supported events to effective relay URL |
| present | absent | `relay` | serve relay APIs and push locally |
| present | present | `hosted` | serve all APIs and push locally; do not loop through relay URL |

Effective relay URL defaults to `https://relay.critalarm.app`. Track whether URL was explicit separately so default does not force hosted mode.

## File Map

**Create**

- `src/admin/credentials.ts` — persistent singleton self-host account and admin token lifecycle.
- `src/admin/__tests__/credentials.test.ts` — issuance, persistence, show, rotate.
- `src/cli.ts` — `critalarm token show|rotate` command.
- `src/relay/hash.ts` — exact topic-hash derivation.
- `src/relay/client.ts` — relay key bootstrap, persistence, wire serialization, forwarding.
- `src/relay/router.ts` — `/relay/v1/servers` and `/relay/v1/push`.
- `src/relay/types.ts` — strict wire payload and injected dependency types.
- `src/relay/__tests__/hash.test.ts` — exact SHA-256 proof.
- `src/relay/__tests__/client.test.ts` — first-forward key issuance, reuse, allowed kinds, none/full shapes.
- `src/relay/__tests__/router.test.ts` — key authentication, 202 receipt, fanout, route validation.
- `src/__tests__/runtime.test.ts` — mode composition and dispatch selection.

**Modify**

- `package.json` — expose `critalarm` CLI.
- `Dockerfile` — make CLI executable and available on PATH.
- `src/config.ts` and `src/__tests__/app.test.ts` — self-host startup, full content, mode inference.
- `src/store/migrations.ts` and store tests — server settings and relay server/client key tables.
- `src/incident/types.ts`, `src/incident/service.ts`, `src/incident/scanner.ts`, incident tests — observable expiry and timer cadence.
- `src/ingress/types.ts`, `src/ingress/service.ts`, ingress tests — relay content propagation; remove publisher-side relay caps.
- `src/v1/auth.ts`, `src/v1/router.ts`, `src/v1/topics.ts`, V1 tests — mode-aware management auth, info, self-host topics.
- `src/index.ts` and mount tests — conditional relay surface; remove undocumented health route.
- `src/push/dispatcher.ts`, `src/push/apns.ts`, `src/push/fcm.ts`, push tests — relay hash fanout and full-content payloads.
- `src/main.ts` — readable runtime composition, first-boot log, event log, client/local dispatch.
- `CONTRACT-ISSUES.md` — precise unresolved contract contradictions.
- `docs/ARCHITECTURE.md` — §3 mode/runtime path and timer scan cadence if changed.
- `README.md` — current status and config table.

---

### Task 1: Capture untouched baseline and contract discrepancies

**Files:**

- Modify: `CONTRACT-ISSUES.md`

**Interfaces:**

- Consumes: `docs/api.md` §§1.7, 4.1, 5.1 and user acceptance request.
- Produces: explicit constraints future tasks must not work around.

- [ ] **Step 1: Confirm clean starting point and baseline branch**

Run:

```bash
git status --short --branch
git log -5 --oneline --decorate
```

Expected: branch `main`; note all pre-existing changes before touching files.

- [ ] **Step 2: Re-run baseline tests and build**

Run:

```bash
npm test
npm run build
```

Expected baseline: `20 passed`, `130 passed`; build exit 0. If count changed before Luna starts, record actual count and use it as final lower bound.

- [ ] **Step 3: Attempt baseline production image startup before fixes**

Run:

```bash
docker build -t critalarm-server:baseline .
docker volume create critalarm-baseline-data
docker run --name critalarm-baseline -d -p 4199:8080 -v critalarm-baseline-data:/data -e BASE_URL=http://localhost:4199 critalarm-server:baseline
docker logs critalarm-baseline
```

Expected current divergence: production config rejects missing push provider or missing config file. Paste exact failure. Remove only this disposable container after log capture:

```bash
docker rm -f critalarm-baseline
```

- [ ] **Step 4: Replace vague contract-issue bullets with precise findings**

Keep still-valid existing bullets. Add this exact substance:

```markdown
- `docs/api.md` §4.1 has no `expire` relay kind, but acceptance asks B to receive an expire push. Implementation logs expiry on A and does not invent a relay wire value.
- `docs/api.md` §1.7 requires noncritical priority-5 forwarding, but §4.1 has no wire kind for it. Implementation stores it without an incident and does not forward it.
- ACK has no relay wire event. Acceptance proves ACK-stop by absence of repeats until `reopen`.
- A `relay-content: none` request contains neither topic name nor `max_ring_s`; relay cannot produce §5.1's topic-named fallback or exact TTL. Implementation uses a generic fallback and 1800-second TTL.
- Mode inference is underspecified because `relay-url` has a default while its presence distinguishes hosted from relay mode. Implementation uses explicit configuration presence for mode and returns the effective default URL from `/v1/info`.
- A topic hash may have subscribers from multiple accounts, but §4.1 does not define a response when only some accounts exceed `p4_daily`. Implementation delivers to eligible accounts and returns 202 unless every matching subscribed account is capped.
```

- [ ] **Step 5: Show scope**

Run:

```bash
git diff --name-only
```

Expected: only `CONTRACT-ISSUES.md`.

- [ ] **Step 6: Commit issue record**

```bash
git add CONTRACT-ISSUES.md
git commit -m "docs: record relay contract gaps"
```

---

### Task 2: Infer runtime mode and permit self-hosted production startup

**Files:**

- Modify: `src/config.ts`
- Modify: `src/__tests__/app.test.ts`
- Modify: config literals in existing tests that construct `Config`

**Interfaces:**

- Produces: `type ServerMode = "selfhosted" | "relay" | "hosted"`.
- Produces: `Config.mode`, `Config.relayUrlExplicit`, and `Config.relayContent: "none" | "full"`.
- Preserves: `Config.relayUrl` as always-present effective URL for `/v1/info`.

- [ ] **Step 1: Add failing mode/config tests**

Add focused cases:

```ts
it("starts self-hosted production without push credentials", () => {
  expect(loadConfig({ NODE_ENV: "production", BASE_URL: "https://a.test" }, missingDefaultFile)).toMatchObject({
    mode: "selfhosted",
    relayUrl: "https://relay.critalarm.app",
    relayUrlExplicit: false,
  });
});

it("supports full relay content", () => {
  expect(loadConfig({ BASE_URL: "https://a.test", RELAY_CONTENT: "full" }, emptyFile).relayContent).toBe("full");
});

it("infers relay and hosted from push credentials and explicit relay URL", () => {
  expect(relayConfig.mode).toBe("relay");
  expect(hostedConfig.mode).toBe("hosted");
});
```

`missingDefaultFile` must throw an `ENOENT`-shaped error only for `critalarm.yml`; malformed or explicitly requested config files must still fail.

- [ ] **Step 2: Verify red**

Run:

```bash
npx vitest run src/__tests__/app.test.ts
```

Expected: failures because no-push production is rejected, full content is rejected, and mode fields do not exist.

- [ ] **Step 3: Implement minimal config model**

Use these exact definitions and inference:

```ts
export type ServerMode = "selfhosted" | "relay" | "hosted";

export interface Config {
  baseUrl: string;
  relayUrl: string;
  relayUrlExplicit: boolean;
  relayContent: "none" | "full";
  mode: ServerMode;
  // existing listen, port, dataDir, proxy, provider fields remain
}

const explicitRelayUrl = stringValue(env, "RELAY_URL", file["relay-url"]);
const hasPush = apns !== undefined || fcm !== undefined;
const mode: ServerMode = hasPush
  ? explicitRelayUrl === undefined ? "relay" : "hosted"
  : "selfhosted";
```

Requirements:

- Allow `relay-content` only `none|full`.
- Require complete provider blocks when any field for that provider exists.
- Require RevenueCat secret in production only when mode is `relay` or `hosted`.
- Ignore `ALLOW_NOOP_PUSH` for mode inference. Keep it only if existing unit push tests need injected no-op behavior; never require it for self-host startup.
- Treat absent default `critalarm.yml` as empty config. Treat absent explicit `CONFIG_PATH` as error.

- [ ] **Step 4: Update existing typed config fixtures mechanically**

Add `mode` and `relayUrlExplicit` to existing `Config` literals. Do not change test meaning.

- [ ] **Step 5: Verify green and build**

Run:

```bash
npx vitest run src/__tests__/app.test.ts
npm run build
```

Expected: both exit 0.

- [ ] **Step 6: Show scope and commit**

```bash
git diff --name-only
git add src/config.ts src/__tests__
git add src/ingress/__tests__ src/push/__tests__ src/v1/__tests__
git commit -m "fix: infer server runtime mode"
```

---

### Task 3: Add persistent self-host admin credentials and CLI

**Files:**

- Create: `src/admin/credentials.ts`
- Create: `src/admin/__tests__/credentials.test.ts`
- Create: `src/cli.ts`
- Modify: `src/store/migrations.ts`
- Modify: `src/incident/__tests__/service.test.ts`
- Modify: `package.json`
- Modify: `Dockerfile`

**Interfaces:**

- Produces: `SELF_HOSTED_ACCOUNT_ID = "acc_selfhosted"`.
- Produces: `ensureAdminCredential(db, clock, generate): { token: string; created: boolean }`.
- Produces: `showAdminToken(db): string | null`.
- Produces: `rotateAdminToken(db, generate): string`.
- Produces: `authenticateAdmin(db, token): boolean`.

- [ ] **Step 1: Add migration regression test**

Expect migration to create persistent settings while preserving re-run safety:

```ts
expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='server_settings'").get()).toBeDefined();
migrate(db);
expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 3 });
```

- [ ] **Step 2: Add failing credential lifecycle tests**

Cover exactly:

```ts
const first = ensureAdminCredential(db, clock, () => "ad_first");
const second = ensureAdminCredential(db, clock, () => "ad_unused");
expect(first).toEqual({ token: "ad_first", created: true });
expect(second).toEqual({ token: "ad_first", created: false });
expect(showAdminToken(db)).toBe("ad_first");
expect(authenticateAdmin(db, "ad_first")).toBe(true);
expect(authenticateAdmin(db, "ad_wrong")).toBe(false);
expect(rotateAdminToken(db, () => "ad_second")).toBe("ad_second");
expect(authenticateAdmin(db, "ad_first")).toBe(false);
```

Also assert singleton account exists and repeated initialization does not add another account.

- [ ] **Step 3: Verify red**

Run:

```bash
npx vitest run src/admin/__tests__/credentials.test.ts src/incident/__tests__/service.test.ts
```

Expected: missing module/table failures.

- [ ] **Step 4: Add schema and credential implementation**

Migration 3:

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

Store admin token in `server_settings` because contract requires retrieval. Compare supplied token using SHA-256 buffers and `timingSafeEqual`; do not log or return token except first boot and CLI commands.

- [ ] **Step 5: Add CLI contract**

`src/cli.ts` behavior:

```text
critalarm token show    -> token plus newline, exit 0
critalarm token rotate  -> new token plus newline, exit 0
anything else           -> usage on stderr, exit 2
missing initialized DB  -> clear error on stderr, exit 1
```

Resolve database path from `DATA_DIR`, YAML `data-dir`, or `/data` through `loadConfig`; do not start HTTP server. Add package bin:

```json
"bin": { "critalarm": "./src/cli.ts" }
```

Give `src/cli.ts` Node/tsx shebang and expose it in image:

```dockerfile
RUN chmod +x /app/src/cli.ts && ln -s /app/src/cli.ts /usr/local/bin/critalarm
```

- [ ] **Step 6: Verify green**

Run:

```bash
npx vitest run src/admin/__tests__/credentials.test.ts src/incident/__tests__/service.test.ts
npm run build
```

Expected: exit 0.

- [ ] **Step 7: Show scope and commit**

```bash
git diff --name-only
git add src/admin src/cli.ts src/store/migrations.ts src/incident/__tests__/service.test.ts package.json Dockerfile
git commit -m "feat: add self-host admin token"
```

---

### Task 4: Make V1 surface mode-aware and contract-only

**Files:**

- Modify: `src/v1/auth.ts`
- Modify: `src/v1/router.ts`
- Modify: `src/v1/topics.ts`
- Modify: `src/index.ts`
- Modify: `src/v1/__tests__/auth.test.ts`
- Modify: `src/v1/__tests__/info.test.ts`
- Modify: `src/v1/__tests__/topics.test.ts`
- Modify: `src/__tests__/mount-points.test.ts`

**Interfaces:**

- Consumes: `Config.mode`, `authenticateAdmin`, `SELF_HOSTED_ACCOUNT_ID`.
- Produces: `requireManagement(db, mode)` setting `{ accountId, deviceId }`.
- Preserves: relay/hosted account scoping and 404 anti-enumeration.

- [ ] **Step 1: Write failing mode/auth tests**

Add cases:

```ts
it("accepts only admin token in selfhosted mode", async () => {
  expect((await app.request("/v1/topics", { headers: bearer("ad_test") })).status).toBe(200);
  expect((await app.request("/v1/topics", { headers: bearer("dv_test") })).status).toBe(401);
});

it("accepts only scoped device token in relay and hosted modes", async () => {
  expect((await relay.request("/v1/topics", { headers: bearer("dv_test") })).status).toBe(200);
  expect((await relay.request("/v1/topics", { headers: bearer("ad_test") })).status).toBe(401);
});
```

Info table assertions:

```ts
expect(info).toEqual({
  name: "critalarm",
  version: "0.1.0",
  base_url: config.baseUrl,
  relay_url: config.relayUrl,
  relay_content: config.relayContent,
  mode: config.mode,
});
```

Mount assertion: `/v1/health` returns 404 because route is absent from contract.

- [ ] **Step 2: Verify red**

Run:

```bash
npx vitest run src/v1/__tests__/auth.test.ts src/v1/__tests__/info.test.ts src/__tests__/mount-points.test.ts
```

Expected: current code accepts device only, hardcodes hosted/none, and serves health.

- [ ] **Step 3: Implement management middleware and info**

Rules:

```ts
if (mode === "selfhosted") {
  // accept only ad_; bind SELF_HOSTED_ACCOUNT_ID
} else {
  // accept only dv_; preserve device/account scope
}
```

Initialize singleton account before creating app. Return config values from info. Remove `/v1/health`; do not replace it.

- [ ] **Step 4: Persist configured relay content on new topics**

Change `Row.relay_content` to `"none" | "full"`; insert `config.relayContent`, never hardcoded `none`. Verify topic creation still defaults `critical: false`, creates exactly one token, returns it once, and GET list never exposes it.

- [ ] **Step 5: Verify V1 suite and build**

Run:

```bash
npx vitest run src/v1 src/__tests__/mount-points.test.ts
npm run build
```

Expected: exit 0.

- [ ] **Step 6: Show scope and commit**

```bash
git diff --name-only
git add src/v1 src/index.ts src/__tests__/mount-points.test.ts
git commit -m "fix: honor management mode contract"
```

---

### Task 5: Make incident timing observable and wall-clock accurate

**Files:**

- Modify: `src/incident/types.ts`
- Modify: `src/incident/service.ts`
- Modify: `src/incident/scanner.ts`
- Modify: `src/incident/__tests__/service.test.ts`
- Modify: `src/incident/__tests__/scanner.test.ts`

**Interfaces:**

- Produces: internal `DomainEvent` union containing existing delivery kinds plus local-only `expire`.
- Produces: `isRelayPushEvent(event)` later filters only `open|repeat|reopen|p4`.
- Preserves: public incident state values and SQLite timer rows.

- [ ] **Step 1: Add failing expiration-event test**

Update fake-clock expectation:

```ts
clock.value = 1_060;
expect(service.scanDue()).toEqual([
  expect.objectContaining({ kind: "expire", incidentId: "inc_1", topicHash: "hash_prod" }),
]);
expect(db.prepare("SELECT state FROM incidents WHERE id='inc_1'").get()).toEqual({ state: "expired" });
expect(db.prepare("SELECT COUNT(*) AS count FROM timers").get()).toEqual({ count: 0 });
```

This is internal observability only. Push and relay layers must reject/filter `expire`.

- [ ] **Step 2: Add failing real-cadence scanner test**

With fake timers, use default interval and expect a due timer to be scanned within 500 ms. This protects `repeat_interval_s=2`; current 5000-ms cadence cannot demonstrate two-second repeats.

- [ ] **Step 3: Verify red**

Run:

```bash
npx vitest run src/incident/__tests__/scanner.test.ts
```

Expected: expiry currently returns no event and default scanner does not wake within 500 ms.

- [ ] **Step 4: Implement local expiry event and 250-ms scanner cadence**

Add `expire` to internal event type with existing identity fields. Return it only after transaction commits `state='expired'` and deletes timers. Set scanner default to 250 ms; continue catching dispatch rejection so later scans run.

Do not use in-memory timeout per incident. Single scanner interval remains allowed because timer truth remains in database.

- [ ] **Step 5: Verify all transition tests**

Run:

```bash
npx vitest run src/incident
npm run build
```

Expected: open, repeat, ack, desk reopen, close, expire, and recreation durability cases pass.

- [ ] **Step 6: Show scope and commit**

```bash
git diff --name-only
git add src/incident
git commit -m "fix: honor incident timer cadence"
```

---

### Task 6: Extract topic hashing and implement relay client

**Files:**

- Create: `src/relay/hash.ts`
- Create: `src/relay/types.ts`
- Create: `src/relay/client.ts`
- Create: `src/relay/__tests__/hash.test.ts`
- Create: `src/relay/__tests__/client.test.ts`
- Modify: `src/v1/topics.ts`
- Modify: `src/incident/types.ts`
- Modify: `src/ingress/types.ts`
- Modify: `src/ingress/service.ts`
- Modify: relevant ingress tests

**Interfaces:**

- Produces: `topicHash(baseUrl: string, topic: string): string`.
- Produces: `RelayPushKind = "open" | "repeat" | "reopen" | "p4"`.
- Produces: `RelayPushPayload` matching §4.1 exactly.
- Produces: `RelayClient.dispatch(events: readonly DomainEvent[]): Promise<void>`.
- Consumes: injected `fetch`, SQLite database, effective relay URL, base URL, version, relay content.

- [ ] **Step 1: Write failing hash test**

```ts
expect(topicHash("https://alerts.example.com", "prod")).toBe(
  createHash("sha256").update("https://alerts.example.com/prod").digest("hex"),
);
expect(topicHash("https://alerts.example.com/", "prod")).not.toBe(topicHash("https://alerts.example.com", "prod"));
```

Second assertion locks exact concatenation; do not normalize contract input silently.

- [ ] **Step 2: Write failing wire-shape tests**

For `relay-content: none`, body keys equal:

```ts
["incident_id", "kind", "message_id", "priority", "topic_hash"]
```

For `relay-content: full`, body additionally contains exact `title` and `body`. Assert `expire` and internal `p5` create no `/relay/v1/push` request.

- [ ] **Step 3: Write failing first-forward key test**

Injected fetch sequence:

```text
POST /relay/v1/servers -> 201 {"relay_key":"rk_first"}
POST /relay/v1/push    -> 202
POST /relay/v1/push    -> 202
```

Assert registration request is exactly `{base_url, version}`, push auth is `Bearer rk_first`, and second dispatch plus new `RelayClient` over same DB does not register again.

- [ ] **Step 4: Verify red**

Run:

```bash
npx vitest run src/relay/__tests__/hash.test.ts src/relay/__tests__/client.test.ts
```

Expected: missing modules.

- [ ] **Step 5: Implement strict relay client**

Rules:

```ts
export function isRelayPushEvent(event: DomainEvent): event is RelayDeliveryEvent {
  return event.kind === "open" || event.kind === "repeat" || event.kind === "reopen" || event.kind === "p4";
}
```

- Load key from `relay_client_credentials` by relay URL.
- If absent, POST `/relay/v1/servers`, require 201 plus `rk_` token, then persist it before push.
- POST each supported event to `/relay/v1/push` with bearer key.
- Treat 202 as accepted. Log sanitized status on other responses; never log key or body content.
- Keep message storage successful when relay is unavailable. Runtime logging owns delivery failure reporting.
- Reuse `topicHash` from `src/v1/topics.ts`; remove inline SHA call.
- Add `relayContent` to topic/event path so serializer can choose shape.
- Remove `PublishService.p4Available`; publisher-side account is not relay subscriber account. Always emit p4 event.

- [ ] **Step 6: Verify green and ingress regression suite**

Run:

```bash
npx vitest run src/relay/__tests__/hash.test.ts src/relay/__tests__/client.test.ts src/ingress
npm run build
```

Expected: exit 0.

- [ ] **Step 7: Show scope and commit**

```bash
git diff --name-only
git add src/relay src/v1/topics.ts src/incident/types.ts src/ingress
git commit -m "feat: forward relay delivery events"
```

---

### Task 7: Add authenticated relay ingress and topic-hash fanout

**Files:**

- Create: `src/relay/router.ts`
- Create: `src/relay/__tests__/router.test.ts`
- Modify: `src/push/dispatcher.ts`
- Modify: `src/push/__tests__/dispatcher.test.ts`
- Modify: `src/push/apns.ts`
- Modify: `src/push/fcm.ts`
- Modify: provider payload tests
- Modify: `src/index.ts`
- Modify: `src/__tests__/mount-points.test.ts`

**Interfaces:**

- Produces: `createRelayRouter({ db, clock, ids, dispatchRelay, log }): Hono`.
- Produces: `PushDispatcher.dispatchRelay(events)` querying all subscribed devices by hash.
- Preserves: `PushDispatcher.dispatchLocal(events)` account-scoped hosted delivery.

- [ ] **Step 1: Write failing server-key issuance tests**

Test exact behavior:

```ts
const response = await app.request("/relay/v1/servers", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ base_url: "https://a.test", version: "0.1.0" }),
});
expect(response.status).toBe(201);
expect(await response.json()).toEqual({ relay_key: expect.stringMatching(/^rk_/) });
expect(stored.relay_key_hash).not.toContain("rk_");
```

Issue each call independently; contract does not define recovery/deduplication by base URL.

- [ ] **Step 2: Write failing push authentication and validation tests**

Cover missing/wrong key = 401, malformed body = 400, valid strict shape = 202. Reject unknown `kind`, half-present full content, invalid 64-char lowercase hex hash, and mismatched priority/kind (`p4` requires 4; incident kinds require 5).

- [ ] **Step 3: Write failing fanout test**

Create two subscribed devices under different accounts plus one unrelated device. POST valid relay payload. Assert injected `dispatchRelay` receives one event and real dispatcher selects exactly both matching devices using only `topic_hash`, not local `message_id` ownership.

- [ ] **Step 4: Write failing P4-cap tests**

Use existing `capsFor(account.tier).p4_daily`. Assert one P4 increments each matching account once regardless of device count, capped accounts are excluded, mixed eligible/capped accounts return 202, all-capped matching accounts return exact 429 `{ "error":"cap", "cap":"p4_daily" }`, and no-subscriber hash returns 202 without usage row.

- [ ] **Step 5: Verify red**

Run:

```bash
npx vitest run src/relay/__tests__/router.test.ts src/push/__tests__/dispatcher.test.ts
```

Expected: route/method missing and current dispatcher cannot resolve remote message IDs.

- [ ] **Step 6: Implement ingress**

Zod schemas must use `.strict()` for relay wire objects so server does not accidentally accept invented fields. On valid request:

1. Authenticate `rk_` by SHA-256 hash using timing-safe comparison.
2. Resolve `base_url` from authenticated relay-server row.
3. Log one structured line before provider dispatch:

```text
relay_push_received topic_hash=<64hex> kind=<kind> incident_id=<id-or-null> message_id=<id>
```

4. Return 202 after accepting work.
5. Start fanout and catch/log provider error without changing accepted response.

Map absent title/body to relay content `none`, generic title `Crit Alarm`, generic fallback body, and 1800-second TTL per contract-issue lock.

- [ ] **Step 7: Implement subscriber eligibility and dual dispatcher queries**

For P4, group matching subscriptions by account. In one transaction, compare each account's UTC-day counter with `capsFor(tier).p4_daily`, increment each eligible account once, and pass eligible account IDs to relay dispatch. Return 429 only when matching subscriptions exist and no account is eligible.

Keep current account/message ownership query as `dispatchLocal`. Add relay query:

```sql
SELECT DISTINCT d.id, d.account_id, d.platform, d.push_token
FROM devices d
JOIN subscriptions s ON s.device_id = d.id
WHERE s.topic_hash = ? AND d.push_token <> ''
  AND d.account_id IN (eligible account ids)
```

Do not import relay from incident package.

- [ ] **Step 8: Add full-content provider payload tests**

APNs full event: real title/body, no `mutable-content`. FCM full event: `data.title` and `data.body`. None event: no real title/body in relay wire or FCM data. Keep critical sound only for critical incident kinds.

- [ ] **Step 9: Gate relay routes by mode**

Mount device, server, push, and RevenueCat relay routes only for `relay|hosted`. In `selfhosted`, `/relay/v1/servers`, `/relay/v1/push`, `/relay/v1/devices`, and webhook return 404.

- [ ] **Step 10: Verify green**

Run:

```bash
npx vitest run src/relay src/push src/__tests__/mount-points.test.ts
npm run build
```

Expected: exit 0.

- [ ] **Step 11: Show scope and commit**

```bash
git diff --name-only
git add src/relay src/push src/index.ts src/__tests__/mount-points.test.ts
git commit -m "feat: accept relay push events"
```

---

### Task 8: Compose runtime, startup logs, and delivery routing

**Files:**

- Modify: `src/main.ts`
- Create: `src/__tests__/runtime.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Produces: testable `createRuntime(config, db, dependencies)` or smaller pure `deliveryTarget(config.mode)` composition seam.
- Consumes: `RelayClient`, `PushDispatcher`, `ensureAdminCredential`, timer scanner.

- [ ] **Step 1: Write failing runtime-routing tests**

Assert:

```text
selfhosted -> RelayClient only
relay      -> local PushDispatcher only + relay ingress mounted
hosted     -> local PushDispatcher only + relay ingress mounted
expire     -> logged locally, never handed to relay or provider
```

Also capture log sink and assert admin token appears only when `created: true`.

- [ ] **Step 2: Verify red**

Run:

```bash
npx vitest run src/__tests__/runtime.test.ts
```

Expected: current minified main always dispatches directly and prints no startup/admin/event logs.

- [ ] **Step 3: Rewrite main into readable composition**

Startup order:

```text
load config
open database
run migrations
ensure self-host account/admin credential when selfhosted
construct provider senders only when configured
construct local dispatcher or relay client from mode
create app with same incident service/dispatch callback
scan persisted due timers once
start 250-ms scanner
log config summary without secrets
log first-created admin token once
serve and install graceful shutdown
```

Every domain event logs:

```text
incident_event kind=<kind> topic_hash=<hash> incident_id=<id-or-null> message_id=<id>
```

Never log title, body, publish token, admin token after first creation, relay key, device token, or push token.

- [ ] **Step 4: Make dispatch best-effort after durable state commit**

Publication remains 200 after message/incident commit even when relay/provider rejects. Catch per batch in runtime, log sanitized error, and leave SQLite incident timers active for later repeats. Do not retry outside existing incident repeat schedule.

- [ ] **Step 5: Verify runtime and full unit suite**

Run:

```bash
npx vitest run src/__tests__/runtime.test.ts
npm test
npm run build
```

Expected: more than 130 tests; all pass; build exit 0.

- [ ] **Step 6: Show scope and commit**

```bash
git diff --name-only
git add src/main.ts src/index.ts src/__tests__/runtime.test.ts
git commit -m "fix: compose mode-specific delivery"
```

---

### Task 9: Run Phase 1 and ordered Phase 2 contract walk

**Files:**

- No repository files changed unless a reproduced divergence receives its own red-green unit test and surgical fix.

**Interfaces:**

- Consumes: built Docker image and persistent named volume.
- Produces: transcript evidence for every required request/response.

- [ ] **Step 1: Build final image and create persistent volume**

Run:

```bash
docker build -t critalarm-server:e2e .
docker volume create critalarm-a-data
docker run --name critalarm-a -d -p 4101:8080 -v critalarm-a-data:/data -e BASE_URL=http://localhost:4101 -e RELAY_URL=http://host.docker.internal:4102 critalarm-server:e2e
docker logs critalarm-a
docker exec critalarm-a critalarm token show
```

Expected: image build exit 0; first log contains `ad_...`; CLI returns identical token; startup line contains mode `selfhosted`, base URL, relay URL, content mode, listen/data/proxy values.

- [ ] **Step 2: Verify info**

Run and paste request plus response:

```bash
curl -i http://localhost:4101/v1/info
```

Expected 200 with `mode:"selfhosted"`, configured `base_url`, `version:"0.1.0"`, relay URL, and relay content.

- [ ] **Step 3: Create `/tmp/critalarm-e2e.sh` using `apply_patch`**

Script must use `set -eu`, print each curl command before running it, and preserve response headers/body. It may extract IDs/tokens with `node -e`; keep parsing commands separate from curls so evidence stays readable.

Ordered requests required:

1. `POST /v1/topics` create `prod`; save returned token.
2. `GET /v1/topics`; prove token absent.
3. Create noncritical `quiet`; save token.
4. `PATCH /v1/topics/prod` with `critical:true`.
5. `POST /prod` with `Priority: 5`.
6. `POST /prod?p=urgent`.
7. JSON `POST /` with priority 5.
8. `POST /prod?auth=<base64 Bearer token>` with priority 5.
9. Compare four `incident_id` values; fail script unless identical.
10. `POST /quiet` priority 5; prove no `incident_id`.
11. Priority 4 then priority 3; prove stored, no incident.
12. Every §1.3 header alias, one curl each: `X-Title`, `Title`, `ti`, `t`, `X-Priority`, `Priority`, `prio`, `p`, `X-Tags`, `Tags`, `tag`, `ta`, `X-Click`, `Click`, `X-Markdown`, `Markdown`, `md`.
13. Query short names `t`, `p`, `ta`, `m`.
14. Every delayed alias: `X-Delay`, `At`, `In`; all 400. Also JSON `delay` 400.
15. Missing token 401 with exact numeric body.
16. Bad topic name 400 with exact numeric body.
17. 4097-byte UTF-8 request body 413 with exact numeric body.
18. `GET /quiet/json?poll=1`.
19. Save a message id, publish another, then `GET /quiet/json?poll=1&since=<id>`; prove only later rows.
20. ACK open incident 200; second ACK 409.
21. Close a fresh open incident before ACK 409; then ACK 200 and close 200; second close 409.
22. `POST /v1/test?topic=quiet` returns exact 409.

Use both POST and PUT publish at least once. Use Basic auth at least once because §1.2 is part of contract even though acceptance list names query auth.

- [ ] **Step 4: Run contract walk and paste all output**

Run:

```bash
bash /tmp/critalarm-e2e.sh
```

Expected: script exit 0. Paste complete request and response stream, not summary.

- [ ] **Step 5: Treat every mismatch with red-green discipline**

For each mismatch:

1. State expected and actual response.
2. Trace root cause to source.
3. Add one minimal unit test and run it to see expected failure.
4. Apply smallest fix.
5. Re-run focused test and whole related suite.
6. Rebuild image and repeat affected curl.
7. Commit with plain message naming behavior.

Never adjust curl expectation to current implementation when contract is clear.

---

### Task 10: Prove timers, ACK-stop, expiry, and restart durability

**Files:**

- No repository files changed unless proof exposes divergence.

**Interfaces:**

- Produces: timestamped A logs and API responses tied to incident IDs.

- [ ] **Step 1: Configure short timers**

Create a fresh critical topic `timers` and patch:

```json
{"critical":true,"repeat_interval_s":2,"max_ring_s":6,"desk_timer_s":4}
```

Paste PATCH request/response.

- [ ] **Step 2: Prove two-second repeats**

Publish priority 5. Record incident ID. Wait seven seconds using separate command, then show:

```bash
docker logs --timestamps critalarm-a
```

Expected A lines: `open`, repeats spaced about two seconds, then local `expire` around six seconds. Confirm incident GET state `expired`.

- [ ] **Step 3: Prove ACK stops repeats and desk timer reopens**

Publish fresh incident. Wait until one repeat appears, ACK, record log cutoff, wait five seconds, then show logs and incident GET.

Expected: no `repeat` between ACK and `reopen`; one `reopen` near four seconds; new repeats resume after reopen. Close only after ACK if cleanup needed.

- [ ] **Step 4: Prove restart survival mid-incident**

Create `restart` topic with enough `max_ring_s` to restart safely, publish, then:

```bash
docker restart critalarm-a
docker exec critalarm-a critalarm token show
curl -i -H "Authorization: Bearer ad_value_from_cli" http://localhost:4101/v1/incidents/incident_value
docker logs --timestamps critalarm-a
```

Expected: same admin token, same incident ID/state/messages, and repeat/expire timers continue after restart.

- [ ] **Step 5: Fix only reproduced timer divergence**

Use same red-green loop as Task 9. Rebuild and repeat exact proof after any fix.

---

### Task 11: Run two-container relay proof

**Files:**

- No repository files changed unless proof exposes divergence.

**Interfaces:**

- Produces: B logs for accepted `open`, `repeat`, and `reopen`; A logs for `expire`; ACK-stop silence; persisted relay key behavior.

- [ ] **Step 1: Start isolated Docker network and B relay**

Run simple commands separately:

```bash
docker network create critalarm-e2e
docker volume create critalarm-b-data
docker run --name critalarm-b -d --network critalarm-e2e -p 4102:8080 -v critalarm-b-data:/data -e BASE_URL=http://localhost:4102 -e APNS_TEAM_ID=fake-team -e APNS_KEY_ID=fake-key -e APNS_PRIVATE_KEY=fake-private-key -e APNS_BUNDLE_ID=app.critalarm.fake -e REVENUECAT_SHARED_SECRET=fake-secret critalarm-server:e2e
docker logs critalarm-b
```

Expected: mode `relay`; fake provider values accepted as configuration. Provider delivery may log sanitized failure after receipt; receipt still returns 202.

- [ ] **Step 2: Restart A against B by container DNS**

Replace A container without deleting `critalarm-a-data`:

```bash
docker rm -f critalarm-a
docker run --name critalarm-a -d --network critalarm-e2e -p 4101:8080 -v critalarm-a-data:/data -e BASE_URL=http://localhost:4101 -e RELAY_URL=http://critalarm-b:8080 critalarm-server:e2e
docker logs critalarm-a
```

Expected: mode `selfhosted`, same admin token/data.

- [ ] **Step 3: Register B device and subscribe to A topic hash**

Use relay device API exactly as §4.2. Save `dv_` token and calculate:

```ts
createHash("sha256").update("http://localhost:4101/relayproof").digest("hex")
```

POST subscription with hash. Paste requests/responses. Query B SQLite only if needed to prove row; API proof preferred.

- [ ] **Step 4: Prove open and first key issuance**

Create/patch `relayproof` on A with 2/6/4 timers and publish. Show A logs and B logs:

```bash
docker logs --timestamps critalarm-a
docker logs --timestamps critalarm-b
```

Expected B line includes exact computed hash, `kind=open`, correct incident/message IDs. Inspect A database credential count before/after another forward; it stays one.

- [ ] **Step 5: Prove repeat, ACK-stop, and reopen**

Wait for B `repeat`, ACK on A, note timestamp, wait five seconds, then show both logs.

Expected B sequence:

```text
open
repeat
[no repeat while acked]
reopen
```

After reopen, repeats may resume. Do not claim ACK wire event.

- [ ] **Step 6: Prove expiry closest to contract**

Create fresh short incident and do not ACK. Expected:

- B receives `open` and `repeat` only.
- A logs local `expire` around six seconds and incident GET returns `expired`.
- B does not receive `kind=expire`, because §4.1 forbids it.

Paste this as explicit contract limitation referencing `CONTRACT-ISSUES.md`. If evaluator insists on B `expire`, stop and request contract authorization; do not invent enum value.

- [ ] **Step 7: Prove p4**

Publish priority 4 on A. Expected B log has exact hash, `kind=p4`, null incident ID, and correct message ID.

- [ ] **Step 8: Prove relay-key persistence across A restart**

Restart A, trigger another supported event, and verify B issued no second key while accepting push with stored key.

---

### Task 12: Update architecture and README

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`

**Interfaces:**

- Documents: exact implemented mode inference and config names.

- [ ] **Step 1: Update architecture §3**

Document:

- explicit-relay-URL mode inference table from this plan;
- selfhost uses relay client, relay/hosted use local push;
- relay APIs exist only with push credentials;
- admin vs device management credential choice;
- effective default relay URL does not count as explicit for hosted inference.

Update §7's stale “every 5 s” sentence to 250 ms. Also explain that self-hosted mode uses one internal `acc_selfhosted` ownership row while storing no devices; this reconciles implementation with existing topic foreign keys.

- [ ] **Step 2: Replace stale README status and add config table**

Minimum rows:

| YAML | Environment | Default | Meaning |
|---|---|---|---|
| `base-url` | `BASE_URL` | required | Canonical hash/server URL |
| `relay-url` | `RELAY_URL` | Crit Alarm relay | Forward target; explicit presence helps infer hosted mode |
| `relay-content` | `RELAY_CONTENT` | `none` | `none` or `full` wire content |
| `listen` | `LISTEN` / `PORT` | `:8080` | Listener |
| `data-dir` | `DATA_DIR` | `/data` | SQLite and credentials |
| `behind-proxy` | `BEHIND_PROXY` | `false` | Trusted client-IP headers |

Also list APNs, FCM, RevenueCat credential env names without values. Never include real credentials or prices.

- [ ] **Step 3: Verify docs match implementation**

Run:

```bash
rg -n "relay-url|relay-content|selfhosted|hosted|relay" README.md docs/ARCHITECTURE.md src/config.ts
git diff --check
```

Expected: names/defaults agree; diff check exit 0.

- [ ] **Step 4: Commit docs**

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: explain relay configuration"
```

---

### Task 13: Final verification and main commit audit

**Files:**

- No planned edits. Fix only failures tied to this task using focused red-green commits.

**Interfaces:**

- Produces: fresh completion evidence against every acceptance condition.

- [ ] **Step 1: Run fresh full gates**

```bash
npm test
npm run build
```

Expected: test exit 0, build exit 0, final test count greater than baseline 130.

- [ ] **Step 2: Rebuild image from committed tree**

```bash
docker build -t critalarm-server:final .
```

Expected: exit 0.

- [ ] **Step 3: Re-run smoke proof from final image if prior Docker proof used uncommitted image**

At minimum recheck first-boot token, CLI equality, `/v1/info`, one critical open, one repeat, ACK-stop, one reopen, restart survival, p4 relay, and local expiry.

- [ ] **Step 4: Audit contract immutability and file scope**

Run:

```bash
git diff origin/main -- docs/api.md
git status --short --branch
git diff --name-only origin/main
git log --oneline origin/main..HEAD
```

Expected: no `docs/api.md` diff; branch `main`; no unstaged/uncommitted task files; only planned files changed; commits use plain scoped messages.

- [ ] **Step 5: Audit acceptance evidence line by line**

Transcript must contain:

- Docker build and run output.
- first-boot admin token and identical CLI result.
- `/v1/info` response.
- every ordered Phase 2 curl request and response.
- same incident ID across four open publications.
- full alias/error/poll/ack/close/test-alarm proof.
- timestamped repeat, ACK-stop, reopen, expiry, and restart-survival evidence.
- baseline and final npm test counts.
- B relay logs for `open`, `repeat`, `reopen`, and `p4`.
- A expiry log plus written reason B cannot receive `expire` under §4.1.
- `CONTRACT-ISSUES.md` existence/content.
- final clean `main` status and commit log.

- [ ] **Step 6: Commit any remaining planned artifact**

Only if status shows intended non-planning implementation files:

```bash
git add exact-file-list-from-status
git commit -m "test: verify contract end to end"
```

Never stage `docs/superpowers/` or any planning markdown. Never use `git add .`. Do not push unless separately requested.

## Stop Conditions for Luna

Stop and ask instead of guessing when:

- Any required API field/header/route is absent from `docs/api.md`.
- B-side `expire` remains mandatory despite strict §4.1 enum.
- Mode inference expectation differs from locked table.
- Existing dirty work overlaps a planned file and ownership is unclear.
- Three distinct fixes fail for same root cause.
