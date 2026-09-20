import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../index.js"; import { openDatabase } from "../../store/database.js"; import { migrate } from "../../store/migrations.js";
import type { Config } from "../../config.js";
import { ensureSelfHostedIdentity } from "../../admin/credentials.js";
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(mode?: Config["mode"]){const db=openDatabase(":memory:");databases.push(db);migrate(db);for(const id of ["a","b"])db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES (?, 'free',1)").run(id);for(const [id,a,t] of [["da","a","dv_a"],["db","b","dv_b"]])db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES (?, ?, ?, 'ios','x',1)").run(id,a,createHash("sha256").update(t).digest("hex"));const ids={message:()=>"m_1",incident:()=>"inc_1",timer:()=>"tm_1"};return { app:createApp({config:{mode,baseUrl:"https://alerts.example.com",relayUrl:"https://relay.critalarm.app",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false},db,clock:{now:()=>1000},ids,dispatch:async()=>{}}),db}}
describe("V1 topics",()=>{it("creates a private noncritical topic and only returns its token once",async()=>{const {app}=setup();const h={Authorization:"Bearer dv_a","content-type":"application/json"};const made=await app.request("/v1/topics",{method:"POST",headers:h,body:'{"name":"prod"}'});expect(made.status).toBe(201);expect(await made.json()).toMatchObject({name:"prod",critical:false,repeat_interval_s:30,max_ring_s:1800,desk_timer_s:600,relay_content:"none",token:expect.stringMatching(/^tk_/)});expect((await app.request("/v1/topics",{headers:h})).status).toBe(200);expect((await app.request("/v1/topics/prod",{method:"PATCH",headers:{Authorization:"Bearer dv_b","content-type":"application/json"},body:"{}"})).status).toBe(404)});});

describe("topic mutations", () => {
  it("patches owned settings and creates then deletes an opaque token", async () => {
    const {app} = setup(); const headers = { Authorization: "Bearer dv_a", "content-type": "application/json" };
    await app.request("/v1/topics", { method: "POST", headers, body: '{"name":"prod"}' });
    const patched = await app.request("/v1/topics/prod", { method: "PATCH", headers, body: '{"critical":true,"repeat_interval_s":45}' });
    expect(await patched.json()).toMatchObject({ critical: true, repeat_interval_s: 45, max_ring_s: 1800 });
    const token = await app.request("/v1/topics/prod/tokens", { method: "POST", headers });
    const tokenBody = await token.json() as { token: string; token_id: string };
    expect(tokenBody).toEqual({ token: expect.stringMatching(/^tk_/), token_id: expect.stringMatching(/^tok_/), name: "Token 2" });
    expect((await app.request(`/v1/topics/prod/tokens/${tokenBody.token_id}`, { method: "DELETE", headers })).status).toBe(204);
    const final = await app.request("/v1/topics/prod/tokens/tk_not_the_only_token", { method: "DELETE", headers });
    expect(final.status).toBe(404);
    expect((await app.request("/v1/topics/prod", { method: "DELETE", headers })).status).toBe(204);
  });
});

describe("topic token invariant", () => {
  it("refuses to delete a topic's final publishing token", async () => {
    const {app} = setup(); const headers = { Authorization: "Bearer dv_a", "content-type": "application/json" };
    const made = await app.request("/v1/topics", { method:"POST",headers,body:'{"name":"prod"}' });
    const { token_id } = await made.json() as {token_id:string};
    const response = await app.request(`/v1/topics/prod/tokens/${token_id}`, { method:"DELETE",headers });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error:"topic must retain a token" });
  });
});

const headers = { Authorization: "Bearer dv_a", "content-type": "application/json" };
function request(app: ReturnType<typeof createApp>, method: string, path: string, body?: Record<string, unknown>, auth = headers) {
  return app.request(path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function create(app: ReturnType<typeof createApp>, name: string, critical?: boolean, tokenName?: string) {
  return request(app, "POST", "/v1/topics", { name, ...(critical === undefined ? {} : { critical }), ...(tokenName === undefined ? {} : { token_name: tokenName }) });
}
async function fillCap(app: ReturnType<typeof createApp>) {
  for (const name of ["one", "two"]) {
    const response = await create(app, name, true);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ critical: true });
  }
}
async function expectCap(response: Response) {
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: "cap", cap: "critical_topics" });
}

