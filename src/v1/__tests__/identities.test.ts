import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import type { Config } from "../../config.js";
import type { TokenRevoker } from "../../auth/revoke.js";

// api.md §3.7, contract 1.28.0. Adding an identity to an account that already
// holds one needs proof, an account holds at most 6, the identities list masks
// what a device token alone can read, and one identity can be removed but never
// the last. Every identity_token here is a better-auth session row, read by the
// real resolver, so no Apple or Google credential is involved.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const NOW = 1_760_000_000;
type Db = ReturnType<typeof openDatabase>;
type App = ReturnType<typeof createApp>;

function setup(options: { mode?: Config["mode"]; revoke?: TokenRevoker } = {}) {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  for (const id of ["a", "b"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
  for (const [id, account, token] of [["da", "a", "dv_a"], ["db", "b", "dv_b"]]) {
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, ?, ?, 'ios', 'x', 1)")
      .run(id, account, createHash("sha256").update(token!).digest("hex"));
  }
  const app = createApp({
    config: { ...(options.mode === undefined ? {} : { mode: options.mode }), baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
    db,
    clock: { now: () => NOW },
    ids: { message: () => `m_${Math.random()}`, incident: () => `inc_${Math.random()}`, timer: () => `tm_${Math.random()}` },
    dispatch: async () => {},
    ...(options.revoke === undefined ? {} : { revoke: options.revoke }),
  });
  return { app, db };
}

// A better-auth user with one live session. `age` is how many seconds ago the
// session was made.
function seedUser(db: Db, userId: string, options: { email?: string; session?: string; age?: number } = {}) {
  db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, 0, 0)').run(userId, userId, options.email ?? `${userId}@example.com`);
  if (options.session !== undefined) seedSession(db, userId, options.session, options.age ?? 10);
}

function seedSession(db: Db, userId: string, token: string, age: number, expiresAt = "2099-01-01T00:00:00.000Z") {
  db.prepare('INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, 0, ?)')
    .run(`ses_${token}`, expiresAt, token, new Date((NOW - age) * 1000).toISOString(), userId);
}

// A provider sign-in: one row of better-auth's `account` table.
function seedProvider(db: Db, rowId: string, userId: string, provider: "apple" | "google", createdAt = 0, refreshToken: string | null = null) {
  db.prepare('INSERT INTO "account" (id, "accountId", "providerId", "userId", "refreshToken", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(rowId, `${provider}-${rowId}`, provider, userId, refreshToken, createdAt);
}

function onAccount(db: Db, userId: string, accountId: string, linkedAt: number) {
  db.prepare("INSERT INTO account_identities (user_id, account_id, linked_at) VALUES (?, ?, ?)").run(userId, accountId, linkedAt);
}

function headers(device: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${device}`, "content-type": "application/json", ...extra };
}

function link(app: App, device: string, body: Record<string, unknown>) {
  return app.request("/v1/account/link", { method: "POST", headers: headers(device), body: JSON.stringify(body) });
}

function list(app: App, device: string, identityToken?: string) {
  return app.request("/v1/account/identities", { headers: headers(device, identityToken === undefined ? {} : { "X-Identity-Token": identityToken }) });
}

function remove(app: App, device: string, id: string, body?: Record<string, unknown>) {
  return app.request(`/v1/account/identities/${id}`, { method: "DELETE", headers: headers(device), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

type Row = { id: string; provider: string; email_hint?: string; email?: string; email_hidden: boolean; linked_at: number; current?: boolean };

async function rowsOf(app: App, device: string, identityToken?: string): Promise<Row[]> {
  const response = await list(app, device, identityToken);
  expect(response.status).toBe(200);
  return (await response.json() as { identities: Row[] }).identities;
}

function identitiesOn(db: Db, accountId: string): string[] {
  return (db.prepare("SELECT user_id FROM account_identities WHERE account_id = ? ORDER BY user_id").all(accountId) as { user_id: string }[]).map((row) => row.user_id);
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

function tombstoneOf(db: Db, accountId: string) {
  return (db.prepare("SELECT merged_into FROM accounts WHERE id = ?").get(accountId) as { merged_into: string | null }).merged_into;
}

async function makeTopic(app: App, device: string, name: string, critical = false) {
  const response = await app.request("/v1/topics", { method: "POST", headers: headers(device), body: JSON.stringify({ name, critical }) });
  expect(response.status).toBe(201);
  return await response.json() as { name: string; token: string };
}

function publish(app: App, topic: string, token: string) {
  return app.request(`/${topic}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Priority": "5" }, body: "wake up" });
}

describe("rule 1, proof on link", () => {
  it("the takeover fails: a new identity and no proof_token on a claimed account answers 403 and writes nothing", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_owner", { session: "sess_owner" });
    seedUser(db, "usr_thief", { session: "sess_thief" });
    onAccount(db, "usr_owner", "a", 1);

    const response = await link(app, "dv_a", { identity_token: "sess_thief", intent: "link" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "proof required" });
    expect(db.prepare("SELECT user_id, account_id, linked_at FROM account_identities").all()).toEqual([{ user_id: "usr_owner", account_id: "a", linked_at: 1 }]);
  });

  it("the repoint fails: an empty claimed account, an identity that has another account, no proof, 403 and both accounts unchanged", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_owner", { session: "sess_owner" });
    seedUser(db, "usr_thief", { session: "sess_thief" });
    // Account a is claimed and empty. The thief's own account is b.
    onAccount(db, "usr_owner", "a", 1);
    onAccount(db, "usr_thief", "b", 2);

    const response = await link(app, "dv_a", { identity_token: "sess_thief", intent: "link" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "proof required" });
    expect(identitiesOn(db, "a")).toEqual(["usr_owner"]);
    expect(identitiesOn(db, "b")).toEqual(["usr_thief"]);
    expect(tombstoneOf(db, "a")).toBeNull();
    expect(tombstoneOf(db, "b")).toBeNull();
    expect(db.prepare("SELECT id, account_id FROM devices ORDER BY id").all()).toEqual([{ id: "da", account_id: "a" }, { id: "db", account_id: "b" }]);
  });

  it("answers 403 for a proof_token that is invalid, expired, or of an identity not on the account", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_owner", { session: "sess_owner" });
    seedSession(db, "usr_owner", "sess_owner_old", 10, "2000-01-01T00:00:00.000Z");
    seedUser(db, "usr_new", { session: "sess_new" });
    seedUser(db, "usr_other", { session: "sess_other" });
    onAccount(db, "usr_owner", "a", 1);
    onAccount(db, "usr_other", "b", 2);

    // The identity being added cannot vouch for itself either.
    for (const proof of ["nope", "", "sess_owner_old", "sess_other", "sess_new", 42]) {
      const response = await link(app, "dv_a", { identity_token: "sess_new", intent: "link", proof_token: proof });
      expect([proof, response.status]).toEqual([proof, 403]);
      expect([proof, await response.json()]).toEqual([proof, { error: "proof required" }]);
    }
    expect(identitiesOn(db, "a")).toEqual(["usr_owner"]);
  });

  it("answers linked with a valid proof_token, and two Google identities can sit on one account", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_g1", { email: "one@gmail.com", session: "sess_g1" });
    seedUser(db, "usr_g2", { email: "two@gmail.com", session: "sess_g2" });
    seedProvider(db, "oa_g1", "usr_g1", "google");
    seedProvider(db, "oa_g2", "usr_g2", "google");
    expect((await link(app, "dv_a", { identity_token: "sess_g1" })).status).toBe(200);

    const response = await link(app, "dv_a", { identity_token: "sess_g2", intent: "link", proof_token: "sess_g1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a", outcome: "linked" });
    expect(identitiesOn(db, "a")).toEqual(["usr_g1", "usr_g2"]);
    expect((await rowsOf(app, "dv_a")).map((row) => row.provider)).toEqual(["google", "google"]);
  });

  it("lets a proven link reach the attach as before", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_1", { session: "sess_1" });
    seedUser(db, "usr_2", { session: "sess_2" });
    onAccount(db, "usr_1", "a", 1);
    onAccount(db, "usr_2", "b", 2);

    const response = await link(app, "dv_a", { identity_token: "sess_2", intent: "link", proof_token: "sess_1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "b", outcome: "attached" });
    expect(identitiesOn(db, "b")).toEqual(["usr_1", "usr_2"]);
  });

  it("answers already_linked without proof", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_1", { session: "sess_1" });
    onAccount(db, "usr_1", "a", 1);
    const response = await link(app, "dv_a", { identity_token: "sess_1", intent: "link" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a", outcome: "already_linked" });
  });

  it("needs no proof on an account holding no identity and answers claimed", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_1", { session: "sess_1" });
    const response = await link(app, "dv_a", { identity_token: "sess_1", intent: "link" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account_id: "a", outcome: "claimed" });
  });

  it("never reads proof_token under sign_in", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_1", { session: "sess_1" });
    seedUser(db, "usr_2", { session: "sess_2" });
    // A proof_token of the wrong type is not even parsed under sign_in.
    const first = await link(app, "dv_a", { identity_token: "sess_1", intent: "sign_in", proof_token: 42 });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ account_id: "a", outcome: "claimed" });
    // And a valid one does not turn the shared handset into a link.
    for (const body of [{ proof_token: "sess_1" }, { intent: "sign_in", proof_token: "sess_1" }]) {
      const response = await link(app, "dv_a", { identity_token: "sess_2", ...body });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "account has another identity" });
    }
    expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
  });
});

