import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../index.js"; import { openDatabase } from "../../store/database.js"; import { migrate } from "../../store/migrations.js";
function setup(){const db=openDatabase(":memory:");migrate(db);for(const id of ["a","b"])db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES (?, 'free',1)").run(id);for(const [id,a,t] of [["da","a","dv_a"],["db","b","dv_b"]])db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES (?, ?, ?, 'ios','x',1)").run(id,a,createHash("sha256").update(t).digest("hex"));const ids={message:()=>"m_1",incident:()=>"inc_1",timer:()=>"tm_1"};return { app:createApp({config:{baseUrl:"https://alerts.example.com",relayUrl:"https://relay.critalarm.app",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false},db,clock:{now:()=>1000},ids,dispatch:async()=>{}}),db}}
describe("V1 topics",()=>{it("creates a private noncritical topic and only returns its token once",async()=>{const {app}=setup();const h={Authorization:"Bearer dv_a","content-type":"application/json"};const made=await app.request("/v1/topics",{method:"POST",headers:h,body:'{"name":"prod"}'});expect(made.status).toBe(201);expect(await made.json()).toMatchObject({name:"prod",critical:false,repeat_interval_s:30,max_ring_s:1800,desk_timer_s:600,relay_content:"none",token:expect.stringMatching(/^tk_/)});expect((await app.request("/v1/topics",{headers:h})).status).toBe(200);expect((await app.request("/v1/topics/prod",{method:"PATCH",headers:{Authorization:"Bearer dv_b","content-type":"application/json"},body:"{}"})).status).toBe(404)});});

describe("topic mutations", () => {
  it("patches owned settings and creates then deletes an opaque token", async () => {
    const {app} = setup(); const headers = { Authorization: "Bearer dv_a", "content-type": "application/json" };
    await app.request("/v1/topics", { method: "POST", headers, body: '{"name":"prod"}' });
    const patched = await app.request("/v1/topics/prod", { method: "PATCH", headers, body: '{"critical":true,"repeat_interval_s":45}' });
    expect(await patched.json()).toMatchObject({ critical: true, repeat_interval_s: 45, max_ring_s: 1800 });
    const token = await app.request("/v1/topics/prod/tokens", { method: "POST", headers });
    const tokenBody = await token.json() as { token: string; token_id: string };
    expect(tokenBody).toEqual({ token: expect.stringMatching(/^tk_/), token_id: expect.stringMatching(/^tok_/) });
    expect((await app.request(`/v1/topics/prod/tokens/${tokenBody.token_id}`, { method: "DELETE", headers })).status).toBe(204);
    const final = await app.request("/v1/topics/prod/tokens/tk_not_the_only_token", { method: "DELETE", headers });
    expect(final.status).toBe(404);
    expect((await app.request("/v1/topics/prod", { method: "DELETE", headers })).status).toBe(204);
  });
});

describe("topic token invariant", () => {
  it("refuses to delete a topic's final publishing token", async () => {
    const {app,db} = setup(); const headers = { Authorization: "Bearer dv_a", "content-type": "application/json" };
    await app.request("/v1/topics", { method:"POST",headers,body:'{"name":"prod"}' });
    const { id: token_id } = db.prepare("SELECT id FROM topic_tokens").get() as {id:string};
    const response = await app.request(`/v1/topics/prod/tokens/${token_id}`, { method:"DELETE",headers });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error:"topic must retain a token" });
  });
});