describe("contract 1.10.0 topic tokens", () => {
  it("lists a topic's token ids and never a token value", async () => {
    const { app } = setup();
    const made = await create(app, "prod");
    const original = await made.json() as { token: string; token_id: string };
    const extra = await request(app, "POST", "/v1/topics/prod/tokens");
    const second = await extra.json() as { token: string; token_id: string };

    const listed = await request(app, "GET", "/v1/topics/prod/tokens");
    expect(listed.status).toBe(200);
    const rows = await listed.json() as { token_id: string; name: string; created_at: number }[];
    expect(rows).toEqual([
      { token_id: original.token_id, name: "Token 1", created_at: 1000 },
      { token_id: second.token_id, name: "Token 2", created_at: 1000 },
    ]);
    expect(JSON.stringify(rows)).not.toContain(original.token);
    expect(JSON.stringify(rows)).not.toContain(second.token);
  });

  it("orders by created_at, not by the order the rows went in", async () => {
    const { app, db } = setup();
    const made = await create(app, "prod");
    const original = await made.json() as { token_id: string };
    const extra = await request(app, "POST", "/v1/topics/prod/tokens");
    const second = await extra.json() as { token_id: string };
    db.prepare("UPDATE topic_tokens SET created_at=? WHERE id=?").run(900, second.token_id);

    expect(await (await request(app, "GET", "/v1/topics/prod/tokens")).json()).toEqual([
      { token_id: second.token_id, name: "Token 2", created_at: 900 },
      { token_id: original.token_id, name: "Token 1", created_at: 1000 },
    ]);
  });

  it("drops a revoked token from the listing", async () => {
    const { app } = setup();
    const made = await create(app, "prod");
    const { token_id } = await made.json() as { token_id: string };
    const extra = await request(app, "POST", "/v1/topics/prod/tokens");
    const second = await extra.json() as { token_id: string };

    expect((await request(app, "DELETE", `/v1/topics/prod/tokens/${token_id}`)).status).toBe(204);
    expect(await (await request(app, "GET", "/v1/topics/prod/tokens")).json()).toEqual([
      { token_id: second.token_id, name: "Token 2", created_at: 1000 },
    ]);
  });

  it("answers 404 for a topic this account does not own", async () => {
    const { app } = setup();
    await create(app, "prod");
    const other = await request(app, "GET", "/v1/topics/prod/tokens", undefined, { ...headers, Authorization: "Bearer dv_b" });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "not found" });
    expect((await request(app, "GET", "/v1/topics/never-made/tokens")).status).toBe(404);
  });
});

