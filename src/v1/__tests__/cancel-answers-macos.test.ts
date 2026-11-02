import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { reportCancelAnswers } from "../../admin/cancel-answers-report.js";
import { createApp } from "../../index.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { parseAnswer } from "../cancel-answers.js";

// api.md §3.9, contract 1.25.0, rule 8 of the task. A cancel answer may carry
// platform "macos". Any other value the contract does not name is still 400.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const START = 1_760_000_000;

// Account a is free now and was Hosted once, and its one device is a Mac.
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('a', 'free', 1)").run();
  db.prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES ('tch_a', 'a', 'free', 'hosted', 'test', NULL, 1)").run();
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_a', 'a', ?, 'macos', 'aaaa0001', 1)")
    .run(createHash("sha256").update("dv_a").digest("hex"));
  const app = createApp({
    config: { mode: "hosted", baseUrl: "https://alerts.example.com", relayUrl: "https://relay.example.com", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false },
    db,
    clock: { now: () => START },
    ids: { message: () => "m_1", incident: () => "inc_1", timer: () => "tm_1" },
    dispatch: async () => {},
  });
  return { app, db };
}

function send(app: ReturnType<typeof setup>["app"], body: unknown) {
  return app.request("/v1/account/cancel-reason", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer dv_a" },
    body: JSON.stringify(body),
  });
}

describe("rule 8: a cancel answer may carry platform macos", () => {
  it("parses platform macos", () => {
    expect(parseAnswer({ reason: "price", app_version: "1.0.0+12", platform: "macos" })).toEqual({ ok: true, input: { reason: "price", text: null, appVersion: "1.0.0+12", platform: "macos" } });
  });

  it("stores an answer sent from a Mac with platform macos, and the operator's report shows it", async () => {
    const { app, db } = setup();
    const response = await send(app, { reason: "selfhost", text: "running my own", app_version: "1.0.0+12", platform: "macos" });
    expect(response.status).toBe(204);
    expect(db.prepare("SELECT account_id, reason, text, app_version, platform FROM cancel_answers").all()).toEqual([
      { account_id: "a", reason: "selfhost", text: "running my own", app_version: "1.0.0+12", platform: "macos" },
    ]);
    expect(reportCancelAnswers(db).split("\n")).toContain(`${new Date(START * 1000).toISOString().slice(0, 10)}\tselfhost\tmacos\t1.0.0+12\t"running my own"`);
  });

  it("still answers 400 to any platform the contract does not name, and stores nothing", async () => {
    const { app, db } = setup();
    for (const platform of ["web", "macOS", "mac", "darwin", "", null, 1]) {
      const response = await send(app, { reason: "price", app_version: "1.0.0+12", platform });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM cancel_answers").get()).toEqual({ n: 0 });
  });
});
