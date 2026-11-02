import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import type { Config } from "../../config.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { parseAnswer, storeAnswer, type AnswerInput } from "../cancel-answers.js";

// api.md §3.9. One answer to "What made you cancel?", sent by the app.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const DAY = 86_400;
const START = 1_760_000_000;
let now = START;

type Mode = NonNullable<Config["mode"]>;

function tierChange(db: ReturnType<typeof openDatabase>, account: string, to: string) {
  db.prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES (?, ?, 'free', ?, 'test', NULL, 1)").run(`tch_${account}_${to}`, account, to);
}

// Accounts and their tokens:
//   a  free now, was Hosted once (a tier_changes row)   dv_a
//   b  the same, a second account                        dv_b
//   c  free, never Hosted                                dv_c
//   d  Hosted now, no tier_changes row                   dv_d
//   e  free now; its tombstone f was Hosted once         dv_e
//   g  free now, was only ever `relay`                   dv_g
function setup(mode: Mode = "hosted") {
  now = START;
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES (?, 'free', 1)").run(id);
  db.prepare("UPDATE accounts SET tier = 'hosted' WHERE id = 'd'").run();
  db.prepare("UPDATE accounts SET merged_into = 'e' WHERE id = 'f'").run();
  tierChange(db, "a", "hosted");
  tierChange(db, "b", "hosted");
  tierChange(db, "f", "hosted");
  tierChange(db, "g", "relay");
  for (const account of ["a", "b", "c", "d", "e", "g"]) {
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES (?, ?, ?, 'ios', 'x', 1)")
      .run(`dev_${account}`, account, createHash("sha256").update(`dv_${account}`).digest("hex"));
  }
  const app = createApp({
    config: { mode, baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
    db,
    clock: { now: () => now },
    ids: { message: () => `m_${Math.random()}`, incident: () => `inc_${Math.random()}`, timer: () => `tm_${Math.random()}` },
    dispatch: async () => {},
  });
  return { app, db };
}

const good = () => ({ reason: "price", app_version: "1.0.0+12", platform: "ios" });

function send(app: ReturnType<typeof setup>["app"], body: unknown, device: string | null = "dv_a", headers: Record<string, string> = {}) {
  return app.request("/v1/account/cancel-reason", {
    method: "POST",
    headers: { "content-type": "application/json", ...(device === null ? {} : { Authorization: `Bearer ${device}` }), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Row = { account_id: string; created_at: number; reason: string; text: string | null; app_version: string; platform: string; updated_at: number };

function rows(db: ReturnType<typeof openDatabase>): Row[] {
  return db.prepare("SELECT account_id, created_at, reason, text, app_version, platform, updated_at FROM cancel_answers ORDER BY account_id, created_at").all() as Row[];
}

describe("POST /v1/account/cancel-reason", () => {
  it("stores a valid answer and answers 204 with no body", async () => {
    const { app, db } = setup();
    const response = await send(app, good());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(rows(db)).toEqual([{ account_id: "a", created_at: now, reason: "price", text: null, app_version: "1.0.0+12", platform: "ios", updated_at: now }]);
  });

  it("takes every one of the six reasons", async () => {
    const { app, db } = setup();
    for (const reason of ["price", "unused", "selfhost", "missing", "broken", "other"]) {
      expect((await send(app, { ...good(), reason })).status).toBe(204);
      now += 31 * DAY;
    }
    expect(rows(db).map((row) => row.reason)).toEqual(["price", "unused", "selfhost", "missing", "broken", "other"]);
  });

  it("takes an account that holds Hosted now, one that was assigned it, and one whose tombstone was", async () => {
    const { app, db } = setup();
    expect((await send(app, good(), "dv_d")).status).toBe(204);
    expect((await send(app, good(), "dv_a")).status).toBe(204);
    expect((await send(app, good(), "dv_e")).status).toBe(204);
    expect(rows(db).map((row) => row.account_id)).toEqual(["a", "d", "e"]);
  });

  it("refuses an account that was never assigned Hosted with 403 and stores nothing", async () => {
    const { app, db } = setup();
    for (const device of ["dv_c", "dv_g"]) {
      const response = await send(app, good(), device);
      expect(response.status, device).toBe(403);
      expect(await response.json()).toEqual({ error: "tier", tier: "hosted" });
    }
    expect(rows(db)).toEqual([]);
  });

  it("refuses an account with no token or a wrong token", async () => {
    const { app, db } = setup();
    expect((await send(app, good(), null)).status).toBe(401);
    expect((await send(app, good(), "dv_nobody")).status).toBe(401);
    expect(rows(db)).toEqual([]);
  });

  it("rejects an unknown reason and stores nothing", async () => {
    const { app, db } = setup();
    const response = await send(app, { ...good(), reason: "expensive" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid reason" });
    expect(rows(db)).toEqual([]);
  });

  it("rejects text over 500 characters and stores nothing", async () => {
    const { app, db } = setup();
    const response = await send(app, { ...good(), text: "x".repeat(501) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "text too long" });
    expect(rows(db)).toEqual([]);
  });

  it("takes exactly 500 characters, and counts an emoji as one", async () => {
    const { app, db } = setup();
    expect((await send(app, { ...good(), text: "x".repeat(500) }, "dv_a")).status).toBe(204);
    expect((await send(app, { ...good(), text: "😀".repeat(500) }, "dv_b")).status).toBe(204);
    const over = await send(app, { ...good(), text: "😀".repeat(501) }, "dv_d");
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: "text too long" });
    expect(rows(db)).toHaveLength(2);
  });

  it("counts the length after trimming", async () => {
    const { app, db } = setup();
    expect((await send(app, { ...good(), text: `   ${"x".repeat(500)}   ` })).status).toBe(204);
    expect(rows(db)[0]?.text).toBe("x".repeat(500));
  });

  it("treats absent text and null text as valid", async () => {
    const { app, db } = setup();
    expect((await send(app, good(), "dv_a")).status).toBe(204);
    expect((await send(app, { ...good(), text: null }, "dv_b")).status).toBe(204);
    expect(rows(db).map((row) => row.text)).toEqual([null, null]);
  });

  it("trims the text, and stores empty text as none", async () => {
    const { app, db } = setup();
    await send(app, { ...good(), text: "  moved to my own box  " }, "dv_a");
    await send(app, { ...good(), text: "   " }, "dv_b");
    expect(rows(db).map((row) => row.text)).toEqual(["moved to my own box", null]);
  });

  it("rejects every malformed body with invalid request", async () => {
    const { app, db } = setup();
    const bad: unknown[] = [
      "not json",
      "",
      "[]",
      "null",
      "\"price\"",
      { ...good(), reason: undefined },
      { ...good(), reason: 5 },
      { ...good(), app_version: undefined },
      { ...good(), app_version: "" },
      { ...good(), app_version: "1.0 beta" },
      { ...good(), app_version: "1".repeat(33) },
      { ...good(), platform: "web" },
      { ...good(), platform: undefined },
      { ...good(), text: 12 },
      { ...good(), text: ["a"] },
    ];
    for (const body of bad) {
      const response = await send(app, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
    }
    expect(rows(db)).toEqual([]);
  });

  it("takes an app_version of 32 characters of the allowed set", async () => {
    const { app, db } = setup();
    const version = "1.0.0+12_rc-1".padEnd(32, "a");
    expect((await send(app, { ...good(), app_version: version })).status).toBe(204);
    expect(rows(db)[0]?.app_version).toBe(version);
  });

  it("ignores a field it does not know, such as a plan end", async () => {
    const { app, db } = setup();
    expect((await send(app, { ...good(), ends_at: 1, answer_id: "x" })).status).toBe(204);
    expect(rows(db)).toHaveLength(1);
  });

  it("checks in the documented order", async () => {
    const { app } = setup();
    // 6 before 7: shape before reason.
    expect(await (await send(app, { ...good(), reason: "expensive", platform: "web" })).json()).toEqual({ error: "invalid request" });
    // 7 before 8: reason before text length.
    expect(await (await send(app, { ...good(), reason: "expensive", text: "x".repeat(900) })).json()).toEqual({ error: "invalid reason" });
    // 5 before 6: a payer with a huge body that is not JSON hears 413.
    expect((await send(app, "x".repeat(9000))).status).toBe(413);
    // 4 before 5: a non-payer with a huge body hears 403, not 413.
    expect((await send(app, { ...good(), text: "x".repeat(20_000) }, "dv_c")).status).toBe(403);
    // 2 before everything after it.
    expect((await send(app, { ...good(), text: "x".repeat(20_000) }, null)).status).toBe(401);
  });

  it("checks the request limit before the tier and the size", async () => {
    const { app } = setup();
    for (let index = 0; index < 30; index += 1) await send(app, good(), "dv_c");
    const huge = await send(app, { ...good(), text: "x".repeat(20_000) }, "dv_c");
    expect(huge.status).toBe(429);
    expect(await huge.json()).toEqual({ error: "rate limited" });
  });

  it("answers 413 with a plain body over 8192 bytes, measured on the raw request", async () => {
    const { app, db } = setup();
    const response = await send(app, { ...good(), text: "x".repeat(9000) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request too large" });
    // Padding a valid body with spaces also counts: the limit is on raw bytes.
    expect((await send(app, JSON.stringify(good()) + " ".repeat(8200))).status).toBe(413);
    // 8192 bytes exactly is inside the limit.
    const exact = JSON.stringify(good()) + " ".repeat(8192 - Buffer.byteLength(JSON.stringify(good())));
    expect(Buffer.byteLength(exact)).toBe(8192);
    expect((await send(app, exact)).status).toBe(204);
    expect(rows(db)).toHaveLength(1);
  });

  it("refuses a declared Content-Length over 8192 without reading the body", async () => {
    const { app, db } = setup();
    const response = await send(app, good(), "dv_a", { "content-length": "9000" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request too large" });
    expect(rows(db)).toEqual([]);
  });

  it("fits every valid text: 500 emoji written as \\u escapes are about 6000 bytes", async () => {
    const { app, db } = setup();
    const escaped = "\\ud83d\\ude00".repeat(500);
    const raw = `{"reason":"other","text":"${escaped}","app_version":"1.0.0+12","platform":"android"}`;
    expect(Buffer.byteLength(raw)).toBeGreaterThan(6000);
    expect(Buffer.byteLength(raw)).toBeLessThan(8192);
    expect((await send(app, raw)).status).toBe(204);
    expect(rows(db)[0]?.text).toBe("😀".repeat(500));
  });

  it("the chip answer arrives, then the text arrives, and the text is stored", async () => {
    const { app, db } = setup();
    await send(app, good());
    expect(rows(db)[0]?.text).toBeNull();
    now += 5;
    expect((await send(app, { ...good(), text: "too much for what I use" })).status).toBe(204);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]?.text).toBe("too much for what I use");
    expect(rows(db)[0]?.created_at).toBe(START);
    expect(rows(db)[0]?.updated_at).toBe(now);
  });

  it("the text arrives first, then the chip answer is retried, and the text stays", async () => {
    const { app, db } = setup();
    await send(app, { ...good(), text: "text first" });
    expect((await send(app, good())).status).toBe(204);
    expect(rows(db)).toMatchObject([{ text: "text first" }]);
    expect(rows(db)).toHaveLength(1);
  });

  it("a repeat never changes the reason, version or platform, and always answers 204", async () => {
    const { app, db } = setup();
    await send(app, good());
    now += 60;
    const again = await send(app, { reason: "broken", app_version: "9.9.9", platform: "android" });
    expect(again.status).toBe(204);
    expect(rows(db)).toMatchObject([{ reason: "price", app_version: "1.0.0+12", platform: "ios", created_at: START, updated_at: START }]);
  });

  it("fills an empty text once and never replaces it", async () => {
    const { app, db } = setup();
    await send(app, good());
    await send(app, { ...good(), text: "wrote this first" });
    expect((await send(app, { ...good(), text: "an older draft" })).status).toBe(204);
    expect((await send(app, { ...good(), text: "   " })).status).toBe(204);
    expect((await send(app, good())).status).toBe(204);
    expect(rows(db)[0]?.text).toBe("wrote this first");
    expect(rows(db)).toHaveLength(1);
  });

  it("an empty text on a repeat does not count as filling it", async () => {
    const { app, db } = setup();
    await send(app, good());
    await send(app, { ...good(), text: "   " });
    await send(app, { ...good(), text: null });
    await send(app, { ...good(), text: "the real one" });
    expect(rows(db)[0]?.text).toBe("the real one");
  });

  it("two phones on one account make one answer", async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_a2', 'a', ?, 'android', 'y', 1)")
      .run(createHash("sha256").update("dv_a2").digest("hex"));
    await send(app, good(), "dv_a");
    await send(app, { ...good(), platform: "android", text: "from the second phone" }, "dv_a2");
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ platform: "ios", text: "from the second phone" });
  });

  it("any call inside 30 days of the first is a repeat, and the window does not move", async () => {
    const { app, db } = setup();
    await send(app, good());
    now += 29 * DAY;
    await send(app, { ...good(), text: "day 29" });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]?.text).toBe("day 29");
    // One second short of 30 days after the FIRST answer: still a repeat.
    now = START + 30 * DAY - 1;
    await send(app, { ...good(), reason: "broken" });
    expect(rows(db)).toHaveLength(1);
    // 31 days after the first answer: a repeat on day 29 did not extend the window.
    now = START + 31 * DAY;
    await send(app, { ...good(), reason: "broken" });
    expect(rows(db)).toHaveLength(2);
  });

  it("a call 30 days or more after the current answer starts a new one, and later calls go to the newest", async () => {
    const { app, db } = setup();
    await send(app, good());
    now += 30 * DAY;
    await send(app, { ...good(), reason: "unused" });
    expect(rows(db).map((row) => [row.created_at, row.reason])).toEqual([[START, "price"], [now, "unused"]]);
    now += DAY;
    await send(app, { ...good(), text: "for the second one" });
    expect(rows(db).map((row) => row.text)).toEqual([null, "for the second one"]);
  });

  it("the same call on two accounts is two answers", async () => {
    const { app, db } = setup();
    await send(app, good(), "dv_a");
    await send(app, good(), "dv_b");
    expect(rows(db).map((row) => row.account_id)).toEqual(["a", "b"]);
  });

  it("limits every call: 30 an hour, repeats and refused calls included", async () => {
    const { app } = setup();
    for (let index = 0; index < 30; index += 1) expect((await send(app, good())).status, `call ${index}`).toBe(204);
    const over = await send(app, good());
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate limited" });
    now += 3601;
    expect((await send(app, good())).status).toBe(204);

    // An account that is refused with 403 is limited all the same.
    for (let index = 0; index < 30; index += 1) expect((await send(app, good(), "dv_c")).status).toBe(403);
    expect((await send(app, good(), "dv_c")).status).toBe(429);
  });

  it("counts calls refused with 400 and 413 too", async () => {
    const { app } = setup();
    for (let index = 0; index < 15; index += 1) expect((await send(app, { ...good(), reason: "nope" })).status).toBe(400);
    for (let index = 0; index < 15; index += 1) expect((await send(app, "x".repeat(9000))).status).toBe(413);
    expect((await send(app, good())).status).toBe(429);
  });

  it("does not count a call the limit itself refuses, and the hour rolls", async () => {
    const { app } = setup();
    for (let index = 0; index < 30; index += 1) await send(app, good());
    now += 1800;
    for (let index = 0; index < 30; index += 1) expect((await send(app, good())).status).toBe(429);
    // The first 30 are out of the hour. Had the 30 refusals counted, this would be 429.
    now = START + 3600;
    expect((await send(app, good())).status).toBe(204);
  });

  it("does not count a call refused for its credential", async () => {
    const { app } = setup();
    for (let index = 0; index < 40; index += 1) expect((await send(app, good(), "dv_nobody")).status).toBe(401);
    expect((await send(app, good())).status).toBe(204);
  });

  it("counts per account", async () => {
    const { app } = setup();
    for (let index = 0; index < 30; index += 1) await send(app, good(), "dv_a");
    expect((await send(app, good(), "dv_a")).status).toBe(429);
    expect((await send(app, good(), "dv_b")).status).toBe(204);
  });
});

describe("two first calls in the same second", () => {
  const input: AnswerInput = { reason: "price", text: null, appVersion: "1.0.0+12", platform: "ios" };

  it("two phones sending at once make one answer and both hear 204", async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_a2', 'a', ?, 'android', 'y', 1)")
      .run(createHash("sha256").update("dv_a2").digest("hex"));
    const [first, second] = await Promise.all([
      send(app, good(), "dv_a"),
      send(app, { ...good(), platform: "android", text: "from the second phone" }, "dv_a2"),
    ]);
    expect([first.status, second.status]).toEqual([204, 204]);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ created_at: START, text: "from the second phone" });
  });

  it("a second connection to the same file sees the first answer and keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cancel-answers-"));
    const one = openDatabase(join(dir, "db.sqlite"));
    const two = openDatabase(join(dir, "db.sqlite"));
    try {
      migrate(one);
      one.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'hosted', 1)").run();
      const clock = { now: () => START };
      expect(storeAnswer(one, clock, "a", input)).toBe("stored");
      expect(storeAnswer(two, clock, "a", { ...input, reason: "broken", text: "second" })).toBe("kept");
      expect(two.prepare("SELECT reason, text FROM cancel_answers").all()).toEqual([{ reason: "price", text: "second" }]);
    } finally {
      one.close();
      two.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an insert that meets a row stored in the same second is a repeat, not an error", () => {
    const { db } = setup();
    db.prepare("INSERT INTO cancel_answers (account_id, created_at, reason, text, app_version, platform, updated_at) VALUES ('a', ?, 'price', NULL, '1.0.0+12', 'ios', ?)").run(START, START);
    // Stands in for a writer the read could not see: the lookup of the current
    // answer finds nothing, so the insert is what meets the existing row.
    const blind = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => sql.startsWith("SELECT created_at AS createdAt FROM cancel_answers")
            ? { get: () => undefined }
            : target.prepare(sql);
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as Database.Database;
    expect(storeAnswer(blind, { now: () => START }, "a", { ...input, reason: "broken", text: "late text" })).toBe("kept");
    expect(rows(db)).toMatchObject([{ reason: "price", text: "late text", created_at: START }]);
  });
});

