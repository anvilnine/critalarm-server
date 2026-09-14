import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../index.js";
import { ensureSelfHostedIdentity } from "../../admin/credentials.js";
import { credentialHash } from "../../tier/auth.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(mode: "selfhosted" | "relay" | "hosted") {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const admin = ensureSelfHostedIdentity(db).token;
  for (const account of ["a", "b"]) {
    db.prepare("INSERT INTO accounts(id,tier,created_at) VALUES (?,'free',1)").run(account);
    db.prepare("INSERT INTO devices(id,account_id,device_token_hash,platform,push_token,last_seen) VALUES (?,?,?,'ios','push',1)").run(account, account, credentialHash(`dv_${account}`));
  }
  let id = 0;
  const dispatch = vi.fn(async () => {});
  const app = createApp({ db, config: { mode, baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "full", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false }, clock: { now: () => 1000 }, ids: { message: () => `m_${++id}`, incident: () => `inc_${++id}`, timer: () => `tm_${++id}` }, dispatch });
  const token = mode === "selfhosted" ? admin : "dv_a";
  const headers = { Authorization: `Bearer ${token}` };
  return { db, app, admin, headers, dispatch };
}

describe.each(["selfhosted", "relay", "hosted"] as const)("%s poll and send", mode => {
  it("poll accepts topic and mode-appropriate management credentials, rejects other credentials", async () => {
    const { app, headers, admin } = setup(mode);
    const created = await app.request("/v1/topics", { method: "POST", headers, body: JSON.stringify({ name: "prod" }) });
    const { token } = await created.json() as { token: string };
    expect((await app.request("/prod", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "history" })).status).toBe(200);
    for (const authorization of [headers.Authorization, `Bearer ${token}`, `Basic ${Buffer.from(`user:${token}`).toString("base64")}`]) {
      const response = await app.request("/prod/json?poll=1", { headers: { Authorization: authorization } });
      expect(response.status).toBe(200);
      expect(JSON.parse((await response.text()).trim())).toMatchObject({ message: "history", priority: 3 });
    }
    expect((await app.request(`/prod/json?poll=1&auth=${Buffer.from(`Bearer ${token}`).toString("base64")}`)).status).toBe(200);
    for (const invalid of ["dv_bad", "ad_bad", "tk_bad", mode === "selfhosted" ? "dv_a" : admin]) {
      expect((await app.request("/prod/json?poll=1", { headers: { Authorization: `Bearer ${invalid}` } })).status).toBe(401);
    }
    expect((await app.request("/prod/json?poll=1")).status).toBe(401);
    expect((await app.request("/missing/json?poll=1", { headers })).status).toBe(404);
    expect((await app.request("/missing/json?poll=1", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("send follows every priority rule and joins a critical incident without minting tokens", async () => {
    const { app, db, headers, dispatch } = setup(mode);
    await app.request("/v1/topics", { method: "POST", headers, body: JSON.stringify({ name: "prod" }) });
    const tokens = db.prepare("SELECT * FROM topic_tokens").all();
    for (const critical of [false, true]) {
      await app.request("/v1/topics/prod", { method: "PATCH", headers, body: JSON.stringify({ critical }) });
      for (const priority of [undefined, 1, 2, 3, 4, 5, "urgent"] as const) {
        dispatch.mockClear();
        const response = await app.request("/v1/topics/prod/send", { method: "POST", headers, body: JSON.stringify({ message: "backup failed", title: "Backup", tags: ["warning"], priority }) });
        expect(response.status).toBe(200);
        const result = await response.json() as { id: string; incident_id: string | null };
        expect(Object.keys(result).sort()).toEqual(["id", "incident_id"]);
        const effectivePriority = priority === "urgent" ? 5 : priority ?? 3;
        if (critical && effectivePriority === 5) expect(result.incident_id).toMatch(/^inc_/);
        else expect(result.incident_id).toBeNull();
        expect(db.prepare("SELECT body, title, priority, tags FROM messages WHERE id=?").get(result.id)).toEqual({ body: "backup failed", title: "Backup", priority: effectivePriority, tags: '["warning"]' });
        expect(dispatch).toHaveBeenCalledTimes(effectivePriority >= 4 ? 1 : 0);
        if (effectivePriority >= 4) expect(dispatch).toHaveBeenCalledWith([expect.objectContaining({ priority: effectivePriority, critical: critical && effectivePriority === 5, relayContent: "full" })]);
        if (!critical) expect(db.prepare("SELECT COUNT(*) AS count FROM incidents").get()).toEqual({ count: 0 });
      }
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM incidents").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT * FROM topic_tokens").all()).toEqual(tokens);
  });

  it("send rejects missing message, invalid priority, oversized messages and publish credentials", async () => {
    const { app, headers } = setup(mode);
    const { token } = await (await app.request("/v1/topics", { method: "POST", headers, body: JSON.stringify({ name: "prod" }) })).json() as { token: string };
    for (const body of [{}, { message: null }, { message: "x", priority: 6 }]) {
      expect((await app.request("/v1/topics/prod/send", { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await app.request("/v1/topics/prod/send", { method: "POST", headers, body: JSON.stringify({ message: "x".repeat(4097) }) })).status).toBe(413);
    expect((await app.request("/v1/topics/prod/send", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: '{"message":"x"}' })).status).toBe(401);
  });
});

it.each(["relay", "hosted"] as const)("%s hides other accounts' topics from poll and send", async mode => {
  const { app, headers } = setup(mode);
  await app.request("/v1/topics", { method: "POST", headers, body: '{"name":"private"}' });
  for (const name of ["private", "missing"]) {
    const other = { Authorization: "Bearer dv_b" };
    expect((await app.request(`/${name}/json?poll=1`, { headers: other })).status).toBe(404);
    expect((await app.request(`/v1/topics/${name}/send`, { method: "POST", headers: other, body: '{"message":"x"}' })).status).toBe(404);
  }
});