describe("rule 2, cap", () => {
  it("answers 409 cap identities for a link that would add a seventh identity", async () => {
    const { app, db } = setup();
    for (let i = 1; i <= 7; i += 1) seedUser(db, `usr_${i}`, { session: `sess_${i}` });
    for (let i = 1; i <= 5; i += 1) onAccount(db, `usr_${i}`, "a", i);

    // The sixth fits.
    const sixth = await link(app, "dv_a", { identity_token: "sess_6", intent: "link", proof_token: "sess_1" });
    expect(sixth.status).toBe(200);
    expect(await sixth.json()).toEqual({ account_id: "a", outcome: "linked" });

    const seventh = await link(app, "dv_a", { identity_token: "sess_7", intent: "link", proof_token: "sess_1" });
    expect(seventh.status).toBe(409);
    expect(await seventh.json()).toEqual({ error: "cap", cap: "identities" });
    expect(count(db, "SELECT COUNT(*) AS count FROM account_identities WHERE account_id = 'a'")).toBe(6);
  });

  it("answers 409 cap identities for an attach that would bring the joined account to seven", async () => {
    const { app, db } = setup();
    for (let i = 1; i <= 7; i += 1) seedUser(db, `usr_${i}`, { session: `sess_${i}` });
    for (let i = 1; i <= 2; i += 1) onAccount(db, `usr_${i}`, "a", i);
    for (let i = 3; i <= 7; i += 1) onAccount(db, `usr_${i}`, "b", i);

    const response = await link(app, "dv_a", { identity_token: "sess_7", intent: "link", proof_token: "sess_1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "cap", cap: "identities" });
    expect(identitiesOn(db, "a")).toEqual(["usr_1", "usr_2"]);
    expect(tombstoneOf(db, "a")).toBeNull();
  });
});

describe("rule 4, GET /v1/account/identities", () => {
  function seedTwo(db: Db) {
    // usr_1 signs in with Apple and with Google under one verified address,
    // usr_2 with a second Google account.
    seedUser(db, "usr_1", { email: "zed@gmail.com", session: "sess_1" });
    seedUser(db, "usr_2", { email: "abcdefgh@x.io", session: "sess_2" });
    seedProvider(db, "oa_1g", "usr_1", "google", (NOW - 900) * 1000);
    seedProvider(db, "oa_1a", "usr_1", "apple", (NOW - 500) * 1000);
    seedProvider(db, "oa_2g", "usr_2", "google", (NOW - 100) * 1000);
    onAccount(db, "usr_1", "a", NOW - 1000);
    onAccount(db, "usr_2", "a", NOW - 200);
  }

  it("lists one row per provider sign-in, oldest first, with opaque stable ids", async () => {
    const { app, db } = setup();
    seedTwo(db);
    const rows = await rowsOf(app, "dv_a");
    expect(rows.map((row) => [row.provider, row.linked_at])).toEqual([["google", NOW - 900], ["apple", NOW - 500], ["google", NOW - 100]]);
    for (const row of rows) expect(row.id).toMatch(/^idn_[A-Za-z0-9_-]+$/);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    // Nothing internal shows through.
    expect(JSON.stringify(rows)).not.toMatch(/oa_1g|oa_1a|oa_2g|usr_1|usr_2/);
    expect((await rowsOf(app, "dv_a")).map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });

  it("gives a device token alone a hint and never the address", async () => {
    const { app, db } = setup();
    seedTwo(db);
    for (const header of [undefined, "nope", "sess_other"]) {
      if (header === "sess_other") seedUser(db, "usr_other", { session: "sess_other" });
      const response = await list(app, "dv_a", header);
      expect([header, response.status]).toEqual([header, 200]);
      const rows = (await response.json() as { identities: Row[] }).identities;
      expect(rows.map((row) => row.email_hint)).toEqual(["z•••@gmail.com", "z•••@gmail.com", "a•••@x.io"]);
      for (const row of rows) {
        expect(row.email).toBeUndefined();
        expect(row.email_hidden).toBe(false);
        expect(row.current ?? false).toBe(false);
      }
    }
  });

  it("makes the hint of a@x.io and abcdefgh@x.io the same length before the @", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_short", { email: "a@x.io" });
    seedUser(db, "usr_long", { email: "abcdefgh@x.io" });
    seedProvider(db, "oa_s", "usr_short", "google");
    seedProvider(db, "oa_l", "usr_long", "google");
    onAccount(db, "usr_short", "a", 1);
    onAccount(db, "usr_long", "a", 2);
    const hints = (await rowsOf(app, "dv_a")).map((row) => row.email_hint ?? "");
    expect(hints.sort()).toEqual(["a•••@x.io", "a•••@x.io"]);
    expect(hints[0]!.split("@")[0]!.length).toBe(hints[1]!.split("@")[0]!.length);
  });

  it("shows every address and marks the current identity's rows for a valid X-Identity-Token", async () => {
    const { app, db } = setup();
    seedTwo(db);
    const rows = await rowsOf(app, "dv_a", "sess_1");
    expect(rows.map((row) => [row.email, row.current])).toEqual([["zed@gmail.com", true], ["zed@gmail.com", true], ["abcdefgh@x.io", false]]);
  });

  it("hides an Apple private relay address with or without the header", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_relay", { email: "x7y8z9@privaterelay.appleid.com", session: "sess_relay" });
    seedProvider(db, "oa_r", "usr_relay", "apple");
    onAccount(db, "usr_relay", "a", 1);
    for (const header of [undefined, "sess_relay"]) {
      const [row] = await rowsOf(app, "dv_a", header);
      expect(row!.email_hidden).toBe(true);
      expect("email" in row!).toBe(false);
      expect("email_hint" in row!).toBe(false);
    }
  });

  it("is empty for an account that holds no identity", async () => {
    const { app } = setup();
    expect(await rowsOf(app, "dv_a")).toEqual([]);
  });

  it("answers 401 for a bad device token", async () => {
    const { app } = setup();
    expect((await list(app, "dv_nope")).status).toBe(401);
  });

  it("never lists another account's identities", async () => {
    const { app, db } = setup();
    seedTwo(db);
    expect(await rowsOf(app, "dv_b", "sess_1")).toEqual([]);
  });
});

describe("rule 5, DELETE /v1/account/identities/{identity_id}", () => {
  function seedPair(db: Db) {
    seedUser(db, "usr_1", { email: "one@gmail.com", session: "sess_1" });
    seedUser(db, "usr_2", { email: "two@icloud.com", session: "sess_2" });
    seedSession(db, "usr_1", "sess_1_old", 301);
    seedProvider(db, "oa_1", "usr_1", "google", 0, "rt_1");
    seedProvider(db, "oa_2", "usr_2", "apple", 0, "rt_2");
    onAccount(db, "usr_1", "a", 1);
    onAccount(db, "usr_2", "a", 2);
  }

  async function idOf(app: App, device: string, email: string): Promise<string> {
    const rows = await rowsOf(app, device, device === "dv_a" ? "sess_1" : undefined);
    const row = rows.find((candidate) => candidate.email === email);
    expect(row).toBeDefined();
    return row!.id;
  }

  it("removes one identity, its sessions and its user, after asking the revoker", async () => {
    const calls: [string, string | undefined, number][] = [];
    const { app, db } = setup({ revoke: { revoke: async (userId, only) => { calls.push([userId, only, count(db, 'SELECT COUNT(*) AS count FROM "account"')]); } } });
    seedPair(db);
    const id = await idOf(app, "dv_a", "two@icloud.com");

    const response = await remove(app, "dv_a", id, { identity_token: "sess_1" });
    expect(response.status).toBe(204);
    // Asked before anything was deleted, for that one provider sign-in.
    expect(calls).toEqual([["usr_2", "oa_2", 2]]);
    expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
    expect(count(db, 'SELECT COUNT(*) AS count FROM "user" WHERE id = ?', "usr_2")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS count FROM "session" WHERE "userId" = ?', "usr_2")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS count FROM "account" WHERE "userId" = ?', "usr_2")).toBe(0);
    expect((await rowsOf(app, "dv_a")).map((row) => row.provider)).toEqual(["google"]);
  });

  it("lets an identity remove itself while another remains", async () => {
    const { app, db } = setup();
    seedPair(db);
    const id = await idOf(app, "dv_a", "one@gmail.com");
    expect((await remove(app, "dv_a", id, { identity_token: "sess_1" })).status).toBe(204);
    expect(identitiesOn(db, "a")).toEqual(["usr_2"]);
  });

  it("goes ahead when the revoker throws", async () => {
    const { app, db } = setup({ revoke: { revoke: async () => { throw new Error("apple is down"); } } });
    seedPair(db);
    const id = await idOf(app, "dv_a", "two@icloud.com");
    expect((await remove(app, "dv_a", id, { identity_token: "sess_1" })).status).toBe(204);
    expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
  });

  it("removing one of two provider sign-ins keeps the asking session and ends the identity's other sessions", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_1", { email: "zed@gmail.com", session: "sess_1" });
    seedSession(db, "usr_1", "sess_2", 5000);
    seedProvider(db, "oa_g", "usr_1", "google");
    seedProvider(db, "oa_a", "usr_1", "apple");
    onAccount(db, "usr_1", "a", 1);
    const google = (await rowsOf(app, "dv_a", "sess_1")).find((row) => row.provider === "google")!;

    const response = await remove(app, "dv_a", google.id, { identity_token: "sess_1" });
    expect(response.status).toBe(204);
    expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
    expect(count(db, 'SELECT COUNT(*) AS count FROM "user" WHERE id = ?', "usr_1")).toBe(1);
    expect(db.prepare('SELECT id FROM "account"').all()).toEqual([{ id: "oa_a" }]);
    // The asking session still resolves: it lists with the address and current.
    expect((await rowsOf(app, "dv_a", "sess_1")).map((row) => [row.provider, row.email, row.current])).toEqual([["apple", "zed@gmail.com", true]]);
    expect(db.prepare('SELECT token FROM "session" ORDER BY token').all()).toEqual([{ token: "sess_1" }]);
  });

  it("removing an identity's last provider sign-in with its own session ends every session of it, the asking one included", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_u", { email: "u@gmail.com", session: "sess_u" });
    seedSession(db, "usr_u", "sess_u2", 5000);
    seedUser(db, "usr_v", { email: "v@icloud.com", session: "sess_v" });
    seedProvider(db, "oa_u", "usr_u", "google");
    seedProvider(db, "oa_v", "usr_v", "apple");
    onAccount(db, "usr_u", "a", 1);
    onAccount(db, "usr_v", "a", 2);
    const id = (await rowsOf(app, "dv_a", "sess_u")).find((row) => row.email === "u@gmail.com")!.id;

    expect((await remove(app, "dv_a", id, { identity_token: "sess_u" })).status).toBe(204);
    expect(count(db, 'SELECT COUNT(*) AS count FROM "session" WHERE "userId" = ?', "usr_u")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM account_identities WHERE user_id = ?", "usr_u")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS count FROM "user" WHERE id = ?', "usr_u")).toBe(0);
    expect(identitiesOn(db, "a")).toEqual(["usr_v"]);
  });

  it("removing another identity's last provider sign-in keeps every session of the asking identity", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_u", { email: "u@gmail.com", session: "sess_u" });
    seedSession(db, "usr_u", "sess_u2", 5000);
    seedUser(db, "usr_v", { email: "v@icloud.com", session: "sess_v" });
    seedSession(db, "usr_v", "sess_v2", 5000);
    seedProvider(db, "oa_u", "usr_u", "google");
    seedProvider(db, "oa_v", "usr_v", "apple");
    onAccount(db, "usr_u", "a", 1);
    onAccount(db, "usr_v", "a", 2);
    const id = (await rowsOf(app, "dv_a", "sess_v")).find((row) => row.email === "u@gmail.com")!.id;

    expect((await remove(app, "dv_a", id, { identity_token: "sess_v" })).status).toBe(204);
    expect(count(db, 'SELECT COUNT(*) AS count FROM "session" WHERE "userId" = ?', "usr_u")).toBe(0);
    expect(db.prepare('SELECT token FROM "session" WHERE "userId" = ? ORDER BY token').all("usr_v")).toEqual([{ token: "sess_v" }, { token: "sess_v2" }]);
    expect(identitiesOn(db, "a")).toEqual(["usr_v"]);
  });

  it("leaves topics, topic tokens, devices, billing ids and packs untouched, and the removed identity can no longer delete the account", async () => {
    const { app, db } = setup();
    seedPair(db);
    const topic = await makeTopic(app, "dv_a", "prod", true);
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('rc_a', 'a', 1, NULL, 'free')").run();
    db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES ('rc_a', 'pro', NULL)").run();
    db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('a', 'pro', NULL, 'test', 1)").run();
    const snapshot = () => ({
      topics: db.prepare("SELECT * FROM topics ORDER BY id").all(),
      tokens: db.prepare("SELECT * FROM topic_tokens ORDER BY id").all(),
      devices: db.prepare("SELECT * FROM devices ORDER BY id").all(),
      billing: db.prepare("SELECT * FROM account_billing_ids ORDER BY app_user_id").all(),
      packs: db.prepare("SELECT * FROM billing_packs ORDER BY app_user_id").all(),
      grants: db.prepare("SELECT * FROM account_pack_grants ORDER BY account_id").all(),
      accounts: db.prepare("SELECT * FROM accounts ORDER BY id").all(),
    });
    const before = snapshot();
    const id = await idOf(app, "dv_a", "two@icloud.com");

    expect((await remove(app, "dv_a", id, { identity_token: "sess_1" })).status).toBe(204);
    expect(snapshot()).toEqual(before);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
    // The removed identity has no session left, so it cannot erase the account.
    const erase = await app.request("/v1/account", { method: "DELETE", headers: headers("dv_a"), body: JSON.stringify({ identity_token: "sess_2" }) });
    expect(erase.status).toBe(401);
    expect(count(db, "SELECT COUNT(*) AS count FROM accounts WHERE id = 'a'")).toBe(1);
  });

  it("answers 401 for a missing, invalid, expired or foreign identity_token", async () => {
    const { app, db } = setup();
    seedPair(db);
    seedSession(db, "usr_1", "sess_1_expired", 10, "2000-01-01T00:00:00.000Z");
    seedUser(db, "usr_x", { session: "sess_x" });
    onAccount(db, "usr_x", "b", 3);
    const id = await idOf(app, "dv_a", "two@icloud.com");
    expect((await remove(app, "dv_a", id)).status).toBe(401);
    expect((await remove(app, "dv_a", id, {})).status).toBe(401);
    for (const token of ["nope", "sess_1_expired", "sess_x"]) {
      expect([token, (await remove(app, "dv_a", id, { identity_token: token })).status]).toEqual([token, 401]);
    }
    expect((await remove(app, "dv_nope", id, { identity_token: "sess_1" })).status).toBe(401);
    expect(identitiesOn(db, "a")).toEqual(["usr_1", "usr_2"]);
  });

  it("answers 403 recent sign-in required for a session older than 300 seconds", async () => {
    const { app, db } = setup();
    seedPair(db);
    seedSession(db, "usr_1", "sess_1_edge", 300);
    const id = await idOf(app, "dv_a", "two@icloud.com");
    const response = await remove(app, "dv_a", id, { identity_token: "sess_1_old" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "recent sign-in required" });
    expect(identitiesOn(db, "a")).toEqual(["usr_1", "usr_2"]);
    // Exactly 300 seconds is still fresh.
    expect((await remove(app, "dv_a", id, { identity_token: "sess_1_edge" })).status).toBe(204);
  });

  it("answers 404 for an id that is not on this account", async () => {
    const { app, db } = setup();
    seedPair(db);
    seedUser(db, "usr_b", { email: "b@x.io", session: "sess_b" });
    seedProvider(db, "oa_b", "usr_b", "google");
    onAccount(db, "usr_b", "b", 3);
    const theirs = (await rowsOf(app, "dv_b"))[0]!.id;
    for (const id of ["idn_nope", theirs, "oa_2"]) {
      expect([id, (await remove(app, "dv_a", id, { identity_token: "sess_1" })).status]).toEqual([id, 404]);
    }
    expect(identitiesOn(db, "b")).toEqual(["usr_b"]);
  });

  it("answers 409 last identity for the only provider sign-in the account holds", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_1", { email: "one@gmail.com", session: "sess_1" });
    seedProvider(db, "oa_1", "usr_1", "google");
    onAccount(db, "usr_1", "a", 1);
    const [row] = await rowsOf(app, "dv_a");
    const response = await remove(app, "dv_a", row!.id, { identity_token: "sess_1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "last identity" });
    expect(identitiesOn(db, "a")).toEqual(["usr_1"]);
  });

  it("answers 409 live incident while an alarm is open, and an acked one does not block", async () => {
    const { app, db } = setup();
    seedPair(db);
    const topic = await makeTopic(app, "dv_a", "prod", true);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
    const incident = db.prepare("SELECT id FROM incidents WHERE state = 'open'").get() as { id: string };
    const id = await idOf(app, "dv_a", "two@icloud.com");

    const response = await remove(app, "dv_a", id, { identity_token: "sess_1" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "live incident", incident_id: incident.id });
    expect(identitiesOn(db, "a")).toEqual(["usr_1", "usr_2"]);

    expect((await app.request(`/v1/incidents/${incident.id}/ack`, { method: "POST", headers: headers("dv_a") })).status).toBe(200);
    expect((await remove(app, "dv_a", id, { identity_token: "sess_1" })).status).toBe(204);
  });

  it("runs the checks in the contract's order", async () => {
    const { app, db } = setup();
    seedUser(db, "usr_1", { email: "one@gmail.com", session: "sess_1" });
    seedSession(db, "usr_1", "sess_1_old", 301);
    seedProvider(db, "oa_1", "usr_1", "google");
    onAccount(db, "usr_1", "a", 1);
    seedUser(db, "usr_x", { session: "sess_x_old", age: 301 });
    onAccount(db, "usr_x", "b", 2);
    const topic = await makeTopic(app, "dv_a", "prod", true);
    expect((await publish(app, "prod", topic.token)).status).toBe(200);
    const [row] = await rowsOf(app, "dv_a");

    // A foreign session that is also old: 401 before 403.
    expect((await remove(app, "dv_a", "idn_nope", { identity_token: "sess_x_old" })).status).toBe(401);
    // An old session and an unknown id: 403 before 404.
    expect((await remove(app, "dv_a", "idn_nope", { identity_token: "sess_1_old" })).status).toBe(403);
    // An unknown id on an account with one identity: 404 before 409.
    expect((await remove(app, "dv_a", "idn_nope", { identity_token: "sess_1" })).status).toBe(404);
    // The last identity with an alarm ringing: last identity before live incident.
    const last = await remove(app, "dv_a", row!.id, { identity_token: "sess_1" });
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: "last identity" });
  });
});

describe("rule 6, selfhosted", () => {
  it("answers 501 on both identity routes", async () => {
    const { app } = setup({ mode: "selfhosted" });
    for (const response of [await list(app, "dv_a"), await remove(app, "dv_a", "idn_x", { identity_token: "x" })]) {
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: "not supported in selfhosted mode" });
    }
  });
});
