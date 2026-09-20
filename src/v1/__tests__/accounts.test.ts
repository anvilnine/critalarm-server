import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { Config } from "../../config.js";
import type { IdentityResolver } from "../../auth/identity.js";
import { providerTokenRevoker, type TokenRevoker } from "../../auth/revoke.js";
import { deleteAccount, findAccount, mergeAccounts } from "../accounts.js";

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

// A second app over the same database, standing in for a topic that was made
// while the server ran on a different base_url. topic_hash is
// sha256(`${base_url}/${name}`), so the same name made here carries a hash the
// first app would never produce.
function appWithBaseUrl(db: ReturnType<typeof openDatabase>, baseUrl: string) {
  return createApp({
    config: { baseUrl, relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
    db,
    clock: { now: () => NOW },
    ids: { message: () => `m_${Math.random()}`, incident: () => `inc_${Math.random()}`, timer: () => `tm_${Math.random()}` },
    dispatch: async () => {},
  });
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

  // The second call answers `already_linked` rather than `claimed` since 1.14.0.
  // It is the one place a request with no `intent` reads differently from
  // 1.12.0, and api.md §3.7 asks for it by name: a retry after a dropped reply
  // has to be able to tell "I just signed you up" from "you were already here".
  // Nothing is written either way.
  it("is safe to call twice", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    const again = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ account_id: "a", outcome: "already_linked" });
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

// api.md §3.7, contract 1.14.0. One account may hold more than one sign-in
// identity, so a person can use Google on an Android handset and Apple on an
// iPhone and reach the same account. `intent` is how the app says which screen
// the person was on, because the server cannot tell a second provider from a
// second person on a borrowed handset.
//
// One test per row of the contract's matrix, named for the row. "either" rows
// run all three bodies: no intent at all, "sign_in", and "link".
const EITHER: (Record<string, unknown>)[] = [{}, { intent: "sign_in" }, { intent: "link" }];

function identitiesOn(db: ReturnType<typeof openDatabase>, accountId: string): string[] {
  return (db.prepare("SELECT user_id FROM account_identities WHERE account_id = ? ORDER BY user_id").all(accountId) as { user_id: string }[]).map((row) => row.user_id);
}

describe("POST /v1/account/link: one account, more than one identity", () => {
  it("row 1: unknown identity, no identity on the device's account, either intent, claimed", async () => {
    for (const intent of EITHER) {
      const { app, db } = setup();
      seedIdentity(db, "usr_1", "sess_1");
      const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1", ...intent });
      expect([intent, response.status]).toEqual([intent, 200]);
      expect([intent, await response.json()]).toEqual([intent, { account_id: "a", outcome: "claimed" }]);
      expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
    }
  });

  it("row 2: unknown identity, the account already has one, sign_in, 409 account has another identity", async () => {
    // Both bodies, because leaving `intent` out has to mean "sign_in".
    for (const intent of [{}, { intent: "sign_in" }]) {
      const { app, db } = setup();
      seedIdentity(db, "usr_1", "sess_1");
      seedIdentity(db, "usr_2", "sess_2");
      expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);

      const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_2", ...intent });
      expect([intent, response.status]).toEqual([intent, 409]);
      expect([intent, await response.json()]).toEqual([intent, { error: "account has another identity" }]);
      // The refusal wrote nothing.
      expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
    }
  });

  it("row 3: unknown identity, the account already has one, link, linked", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    const topic = await makeTopic(app, "dv_a", "prod");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);

    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_2", intent: "link" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a", outcome: "linked" });

    // Both identities are on the one account and nothing moved.
    expect(identitiesOn(db, "a")).toEqual(["usr_1", "usr_2"]);
    expect(accountOf(db, "da")).toBe("a");
    expect(tombstoneOf(db, "a")).toBeNull();
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
  });

  it("row 4: known identity, the device's account is empty, either intent, attached", async () => {
    for (const intent of EITHER) {
      const { app, db } = setup();
      seedIdentity(db, "usr_1", "sess_1");
      // The identity's own account is b, claimed from the other handset.
      expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
      await makeTopic(app, "dv_b", "prod");

      const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1", ...intent });
      expect([intent, response.status]).toEqual([intent, 200]);
      expect([intent, await response.json()]).toEqual([intent, { account_id: "b", outcome: "attached" }]);
      expect(accountOf(db, "da")).toBe("b");
      expect(tombstoneOf(db, "a")).toBe("b");
    }
  });

  it("row 5: known identity, the device's account is not empty, sign_in, 409 choose", async () => {
    for (const intent of [{}, { intent: "sign_in" }]) {
      const { app, db } = setup();
      seedIdentity(db, "usr_1", "sess_1");
      expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
      const topic = await makeTopic(app, "dv_a", "prod", true);
      expect((await publish(app, "prod", topic.token)).status).toBe(200);

      const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1", ...intent });
      expect([intent, response.status]).toEqual([intent, 409]);
      expect([intent, await response.json()]).toEqual([intent, { error: "choose", into_account: "b", topics: 1, incidents: 1 }]);
      expect(accountOf(db, "da")).toBe("a");
      expect(tombstoneOf(db, "a")).toBeNull();
    }
  });

  it("row 6: known identity, the device's account is not empty, link, 409 identity has another account", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    // usr_1 already holds account b, with a topic on it so neither side is empty.
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    await makeTopic(app, "dv_b", "theirs");
    const topic = await makeTopic(app, "dv_a", "prod", true);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);

    const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1", intent: "link" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "identity has another account" });

    // Which account wins is not this route's call, so nothing moved.
    expect(accountOf(db, "da")).toBe("a");
    expect(tombstoneOf(db, "a")).toBeNull();
    expect(identitiesOn(db, "a")).toEqual([]);
    expect(identitiesOn(db, "b")).toEqual(["usr_1"]);
  });

  it("row 7: the identity already points at this same account, either intent, already_linked", async () => {
    for (const intent of EITHER) {
      const { app, db } = setup();
      seedIdentity(db, "usr_1", "sess_1");
      expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
      const linkedAt = db.prepare("SELECT linked_at FROM account_identities WHERE user_id = 'usr_1'").get();

      const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1", ...intent });
      expect([intent, response.status]).toEqual([intent, 200]);
      expect([intent, await response.json()]).toEqual([intent, { account_id: "a", outcome: "already_linked" }]);
      // Safe to send twice: the second call changed nothing.
      expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
      expect(db.prepare("SELECT linked_at FROM account_identities WHERE user_id = 'usr_1'").get()).toEqual(linkedAt);
      expect(accountOf(db, "da")).toBe("a");
      expect(tombstoneOf(db, "a")).toBeNull();
    }
  });

  it("answers 400 for an intent the contract does not name, not 500", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    for (const intent of ["signin", "LINK", "", "merge", 1, null]) {
      const response = await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1", intent });
      expect([intent, response.status]).toEqual([intent, 400]);
    }
    expect(identitiesOn(db, "a")).toEqual([]);
  });

  it("resolves both identities to the one account", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_google", "sess_google");
    seedIdentity(db, "usr_apple", "sess_apple");
    // The Android handset signs up, the iPhone's provider is added to the same
    // account from that same handset.
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_google" })).status).toBe(200);
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_apple", intent: "link" })).status).toBe(200);
    expect(identitiesOn(db, "a")).toEqual(["usr_apple", "usr_google"]);

    // Now the second handset, holding an empty account of its own, signs in
    // with Apple. It lands on the account Google claimed.
    const response = await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_apple" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a", outcome: "attached" });
    expect(accountOf(db, "db")).toBe("a");

    // And signing in with Google on it now reads as already linked.
    const google = await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_google" });
    expect(google.status).toBe(200);
    expect(await google.json()).toEqual({ account_id: "a", outcome: "already_linked" });
  });

  it("erases both identities on a DELETE given either one of them", async () => {
    for (const token of ["sess_1", "sess_2"]) {
      const { app, db } = setup();
      seedIdentity(db, "usr_1", "sess_1");
      seedIdentity(db, "usr_2", "sess_2");
      db.prepare('INSERT INTO "account" (id, "accountId", "providerId", "userId", "refreshToken", "createdAt", "updatedAt") VALUES (?, ?, \'google\', ?, ?, 0, 0)').run("oa_2", "google-subject", "usr_2", "rt_google");
      expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
      expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_2", intent: "link" })).status).toBe(200);

      // Either identity is enough: both belong to the same person, and asking
      // for both would strand anybody who lost access to one.
      expect([token, (await del(app, "dv_a", { identity_token: token })).status]).toEqual([token, 204]);

      expect(rows(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(0);
      expect(rows(db, "SELECT COUNT(*) AS count FROM account_identities")).toBe(0);
      // Both better-auth users go, with their sessions and provider tokens.
      expect(rows(db, 'SELECT COUNT(*) AS count FROM "user"')).toBe(0);
      expect(rows(db, 'SELECT COUNT(*) AS count FROM "session"')).toBe(0);
      expect(rows(db, 'SELECT COUNT(*) AS count FROM "account"')).toBe(0);
    }
  });

  it("asks both providers to revoke before it erases", async () => {
    const revoked: string[] = [];
    const { app, db } = setup({ revoke: { revoke: async (userId) => { revoked.push(userId); } } });
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_1" })).status).toBe(200);
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_2", intent: "link" })).status).toBe(200);

    expect((await del(app, "dv_a", { identity_token: "sess_1" })).status).toBe(204);
    expect([...revoked].sort()).toEqual(["usr_1", "usr_2"]);
  });

  it("folds a merge into a surviving account that holds two identities", async () => {
    const { app, db } = setup();
    seedIdentity(db, "usr_1", "sess_1");
    seedIdentity(db, "usr_2", "sess_2");
    // Account b is the survivor and it holds both of the person's providers.
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_2", intent: "link" })).status).toBe(200);
    const theirs = await makeTopic(app, "dv_b", "theirs");
    // The other handset brings a topic, so the sign-in asks rather than
    // attaches. No incident on either side: a merge refuses while one is open
    // or acked, which is its own test further down.
    const mine = await makeTopic(app, "dv_a", "prod", true);
    expect((await post(app, "/v1/account/link", "dv_a", { identity_token: "sess_2" })).status).toBe(409);

    // Either identity can fold it, so run the merge on the second one.
    const response = await post(app, "/v1/account/merge", "dv_a", { identity_token: "sess_2", into_account: "b" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "b", merged_from: "a" });

    expect(accountOf(db, "da")).toBe("b");
    expect(tombstoneOf(db, "a")).toBe("b");
    expect(identitiesOn(db, "b")).toEqual(["usr_1", "usr_2"]);
    // Both sides' topics are on the survivor and both tokens still publish.
    const topics = await app.request("/v1/topics", { headers: json("dv_a") });
    expect((await topics.json() as { name: string }[]).map((topic) => topic.name).sort()).toEqual(["prod", "theirs"]);
    expect((await publish(app, "theirs", theirs.token, 3)).status).toBe(200);
    expect((await publish(app, "prod", mine.token, 3)).status).toBe(200);
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

// api.md §3.7, the fold. Everything the source account owns lands on the
// target, both sides keep ringing, and every tk_ that worked before still
// works. A merge is refused rather than forced while anything is ringing.
describe("POST /v1/account/merge", () => {
  // Signs usr_1 into account b from the second handset, which is what makes b
  // an account the identity owns and so a legal target for dv_a's merge.
  async function signInto(app: ReturnType<typeof createApp>, db: ReturnType<typeof openDatabase>) {
    seedIdentity(db, "usr_1", "sess_1");
    expect((await post(app, "/v1/account/link", "dv_b", { identity_token: "sess_1" })).status).toBe(200);
  }

  function merge(app: ReturnType<typeof createApp>, device = "dv_a", into = "b") {
    return post(app, "/v1/account/merge", device, { identity_token: "sess_1", into_account: into });
  }

  // device_id and topic name for every subscription row, so a test can say
  // "every handset is on every topic" in one assertion.
  function subscriptions(db: ReturnType<typeof openDatabase>) {
    return db.prepare("SELECT s.device_id AS device, t.name AS topic FROM subscriptions s JOIN topics t ON t.topic_hash = s.topic_hash ORDER BY s.device_id, t.name").all();
  }

  async function ackAndClose(app: ReturnType<typeof createApp>, device: string) {
    await ackEverything(app, device);
    const list = await (await app.request("/v1/incidents", { headers: json(device) })).json() as { id: string }[];
    for (const incident of list) expect((await app.request(`/v1/incidents/${incident.id}/close`, { method: "POST", headers: json(device) })).status).toBe(200);
  }

  it("leaves every handset subscribed to every topic, not only the colliding one", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    await makeTopic(app, "dv_a", "alpha");
    await makeTopic(app, "dv_b", "beta");

    const response = await merge(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "b", merged_from: "a" });

    expect(accountOf(db, "da")).toBe("b");
    expect(tombstoneOf(db, "a")).toBe("b");
    // The handset that moved and the handset that was already there both hold a
    // row for both topics. Without the sweep on the repointed topic, db would
    // never ring for alpha.
    expect(subscriptions(db)).toEqual([
      { device: "da", topic: "alpha" },
      { device: "da", topic: "beta" },
      { device: "db", topic: "alpha" },
      { device: "db", topic: "beta" },
    ]);
  });

  it("keeps a tk_ from the folded topic publishing, onto the row that survived", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    // Same name and, on one base_url, the same hash: these two rows become one.
    const fromSource = await makeTopic(app, "dv_a", "prod");
    const fromTarget = await makeTopic(app, "dv_b", "prod");

    expect((await merge(app)).status).toBe(200);

    const survivors = db.prepare("SELECT id, account_id FROM topics WHERE name = 'prod'").all() as { id: string; account_id: string }[];
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.account_id).toBe("b");

    // The webhook that only ever held the source account's token still works,
    // and its message lands on the surviving row.
    expect((await publish(app, "prod", fromSource.token)).status).toBe(200);
    expect((await publish(app, "prod", fromTarget.token)).status).toBe(200);
    const landed = db.prepare("SELECT DISTINCT topic_id FROM messages").all() as { topic_id: string }[];
    expect(landed).toEqual([{ topic_id: survivors[0]!.id }]);
    expect(rows(db, "SELECT COUNT(*) AS count FROM topic_tokens WHERE topic_id = ?", survivors[0]!.id)).toBe(2);
  });

  it("takes the higher tier, and a webhook that arrives later lands on the survivor", async () => {
    const { app, db } = setup({ revenueCat: { sharedSecret: "rc-secret", entitlements: { crit_hosted: "hosted" } } });
    await signInto(app, db);
    // Account a pays for hosted. Account b pays for nothing.
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('rc_a', 'a', 1, 1, 'hosted')").run();
    db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'a'").run();

    expect((await merge(app)).status).toBe(200);

    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'b'").get()).toEqual({ tier: "hosted" });
    expect(db.prepare("SELECT account_id FROM account_billing_ids WHERE app_user_id = 'rc_a'").get()).toEqual({ account_id: "b" });
    expect(db.prepare("SELECT from_tier, to_tier, reason, event_id FROM tier_changes").get()).toEqual({ from_tier: "free", to_tier: "hosted", reason: "merge from a", event_id: null });

    // RevenueCat still knows the subscription by rc_a. The event has to reach
    // the account that holds the handsets now, not the tombstone.
    const body = { api_version: "1.0", event: { id: "evt_after", app_user_id: "rc_a", type: "EXPIRATION", entitlement_ids: ["crit_hosted"], event_timestamp_ms: 2_000_000 } };
    const webhook = await app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer rc-secret", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(webhook.status).toBe(200);
    expect(db.prepare("SELECT account_id, applied FROM billing_events WHERE event_id = 'evt_after'").get()).toEqual({ account_id: "b", applied: 1 });
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'b'").get()).toEqual({ tier: "free" });
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'a'").get()).toEqual({ tier: "hosted" });
  });

  it("never lowers the tier of the account it merges into", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    // Account b is on a paid tier and holds no account_billing_ids row, which
    // is the only table the recompute reads. Account a pays for nothing. A
    // merge must not be the thing that takes b's subscription away.
    db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'b'").run();

    expect((await merge(app)).status).toBe(200);

    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'b'").get()).toEqual({ tier: "hosted" });
    expect(rows(db, "SELECT COUNT(*) AS count FROM tier_changes")).toBe(0);
    // And the audit row says what the account ended on, not what the recompute
    // came back with.
    const detail = JSON.parse((db.prepare("SELECT detail FROM account_merges").get() as { detail: string }).detail) as { tier_before: string; tier_after: string };
    expect({ before: detail.tier_before, after: detail.tier_after }).toEqual({ before: "hosted", after: "hosted" });
  });

  it("writes an audit row holding the counts that actually moved", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    // prod exists on both sides and folds. alpha exists on the source only and
    // is repointed whole.
    const prod = await makeTopic(app, "dv_a", "prod", true);
    await makeTopic(app, "dv_a", "alpha");
    await makeTopic(app, "dv_b", "prod");
    expect((await publish(app, "prod", prod.token)).status).toBe(200);
    await ackAndClose(app, "dv_a");
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at) VALUES ('rc_a', 'a', 1)").run();
    db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES ('a', 0, 3)").run();
    db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES ('b', 0, 5)").run();

    expect((await merge(app)).status).toBe(200);

    const audit = db.prepare("SELECT id, from_account, into_account, merged_at, detail FROM account_merges").get() as { id: string; from_account: string; into_account: string; merged_at: number; detail: string };
    expect(audit.id).toMatch(/^mrg_/);
    expect({ from: audit.from_account, into: audit.into_account, at: audit.merged_at }).toEqual({ from: "a", into: "b", at: NOW });
    expect(JSON.parse(audit.detail)).toEqual({
      devices: 1, topics_repointed: 1, topics_folded: 1, tokens_repointed: 1,
      incidents: 1, messages: 1, billing_ids: 1, tier_before: "free", tier_after: "free",
    });

    // And the counts are the rows, not a hopeful tally.
    const survivor = (db.prepare("SELECT id FROM topics WHERE account_id = 'b' AND name = 'prod'").get() as { id: string }).id;
    expect(rows(db, "SELECT COUNT(*) AS count FROM devices WHERE account_id = 'b'")).toBe(2);
    expect(rows(db, "SELECT COUNT(*) AS count FROM topics WHERE account_id = 'b'")).toBe(2);
    expect(rows(db, "SELECT COUNT(*) AS count FROM topics WHERE account_id = 'a'")).toBe(0);
    expect(rows(db, "SELECT COUNT(*) AS count FROM topic_tokens WHERE topic_id = ?", survivor)).toBe(2);
    expect(rows(db, "SELECT COUNT(*) AS count FROM incidents WHERE topic_id = ?", survivor)).toBe(1);
    expect(rows(db, "SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?", survivor)).toBe(1);
    // The day both accounts already had is one row holding both counts.
    expect(db.prepare("SELECT account_id, day_start, count FROM relay_p4_usage").all()).toEqual([{ account_id: "b", day_start: 0, count: 8 }]);
  });

  it("refuses the same pair twice, first as the same account and then as already merged", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    await makeTopic(app, "dv_a", "alpha");
    expect((await merge(app)).status).toBe(200);

    // The handset moved with the first merge, so the second call arrives with
    // the source and the target already being one account.
    const again = await merge(app);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "same account" });

    // Naming the tombstone instead is the other refusal.
    const tombstoned = await merge(app, "dv_a", "a");
    expect(tombstoned.status).toBe(409);
    expect(await tombstoned.json()).toEqual({ error: "already merged" });
    expect(rows(db, "SELECT COUNT(*) AS count FROM account_merges")).toBe(1);
  });

  it("refuses while an incident is open on either side, and moves nothing", async () => {
    for (const ringing of ["dv_a", "dv_b"]) {
      const { app, db } = setup();
      await signInto(app, db);
      const topic = await makeTopic(app, ringing, "ringing", true);
      expect((await publish(app, "ringing", topic.token)).status).toBe(200);
      const incident = (db.prepare("SELECT id FROM incidents").get() as { id: string }).id;

      const response = await merge(app);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "live incident", incident_id: incident });
      expect(accountOf(db, "da")).toBe("a");
      expect(tombstoneOf(db, "a")).toBeNull();
      expect(rows(db, "SELECT COUNT(*) AS count FROM account_merges")).toBe(0);
    }
  });

  it("refuses while an incident is only acked, because the fold could not be written", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    // Both sides hold a topic called prod, and both carry an active incident.
    // incidents_one_active_per_topic is unique on topic_id for open and acked,
    // so folding these two rows is not a thing SQLite would accept.
    const fromSource = await makeTopic(app, "dv_a", "prod", true);
    const fromTarget = await makeTopic(app, "dv_b", "prod", true);
    expect((await publish(app, "prod", fromSource.token)).status).toBe(200);
    expect((await publish(app, "prod", fromTarget.token)).status).toBe(200);
    await ackEverything(app, "dv_a");
    await ackEverything(app, "dv_b");
    expect(rows(db, "SELECT COUNT(*) AS count FROM incidents WHERE state = 'acked'")).toBe(2);

    const response = await merge(app);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe("live incident");
    expect(accountOf(db, "da")).toBe("a");
    expect(tombstoneOf(db, "a")).toBeNull();
    expect(rows(db, "SELECT COUNT(*) AS count FROM topics WHERE account_id = 'a'")).toBe(1);
  });

  it("folds two topics that share a name and not a hash, and keeps both sets of tokens", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    // topic_hash is sha256(`${base_url}/${name}`), so the same name made while
    // the server ran on a different base_url carries a different hash. The two
    // rows collide on UNIQUE (account_id, name) and on nothing else.
    const elsewhere = appWithBaseUrl(db, "https://other.example.com");
    const fromSource = await makeTopic(app, "dv_a", "prod");
    const fromTarget = await makeTopic(elsewhere, "dv_b", "prod");
    const hashes = db.prepare("SELECT DISTINCT topic_hash FROM topics WHERE name = 'prod'").all();
    expect(hashes).toHaveLength(2);

    expect((await merge(app)).status).toBe(200);

    const survivors = db.prepare("SELECT id, account_id, base_url FROM topics WHERE name = 'prod'").all() as { id: string; account_id: string; base_url: string }[];
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.account_id).toBe("b");
    expect(survivors[0]!.base_url).toBe("https://other.example.com");
    expect((await publish(app, "prod", fromSource.token)).status).toBe(200);
    expect((await publish(app, "prod", fromTarget.token)).status).toBe(200);
    expect(rows(db, "SELECT COUNT(*) AS count FROM topic_tokens WHERE topic_id = ?", survivors[0]!.id)).toBe(2);
    // Both handsets ring for the row that survived, and the dead hash is gone.
    expect(subscriptions(db)).toEqual([{ device: "da", topic: "prod" }, { device: "db", topic: "prod" }]);
  });

  it("writes nothing at all when a statement inside the transaction fails", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    await makeTopic(app, "dv_a", "alpha");
    await makeTopic(app, "dv_b", "beta");

    // Nothing a client can send makes this transaction fail once the three
    // refusals have run. The topic fold matches on hash or name, so a repoint
    // cannot trip either unique index on topics; the subscription sweeps are
    // INSERT OR IGNORE; the relay usage rows add up rather than collide; and an
    // active incident, the one thing that could break the fold, is refused
    // before the transaction opens. So the failure is put there on purpose, as
    // a real SQLite abort on the last write of the transaction.
    db.exec("CREATE TRIGGER merge_stops_here BEFORE INSERT ON account_merges BEGIN SELECT RAISE(ABORT, 'no'); END");
    const identities: IdentityResolver = { resolve: (token) => (token === "sess_1" ? { userId: "usr_1" } : null) };
    expect(() => mergeAccounts(db, { now: () => NOW }, identities, "a", "sess_1", "b")).toThrow();

    expect(accountOf(db, "da")).toBe("a");
    expect(tombstoneOf(db, "a")).toBeNull();
    expect((db.prepare("SELECT account_id FROM topics WHERE name = 'alpha'").get() as { account_id: string }).account_id).toBe("a");
    expect(subscriptions(db)).toEqual([{ device: "da", topic: "alpha" }, { device: "db", topic: "beta" }]);
    expect(rows(db, "SELECT COUNT(*) AS count FROM account_merges")).toBe(0);
  });

  it("answers 401 when the identity does not own the account named in the body", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    seedIdentity(db, "usr_2", "sess_2");
    expect((await post(app, "/v1/account/merge", "dv_a", { identity_token: "sess_2", into_account: "b" })).status).toBe(401);
    expect((await post(app, "/v1/account/merge", "dv_a", { identity_token: "sess_nope", into_account: "b" })).status).toBe(401);
    expect((await merge(app, "dv_a", "acc_elsewhere")).status).toBe(401);
    expect(tombstoneOf(db, "a")).toBeNull();
  });

  it("answers 401 when the source account belongs to somebody else", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    seedIdentity(db, "usr_2", "sess_2");
    // usr_2 owns account a from the shared handset. usr_1 must not be able to
    // pull it, and everything on it, into their own account.
    db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES ('usr_2', 'a', 1)").run();
    const response = await merge(app);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(tombstoneOf(db, "a")).toBeNull();
  });

  it("needs the device credential in the header, and a body of the shape the contract names", async () => {
    const { app, db } = setup();
    await signInto(app, db);
    expect((await app.request("/v1/account/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity_token: "sess_1", into_account: "b" }) })).status).toBe(401);
    expect((await post(app, "/v1/account/merge", "dv_a", { identity_token: "sess_1" })).status).toBe(400);
    expect((await post(app, "/v1/account/merge", "dv_a", { into_account: "b" })).status).toBe(400);
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
// api.md §3.7. Mint on demand, because S20 only ever minted an aj_ when the
// account was created: every account older than that migration holds NULL and
// matches no join token, so a second handset can never attach to one.
describe("POST /v1/account/join-token", () => {
  function mint(app: ReturnType<typeof createApp>, device: string) {
    return app.request("/v1/account/join-token", { method: "POST", headers: { Authorization: `Bearer ${device}` } });
  }

  async function mintToken(app: ReturnType<typeof createApp>, device: string) {
    const response = await mint(app, device);
    expect(response.status).toBe(200);
    return (await response.json() as { join_token: string }).join_token;
  }

  // api.md §4.2, the join. A device_id the server has never seen, presented with
  // a valid aj_, lands on that account instead of creating a new one.
  function join(app: ReturnType<typeof createApp>, token: string, deviceId = `dev_${randomUUID()}`) {
    return app.request("/relay/v1/devices", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, platform: "ios", push_token: "p", app_version: "1.0.0" }),
    });
  }

  it("answers a dv_ with a token that starts aj_", async () => {
    const { app } = setup();
    const response = await mint(app, "dv_a");
    expect(response.status).toBe(200);
    const body = await response.json() as { join_token: string };
    expect(body.join_token.startsWith("aj_")).toBe(true);
    expect(Object.keys(body)).toEqual(["join_token"]);
  });

  it("attaches a brand new device_id to the same account", async () => {
    const { app, db } = setup();
    const token = await mintToken(app, "dv_a");

    const deviceId = `dev_${randomUUID()}`;
    const response = await join(app, token, deviceId);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ account_id: "a" });
    expect(accountOf(db, deviceId)).toBe("a");
  });

  it("retires the token it replaces", async () => {
    const { app } = setup();
    const first = await mintToken(app, "dv_a");
    const second = await mintToken(app, "dv_a");

    expect(second).not.toBe(first);
    expect((await join(app, first)).status).toBe(401);
    expect((await join(app, second)).status).toBe(201);
  });

  // The pre-migration account. Written as a NULL row on purpose: an account made
  // today already carries a join token and would pass this test either way.
  it("gives a working token to an account whose join_token_hash is NULL", async () => {
    const { app, db } = setup();
    db.prepare("UPDATE accounts SET join_token_hash = NULL WHERE id = 'a'").run();
    expect(db.prepare("SELECT join_token_hash FROM accounts WHERE id = 'a'").get()).toEqual({ join_token_hash: null });

    const token = await mintToken(app, "dv_a");

    const deviceId = `dev_${randomUUID()}`;
    expect((await join(app, token, deviceId)).status).toBe(201);
    expect(accountOf(db, deviceId)).toBe("a");
  });

  it("answers 401 to anything that is not a dv_", async () => {
    const { app } = setup();
    const topic = await makeTopic(app, "dv_a", "prod");
    const existing = await mintToken(app, "dv_a");

    expect((await app.request("/v1/account/join-token", { method: "POST" })).status).toBe(401);
    expect((await mint(app, topic.token)).status).toBe(401);
    expect((await mint(app, existing)).status).toBe(401);
    expect((await mint(app, "dv_nobody")).status).toBe(401);
  });

  // caps.devices is enforced where the device row is written, so this route
  // cannot raise or lower it. free carries 5 and the account starts with one.
  it("does not lift caps.devices", async () => {
    const { app } = setup();
    const token = await mintToken(app, "dv_a");
    for (let seat = 0; seat < 4; seat += 1) expect((await join(app, token)).status).toBe(201);

    const response = await join(app, token);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "cap", cap: "devices" });
  });

  it("puts the token in the body and nowhere else", async () => {
    const { app, db } = setup();
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map((arg) => String(arg)).join(" ")); }));

    const token = await mintToken(app, "dv_a");
    for (const spy of spies) spy.mockRestore();

    expect(logged.join("\n")).not.toContain(token);
    // The row keeps the hash and not the value, so nothing can read the token
    // back out of the database either.
    const account = db.prepare("SELECT * FROM accounts WHERE id = 'a'").get() as Record<string, unknown>;
    expect(JSON.stringify(account)).not.toContain(token);
    expect(account.join_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  });
});

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
  for (const path of ["/v1/account/link", "/v1/account/merge", "/v1/account/switch", "/v1/account/join-token"]) {
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