describe("contract 1.5.0 topics", () => {
  it("returns the numeric duplicate error without creating another token", async () => {
    const { app, db } = setup();
    expect((await create(app, "prod")).status).toBe(201);
    const duplicate = await create(app, "prod");
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get("content-type")).toContain("application/json");
    expect(await duplicate.json()).toEqual({ code: 40901, http: 409, error: "topic already exists" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM topic_tokens").get()).toEqual({ count: 1 });
  });

  it("allows the same name in two accounts", async () => {
    const { app } = setup();
    expect((await create(app, "prod")).status).toBe(201);
    expect((await request(app, "POST", "/v1/topics", { name: "prod" }, { ...headers, Authorization: "Bearer dv_b" })).status).toBe(201);
  });

  it("returns the creation token id and revokes that token", async () => {
    const { app } = setup();
    const made = await create(app, "prod");
    const original = await made.json() as { token: string; token_id: string };
    expect(original.token_id).toMatch(/^tok_/);
    const poll = () => app.request("/prod/json?poll=1", { headers: { Authorization: `Bearer ${original.token}` } });
    expect((await poll()).status).toBe(200);
    const extra = await request(app, "POST", "/v1/topics/prod/tokens");
    const remaining = await extra.json() as { token_id: string };
    expect((await request(app, "DELETE", `/v1/topics/prod/tokens/${original.token_id}`)).status).toBe(204);
    expect((await poll()).status).toBe(401);
    const last = await request(app, "DELETE", `/v1/topics/prod/tokens/${remaining.token_id}`);
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: "topic must retain a token" });
  });

  it.each(["relay", "hosted"] as const)("caps critical creation in %s mode and still allows noncritical topics", async mode => {
    const { app, db } = setup(mode);
    await fillCap(app);
    await expectCap(await create(app, "three", true));
    expect(db.prepare("SELECT COUNT(*) AS count FROM topics").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM topic_tokens").get()).toEqual({ count: 2 });
    const normal = await create(app, "normal");
    expect(normal.status).toBe(201);
    expect(await normal.json()).toMatchObject({ critical: false });
    expect((await create(app, "off", false)).status).toBe(201);
    expect((await request(app, "POST", "/v1/topics", { name: "three", critical: true }, { ...headers, Authorization: "Bearer dv_b" })).status).toBe(201);
  });

  it("rejects a PATCH flipping critical on at the cap without changing settings", async () => {
    const { app } = setup();
    await fillCap(app);
    await create(app, "normal");
    await expectCap(await request(app, "PATCH", "/v1/topics/normal", { critical: true, repeat_interval_s: 45 }));
    const topics = await request(app, "GET", "/v1/topics");
    expect(await topics.json()).toContainEqual(expect.objectContaining({ name: "normal", critical: false, repeat_interval_s: 30 }));
  });

  it("allows a PATCH flipping critical on under the cap", async () => {
    const { app } = setup();
    await create(app, "one", true);
    await create(app, "normal");
    const response = await request(app, "PATCH", "/v1/topics/normal", { critical: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ critical: true });
  });

  it("allows PATCH when critical is already true at the cap", async () => {
    const { app } = setup();
    await fillCap(app);
    const response = await request(app, "PATCH", "/v1/topics/one", { critical: true, repeat_interval_s: 45 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ critical: true, repeat_interval_s: 45 });
    expect((await request(app, "PATCH", "/v1/topics/one", { desk_timer_s: 90 })).status).toBe(200);
  });

  it.each(["disable", "delete"])("%s frees a critical slot immediately", async action => {
    const { app } = setup();
    await fillCap(app);
    if (action === "disable") {
      const response = await request(app, "PATCH", "/v1/topics/one", { critical: false });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ critical: false });
    } else {
      expect((await request(app, "DELETE", "/v1/topics/one")).status).toBe(204);
    }
    expect((await create(app, "three", true)).status).toBe(201);
  });

  it.each(["relay", "hosted"])("treats the %s tier's null cap as unlimited for create and PATCH", async tier => {
    const { app, db } = setup();
    db.prepare("UPDATE accounts SET tier=? WHERE id='a'").run(tier);
    for (let i = 0; i < 10; i++) expect((await create(app, `topic-${i}`, true)).status).toBe(201);
    await create(app, "normal");
    expect((await request(app, "PATCH", "/v1/topics/normal", { critical: true })).status).toBe(200);
  });

  it("bypasses tier caps in selfhosted mode and keeps the default off", async () => {
    const { app, db } = setup("selfhosted");
    const { token } = ensureSelfHostedIdentity(db);
    // A finite synthetic tier proves the bypass is based on mode.
    db.prepare("UPDATE accounts SET tier='free' WHERE id='acc_selfhosted'").run();
    const auth = { ...headers, Authorization: `Bearer ${token}` };
    for (let i = 0; i < 5; i++) expect((await request(app, "POST", "/v1/topics", { name: `topic-${i}`, critical: true }, auth)).status).toBe(201);
    const normal = await request(app, "POST", "/v1/topics", { name: "normal" }, auth);
    expect(normal.status).toBe(201);
    expect(await normal.json()).toMatchObject({ critical: false });
    const patched = await request(app, "PATCH", "/v1/topics/normal", { critical: true }, auth);
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ critical: true });
  });
});