describe("parseAnswer", () => {
  it("returns the cleaned input", () => {
    expect(parseAnswer({ reason: "other", text: " a ", app_version: "1", platform: "android" })).toEqual({ ok: true, input: { reason: "other", text: "a", appVersion: "1", platform: "android" } });
  });
});

describe("modes that have no Hosted plan", () => {
  it("selfhosted answers 501 before authentication, in the §3.7 words", async () => {
    const { app, db } = setup("selfhosted");
    for (const device of [null, "dv_a", "ad_wrong"]) {
      const response = await send(app, good(), device);
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: "not supported in selfhosted mode" });
    }
    expect(rows(db)).toEqual([]);
  });

  it("relay answers 501 before authentication, and §3.7 itself still works there", async () => {
    const { app, db } = setup("relay");
    for (const device of [null, "dv_a", "dv_nobody"]) {
      const response = await send(app, good(), device);
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: "not supported in relay mode" });
    }
    expect(rows(db)).toEqual([]);
    // Not part of this route: the §3.7 routes are not refused in relay mode.
    const join = await app.request("/v1/account/join-token", { method: "POST", headers: { Authorization: "Bearer dv_a" } });
    expect(join.status).toBe(200);
  });

  it("is never limited in those modes", async () => {
    const { app } = setup("relay");
    for (let index = 0; index < 40; index += 1) expect((await send(app, good())).status).toBe(501);
  });
});
