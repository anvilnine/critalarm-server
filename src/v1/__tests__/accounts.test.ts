import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { Config } from "../../config.js";
import type { IdentityResolver } from "../../auth/identity.js";
import { providerTokenRevoker, type TokenRevoker } from "../../auth/revoke.js";
import { deleteAccount, findAccount } from "../accounts.js";

// api.md §3.7. Everything below stays on our side of the OAuth boundary: an
// identity_token is resolved through better-auth's own `session` table, which is
// what the real resolver reads, so no Apple or Google credential is involved.
// What the providers do with a redirect is not testable here and is not tested.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// A real-looking wall clock, because session expiry is compared against it and
// an epoch-zero clock would make every ISO date in these tests look like the
// future.
const NOW = 1_760_000_000;

function setup(options: { mode?: Config["mode"]; identities?: IdentityResolver; revoke?: TokenRevoker; revenueCat?: Config["revenueCat"]; authHandler?: (request: Request) => Promise<Response> } = {}) {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  for (const id of ["a", "b"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
  for (const [id, account, token] of [["da", "a", "dv_a"], ["db", "b", "dv_b"]]) {
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, ?, ?, 'ios', 'x', 1)")
      .run(id, account, createHash("sha256").update(token).digest("hex"));
  }
  const app = createApp({
    config: { ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.revenueCat === undefined ? {} : { revenueCat: options.revenueCat }), baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
    db,
    clock: { now: () => NOW },
    ids: { message: () => `m_${Math.random()}`, incident: () => `inc_${Math.random()}`, timer: () => `tm_${Math.random()}` },
    dispatch: async () => {},
    ...(options.identities === undefined ? {} : { identities: options.identities }),
    ...(options.revoke === undefined ? {} : { revoke: options.revoke }),
    ...(options.authHandler === undefined ? {} : { authHandler: options.authHandler }),
  });
  return { app, db };
}

// A better-auth session row and the user behind it. This is exactly what the
// OAuth callback would have written, minus the callback.
function seedIdentity(db: ReturnType<typeof openDatabase>, userId: string, token: string, expiresAt = "2099-01-01T00:00:00.000Z") {
  db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, 0, 0)').run(userId, userId, `${userId}@example.com`);
  db.prepare('INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, 0, 0, ?)').run(`ses_${token}`, expiresAt, token, userId);
}

function json(device: string) {
  return { Authorization: `Bearer ${device}`, "content-type": "application/json" };
}

function post(app: ReturnType<typeof createApp>, path: string, device: string, body: Record<string, unknown>) {
  return app.request(path, { method: "POST", headers: json(device), body: JSON.stringify(body) });
}

async function makeTopic(app: ReturnType<typeof createApp>, device: string, name: string, critical = false) {
  const response = await post(app, "/v1/topics", device, { name, critical });
  expect(response.status).toBe(201);
  return await response.json() as { name: string; token: string; token_id: string };
}