describe("contract 1.15.0 token names", () => {
  it("stores the token_name a topic is created with", async () => {
    const { app } = setup();
    const made = await create(app, "prod", undefined, "CI server");
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ name: "prod", token_name: "CI server" });
    expect(await (await request(app, "GET", "/v1/topics/prod/tokens")).json()).toEqual([
      { token_id: expect.stringMatching(/^tok_/), name: "CI server", created_at: 1000 },
    ]);
  });

  it("names a first token Token 1 when token_name is left off", async () => {
    const { app } = setup();
    expect(await (await create(app, "prod")).json()).toMatchObject({ token_name: "Token 1" });
  });

  it("treats a whitespace-only token_name as missing", async () => {
    const { app } = setup();
    expect(await (await create(app, "prod", undefined, "   ")).json()).toMatchObject({ token_name: "Token 1" });
    expect(await (await request(app, "GET", "/v1/topics/prod/tokens")).json()).toEqual([
      { token_id: expect.stringMatching(/^tok_/), name: "Token 1", created_at: 1000 },
    ]);
  });

  it("names an unnamed extra token after the topic's current count", async () => {
    const { app } = setup();
    await create(app, "prod");
    const extra = await request(app, "POST", "/v1/topics/prod/tokens");
    expect(extra.status).toBe(201);
    expect(await extra.json()).toEqual({ token: expect.stringMatching(/^tk_/), token_id: expect.stringMatching(/^tok_/), name: "Token 2" });
  });

  it("takes a name on an extra token", async () => {
    const { app } = setup();
    await create(app, "prod");
    const extra = await request(app, "POST", "/v1/topics/prod/tokens", { name: "Grafana" });
    expect(await extra.json()).toMatchObject({ name: "Grafana" });
  });

  it("renames a token and returns the updated row", async () => {
    const { app } = setup();
    const made = await create(app, "prod");
    const { token_id } = await made.json() as { token_id: string };
    const renamed = await request(app, "PATCH", `/v1/topics/prod/tokens/${token_id}`, { name: "Grafana prod" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ token_id, name: "Grafana prod", created_at: 1000 });
    expect(await (await request(app, "GET", "/v1/topics/prod/tokens")).json()).toEqual([
      { token_id, name: "Grafana prod", created_at: 1000 },
    ]);
  });

  it("answers 404 renaming a token id the topic does not hold", async () => {
    const { app } = setup();
    await create(app, "prod");
    const missing = await request(app, "PATCH", "/v1/topics/prod/tokens/tok_never_made", { name: "whatever" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });
  });

  it("answers 404 renaming a token on a topic another account owns", async () => {
    const { app } = setup();
    const made = await create(app, "prod");
    const { token_id } = await made.json() as { token_id: string };
    const other = await request(app, "PATCH", `/v1/topics/prod/tokens/${token_id}`, { name: "mine now" }, { ...headers, Authorization: "Bearer dv_b" });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "not found" });
    expect(await (await request(app, "GET", "/v1/topics/prod/tokens")).json()).toEqual([
      { token_id, name: "Token 1", created_at: 1000 },
    ]);
  });

  it("answers 400 renaming to a missing or blank name", async () => {
    const { app } = setup();
    const made = await create(app, "prod");
    const { token_id } = await made.json() as { token_id: string };
    for (const body of [{}, { name: "   " }, { name: 7 }]) {
      const response = await request(app, "PATCH", `/v1/topics/prod/tokens/${token_id}`, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
    }
  });

  it("cuts a 60 character name to 40 on create and on rename", async () => {
    const { app } = setup();
    const made = await create(app, "prod", undefined, "x".repeat(60));
    const { token_id, token_name } = await made.json() as { token_id: string; token_name: string };
    expect(token_name).toBe("x".repeat(40));
    const renamed = await request(app, "PATCH", `/v1/topics/prod/tokens/${token_id}`, { name: "y".repeat(60) });
    expect(await renamed.json()).toEqual({ token_id, name: "y".repeat(40), created_at: 1000 });
  });
});