function publish(app: ReturnType<typeof createApp>, topic: string, token: string, priority = 5) {
  return app.request(`/${topic}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Priority": String(priority) }, body: "wake up" });
}

function accountOf(db: ReturnType<typeof openDatabase>, deviceId: string) {
  return (db.prepare("SELECT account_id FROM devices WHERE id = ?").get(deviceId) as { account_id: string }).account_id;
}

function tombstoneOf(db: ReturnType<typeof openDatabase>, accountId: string) {
  return (db.prepare("SELECT merged_into FROM accounts WHERE id = ?").get(accountId) as { merged_into: string | null }).merged_into;
}

describe("POST /v1/account/link", () => {
  it("claims the account the device already has and moves nothing", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    const topic = await makeTopic(app, "dv_a", "prod");

    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a", outcome: "claimed" });

    // Nothing moved: same account, same topic owner, same working token.
    expect(accountOf(db, "da")).toBe("a");
    expect(tombstoneOf(db, "a")).toBeNull();
    expect((db.prepare("SELECT account_id FROM topics WHERE name = ?").get("prod") as { account_id: string }).account_id).toBe("a");
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM subscriptions").get()).toEqual({ count: 1 });
  });

  it("is safe to call twice", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    const again = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ account_id: "a", outcome: "claimed" });
  });

  it("attaches an empty account with no prompt and tombstones it", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    // The identity's own account is b, claimed from the other handset.
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    await makeTopic(app, "dv_b", "prod");

    // Account a holds no topics and no incidents, so there is nothing to decide.
    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "b", outcome: "attached" });

    expect(accountOf(db, "da")).toBe("b");
    expect(tombstoneOf(db, "a")).toBe("b");
    // dv_ does not change, and it now reads the identity's account.
    const topics = await app.request("/v1/topics", { headers: json("dv_a") });
    expect(topics.status).toBe(200);
    expect((await topics.json() as { name: string }[]).map((t) => t.name)).toEqual(["prod"]);
  });

  it("asks rather than choosing when the device's account has content", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    const topic = await makeTopic(app, "dv_a", "prod", true);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);

    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "choose", into_account: "b", topics: 1, incidents: 1 });
    // The refusal changed nothing.
    expect(accountOf(db, "da")).toBe("a");
    expect(tombstoneOf(db, "a")).toBeNull();
  });

  it("refuses the shared handset with 409, not a constraint failure", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    // usr_1 claims account a from this device.
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    // usr_2 already holds account b.
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_2" })).status).toBe(200);

    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_2" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "account has another identity" });
  });

  it("refuses a brand new identity on an already claimed account with 409", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    // usr_2 has no account of its own, so only the unique index on
    // account_identities.account_id stands between this and a 500.
    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_2" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "account has another identity" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_identities").get()).toEqual({ count: 1 });
  });

  it("answers 401 for an unknown or expired identity token", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_expired", "2000-01-01T00:00:00.000Z");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_nope" })).status).toBe(401);
    const expired = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_expired" });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: "unauthorized" });
  });

  it("reads the device credential only from the header", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    const noHeader = await app.request("/v1/account/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity_token: "sess_1", device_token: "dv_a" }) });
    expect(noHeader.status).toBe(401);
    const queryString = await app.request("/v1/account/link?auth=dv_a", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity_token: "sess_1" }) });
    expect(queryString.status).toBe(401);
  });

  it("answers 400 for a body with no identity token", async () => {
    const { app } = setup();
    expect((await post(app, "/v1/account/link", "dv_a", {})).status).toBe(400);
  });

  it("takes a substituted resolver, so the OAuth boundary is not in the way", async () => {
    const identities: IdentityResolver = { resolve: (token) => (token === "fake" ? { userId: "usr_fake" } : null) };
    const { app } = setup({ identities });
    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "fake" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a", outcome: "claimed" });
  });
});

describe("POST /v1/account/switch", () => {
  it("moves the device, tombstones the old account and carries nothing with it", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    await makeTopic(app, "dv_a", "prod", true);

    const response = await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1", into_account: "b" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "b" });

    expect(accountOf(db, "da")).toBe("b");
    expect(tombstoneOf(db, "a")).toBe("b");
    // Nothing moved with it: the topic stays on the tombstone.
    expect((db.prepare("SELECT account_id FROM topics WHERE name = ?").get("prod") as { account_id: string }).account_id).toBe("a");
    const topics = await app.request("/v1/topics", { headers: json("dv_a") });
    expect(await topics.json()).toEqual([]);
  });

  it("leaves no token on the abandoned account that can open an incident nobody will see", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    const before = await makeTopic(app, "dv_a", "before", true);
    const after = await makeTopic(app, "dv_a", "after", true);
    // The setup can open an incident: prove it on one topic before the switch.
    expect((await publish(app, "before", before.token)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM incidents").get()).toEqual({ count: 1 });

    expect((await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1", into_account: "b" })).status).toBe(200);

    // The webhook still holds the token and still calls. It gets nothing.
    const publishAfter = await publish(app, "after", after.token);
    expect(publishAfter.status).toBe(401);
    const repeat = await publish(app, "before", before.token);
    expect(repeat.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM incidents").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM topic_tokens").get()).toEqual({ count: 0 });
    // And no handset is left subscribed to the abandoned topics.
    expect(db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE device_id = 'da'").get()).toEqual({ count: 0 });
  });

  it("stops an aj_ token attaching a new handset to the tombstone", async () => {
    const { app, db } = setup();
    db.prepare("UPDATE accounts SET join_token_hash = ? WHERE id = 'a'").run(createHash("sha256").update("aj_a").digest("hex"));
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    await makeTopic(app, "dv_a", "prod");
    expect((await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1", into_account: "b" })).status).toBe(200);
    expect(tombstoneOf(db, "a")).toBe("b");
    expect((db.prepare("SELECT join_token_hash FROM accounts WHERE id = 'a'").get() as { join_token_hash: string | null }).join_token_hash).toBeNull();
  });

  it("answers 401 when the identity does not own the account named in the body", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    // usr_2 has no account at all, so it cannot authorise a switch into b.
    expect((await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_2", into_account: "b" })).status).toBe(401);
    // And usr_1 cannot name an account it does not hold.
    expect((await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1", into_account: "acc_elsewhere" })).status).toBe(401);
    expect(tombstoneOf(db, "a")).toBeNull();
  });

  it("does nothing when the device is already on the identity's account", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    const topic = await makeTopic(app, "dv_a", "prod", true);

    const response = await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1", into_account: "a" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a" });
    expect(tombstoneOf(db, "a")).toBeNull();
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
  });

  it("refuses the shared handset with 409", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_2" })).status).toBe(200);
    const response = await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_2", into_account: "b" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "account has another identity" });
    expect(tombstoneOf(db, "a")).toBeNull();
  });

  it("answers 400 for a body with no target account", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1" })).status).toBe(400);
  });
});

// S18. The path exists so the 409 {"error":"choose"} that link returns points
// somewhere, and it says what it is instead of answering 404.
describe("POST /v1/account/merge", () => {
  it("answers 501 not implemented", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    const response = await post(app, "/v1/account/merge", "dv_a", { identity_token: "sess_1", into_account: "b" });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "not implemented" });
  });
});

// api.md §3.7, the erase.
function del(app: ReturnType<typeof createApp>, device: string, body?: Record<string, unknown>) {
  if (body === undefined) return app.request("/v1/account", { method: "DELETE", headers: { Authorization: `Bearer ${device}` } });
  return app.request("/v1/account", { method: "DELETE", headers: json(device), body: JSON.stringify(body) });
}

function rows(db: ReturnType<typeof openDatabase>, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

// The rows a delete has to reach that no route creates: push tokens, relay
// usage, and the billing trail.
function seedExtras(db: ReturnType<typeof openDatabase>, accountId: string, deviceId: string) {
  db.prepare("INSERT INTO device_tokens (device_id, kind, activity_id, incident_id, token, updated_at) VALUES (?, 'apns', '', NULL, 'push-token', 1)").run(deviceId);
  db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES (?, 0, 3)").run(accountId);
  db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at) VALUES (?, ?, 1)").run(`rc_${accountId}`, accountId);
  db.prepare("INSERT INTO billing_events (event_id, app_user_id, account_id, type, event_at, applied, received_at) VALUES ('evt_1', ?, ?, 'INITIAL_PURCHASE', 1, 1, 1)").run(`rc_${accountId}`, accountId);
  db.prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES ('tc_1', ?, 'free', 'relay', 'purchase', 'evt_1', 1)").run(accountId);
  db.prepare("INSERT INTO account_merges (id, from_account, into_account, merged_at, detail) VALUES ('mg_1', 'gone', ?, 1, '{}')").run(accountId);
}

async function ackEverything(app: ReturnType<typeof createApp>, device: string) {
  const list = await (await app.request("/v1/incidents", { headers: json(device) })).json() as { id: string }[];
  for (const incident of list) expect((await app.request(`/v1/incidents/${incident.id}/ack`, { method: "POST", headers: json(device) })).status).toBe(200);
}

describe("DELETE /v1/account", () => {
  it("erases an account with no identity on the device token alone", async () => {
    const { app, db } = setup();
    const topic = await makeTopic(app, "dv_a", "prod", true);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
    await ackEverything(app, "dv_a");
    seedExtras(db, "a", "da");

    // An acked incident does not block: nothing is ringing.
    expect((await del(app, "dv_a")).status).toBe(204);

    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(0);
    // Account b and its handset are the only rows left in the database, so
    // whole-table counts say whether anything of account a survived.
    for (const table of ["topics", "topic_tokens", "incidents", "timers", "messages", "subscriptions", "device_tokens", "relay_p4_usage", "account_billing_ids", "tier_changes", "account_merges"]) {
      expect([table, rows(db, `SELECT COUNT(*) AS count FROM ${table}`)]).toEqual([table, 0]);
    }
    // The other account is untouched.
    expect(rows(db, "SELECT COUNT(*) AS count FROM devices WHERE account_id = 'a'")).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS count FROM devices WHERE account_id = 'b'")).toBe(1);
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'b'")).toBe(1);
    // billing_events is the only place the account is allowed to survive, and
    // only as a cleared reference.
    expect(db.prepare("SELECT account_id FROM billing_events WHERE event_id = 'evt_1'").get()).toEqual({ account_id: null });
  });

  it("refuses without the identity token once the account has one", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);

    const noBody = await del(app, "dv_a");
    expect(noBody.status).toBe(401);
    expect(await noBody.json()).toEqual({ error: "unauthorized" });
    expect((await del(app, "dv_a", {})).status).toBe(401);
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(1);
  });

  it("refuses somebody else's identity token", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    // usr_2 holds account b, and a valid token for it is still not authority
    // over account a.
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_2" })).status).toBe(200);

    expect((await del(app, "dv_a", { identity_token: "sess_2" })).status).toBe(401);
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(1);
    expect(rows(db, 'SELECT COUNT(*) AS count FROM "user"')).toBe(2);
  });

  it("takes the better-auth user, its sessions and its provider tokens with the account", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    db.prepare('INSERT INTO "account" (id, "accountId", "providerId", "userId", "refreshToken", "createdAt", "updatedAt") VALUES (?, ?, \'apple\', ?, ?, 0, 0)').run("oa_1", "apple-subject", "usr_1", "rt_apple");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);

    expect((await del(app, "dv_a", { identity_token: "sess_1" })).status).toBe(204);
    expect(rows(db, 'SELECT COUNT(*) AS count FROM "user" WHERE id = ?', "usr_1")).toBe(0);
    expect(rows(db, 'SELECT COUNT(*) AS count FROM "session" WHERE "userId" = ?', "usr_1")).toBe(0);
    expect(rows(db, 'SELECT COUNT(*) AS count FROM "account" WHERE "userId" = ?', "usr_1")).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS count FROM account_identities")).toBe(0);
  });

  it("refuses while an incident is open and names it", async () => {
    const { app, db } = setup();
    const topic = await makeTopic(app, "dv_a", "prod", true);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
    const incident = (db.prepare("SELECT id FROM incidents").get() as { id: string }).id;

    const response = await del(app, "dv_a");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "live incident", incident_id: incident });
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(1);

    // Acknowledge it and the same call goes through.
    await ackEverything(app, "dv_a");
    expect((await del(app, "dv_a")).status).toBe(204);
  });

  it("takes the tombstones that point at the account", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    // A switch leaves account a as a tombstone still owning its topic.
    await makeTopic(app, "dv_a", "prod");
    expect((await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1", into_account: "b" })).status).toBe(200);
    expect(tombstoneOf(db, "a")).toBe("b");

    expect((await del(app, "dv_a", { identity_token: "sess_1" })).status).toBe(204);
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts")).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS count FROM topics")).toBe(0);
  });

  it("kills every credential the account had", async () => {
    const { app, db } = setup();
    db.prepare("UPDATE accounts SET join_token_hash = ? WHERE id = 'a'").run(createHash("sha256").update("aj_a").digest("hex"));
    const topic = await makeTopic(app, "dv_a", "prod");

    expect((await del(app, "dv_a")).status).toBe(204);

    // The device token.
    expect((await app.request("/v1/topics", { headers: json("dv_a") })).status).toBe(401);
    // The topic token.
    expect((await publish(app, "prod", topic.token, 3)).status).toBe(401);
    // The account join token: a second handset cannot attach to what is gone.
    const join = await app.request("/relay/v1/devices", {
      method: "POST",
      headers: { Authorization: "Bearer aj_a", "content-type": "application/json" },
      body: JSON.stringify({ device_id: `dev_${randomUUID()}`, platform: "ios", push_token: "p", app_version: "1.0.0" }),
    });
    expect(join.status).toBe(401);
  });

  it("stores a later RevenueCat webhook as unapplied and creates nothing", async () => {
    const { app, db } = setup({ revenueCat: { sharedSecret: "rc-secret", entitlements: { crit_relay: "relay" } } });
    expect((await del(app, "dv_a")).status).toBe(204);

    const body = { api_version: "1.0", event: { id: "evt_late", app_user_id: "a", type: "INITIAL_PURCHASE", entitlement_ids: ["crit_relay"], event_timestamp_ms: 2_000_000, expiration_at_ms: 9_000_000 } };
    const response = await app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer rc-secret", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT account_id, applied FROM billing_events WHERE event_id = 'evt_late'").get()).toEqual({ account_id: null, applied: 0 });
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS count FROM account_billing_ids")).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS count FROM tier_changes")).toBe(0);
  });

  it("asks Apple to revoke before it erases, and carries on when Apple says no", async () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const calls: { url: string; body: string }[] = [];
    const db = openDatabase(":memory:");
    databases.push(db);
    migrate(db);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'free', 1)").run();
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('da', 'a', ?, 'ios', 'x', 1)").run(createHash("sha256").update("dv_a").digest("hex"));
    seedIdentity(db, "usr_1", "sess_1");
    db.prepare('INSERT INTO "account" (id, "accountId", "providerId", "userId", "refreshToken", "createdAt", "updatedAt") VALUES (?, ?, \'apple\', ?, ?, 0, 0)').run("oa_1", "apple-subject", "usr_1", "rt_secret_apple");
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_1', 'a', 1)").run();

    const clock = { now: () => NOW };
    const auth = { secret: "s".repeat(32), apple: { clientId: "app.critalarm.signin", credential: { kind: "key" as const, signingKey: { teamId: "ABCDE12345", keyId: "FGHIJ67890", privateKey: key } } } };
    const revoke = providerTokenRevoker(db, auth, clock, async (request) => {
      calls.push({ url: request.url, body: await request.text() });
      return new Response("nope", { status: 500 });
    });
    const app = createApp({
      config: { baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
      db,
      clock,
      ids: { message: () => "m_1", incident: () => "inc_1", timer: () => "tm_1" },
      dispatch: async () => {},
      revoke,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await del(app, "dv_a", { identity_token: "sess_1" })).status).toBe(204);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://appleid.apple.com/auth/revoke");
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get("client_id")).toBe("app.critalarm.signin");
    expect(sent.get("token")).toBe("rt_secret_apple");
    expect(sent.get("token_type_hint")).toBe("refresh_token");
    // The client secret is the S22 minter's: an ES256 JWT for this client id.
    const secret = sent.get("client_secret") ?? "";
    expect(JSON.parse(Buffer.from(secret.split(".")[1]!, "base64url").toString())).toMatchObject({ iss: "ABCDE12345", sub: "app.critalarm.signin", aud: "https://appleid.apple.com" });

    // Apple refusing does not keep a person in an account they asked to leave.
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(0);
    expect(rows(db, 'SELECT COUNT(*) AS count FROM "user"')).toBe(0);
    // And the token is nowhere in what was logged.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("provider_revoke_rejected");
    expect(logged).not.toContain("rt_secret_apple");
    expect(logged).not.toContain(secret);
    warn.mockRestore();
  });

  it("answers 400 for a body that is not the shape the contract names", async () => {
    const { app } = setup();
    expect((await del(app, "dv_a", { identity_token: "" })).status).toBe(400);
    const broken = await app.request("/v1/account", { method: "DELETE", headers: json("dv_a"), body: "{" });
    expect(broken.status).toBe(400);
  });

  it("reads the device credential only from the header", async () => {
    const { app, db } = setup();
    expect((await app.request("/v1/account", { method: "DELETE" })).status).toBe(401);
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(1);
  });
});

// api.md §4.4. The operator command runs the same erase for a request that
// arrives by email. cli.ts is argv plumbing over these two functions.
describe("critalarm account delete", () => {
  it("finds the account by id and by sign-in email, and counts what it removed", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    const topic = await makeTopic(app, "dv_a", "prod", true);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
    seedExtras(db, "a", "da");

    expect(findAccount(db, { email: "usr_1@example.com" })).toBe("a");
    expect(findAccount(db, { id: "a" })).toBe("a");

    // An open incident does not stop the operator: the person asked in writing.
    const counts = deleteAccount(db, findAccount(db, { email: "usr_1@example.com" })!);
    expect(counts).toEqual({ accounts: 1, devices: 1, topics: 1, incidents: 1, messages: 1, identities: 1, billingEventsCleared: 1 });
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(0);
    expect(rows(db, 'SELECT COUNT(*) AS count FROM "user"')).toBe(0);
  });

  it("counts the tombstones it takes with the account", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    await makeTopic(app, "dv_a", "prod");
    expect((await post(app, "/v1/account/switch", "dv_a", { identity_token: "sess_1", into_account: "b" })).status).toBe(200);

    // A support request quoting the old id lands on the account that survived.
    expect(findAccount(db, { id: "a" })).toBe("b");
    expect(deleteAccount(db, "a").accounts).toBe(2);
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts")).toBe(0);
  });

  it("finds nothing for an unknown id or address", async () => {
    const { db } = setup();
    expect(findAccount(db, { id: "acc_nope" })).toBeUndefined();
    expect(findAccount(db, { email: "nobody@example.com" })).toBeUndefined();
    expect(rows(db, "SELECT COUNT(*) AS count FROM accounts")).toBe(2);
  });
});

// api.md §3.7. One operator, one ad_ token, no accounts to sign in to. 501 and
// not 404, so a client can tell "this server does not do sign-in" apart from
// "you typed the path wrong".
describe("selfhosted mode", () => {
  for (const path of ["/v1/account/link", "/v1/account/merge", "/v1/account/switch"]) {
    it(`refuses ${path}`, async () => {
      const { app } = setup({ mode: "selfhosted" });
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: "not supported in selfhosted mode" });
    });
  }

  it("refuses DELETE /v1/account", async () => {
    const { app } = setup({ mode: "selfhosted" });
    const response = await app.request("/v1/account", { method: "DELETE" });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "not supported in selfhosted mode" });
  });

  it("does not carry the better-auth routes", async () => {
    const authHandler = async () => new Response("ok", { status: 200 });
    const selfhosted = setup({ mode: "selfhosted", authHandler });
    expect((await selfhosted.app.request("/api/auth/sign-in/social", { method: "POST" })).status).toBe(404);
    const relay = setup({ mode: "relay", authHandler });
    expect((await relay.app.request("/api/auth/sign-in/social", { method: "POST" })).status).toBe(200);
  });

  it("does not mount the better-auth routes when no provider is configured", async () => {
    const { app } = setup({ mode: "relay" });
    expect((await app.request("/api/auth/sign-in/social", { method: "POST" })).status).toBe(404);
  });
});
