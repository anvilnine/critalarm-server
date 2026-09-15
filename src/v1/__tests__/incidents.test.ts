import { describe, expect, it } from "vitest";
import { createApp } from "../../index.js"; import { openDatabase } from "../../store/database.js"; import { migrate } from "../../store/migrations.js"; import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// /v1/info reports the package.json version, so the test reads it from there too.
const packageVersion = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
describe("V1 info",()=>{it("is public and reports hosted direct delivery",async()=>{const db=openDatabase(":memory:");migrate(db);const app=createApp({config:{baseUrl:"https://alerts.example.com",relayUrl:"https://relay.critalarm.app",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false},db,clock:{now:()=>1000},ids:{message:()=>"m",incident:()=>"i",timer:()=>"t"},dispatch:async()=>{}});expect(await (await app.request("/v1/info")).json()).toEqual({name:"critalarm",version:packageVersion,base_url:"https://alerts.example.com",relay_url:"https://relay.critalarm.app",relay_content:"none",mode:"hosted"});});});

describe("V1 incidents", () => {
  it("acks and closes an owned open incident while rejecting invalid state", async () => {
    const db=openDatabase(":memory:"); migrate(db); db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run(); db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('t','a','prod','https://alerts.example.com','hash',1,30,1800,42,'none',1)").run(); db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,last_message_at,max_ring_s) VALUES ('inc','t','open',1,1,1800)").run();
    const app=createApp({config:{baseUrl:"https://alerts.example.com",relayUrl:"https://relay.critalarm.app",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false},db,clock:{now:()=>1000},ids:{message:()=>"m",incident:()=>"new",timer:()=>"timer"},dispatch:async()=>{}}); const headers={Authorization:"Bearer dv_a"};
    expect((await app.request("/v1/incidents",{headers})).status).toBe(200); expect((await app.request("/v1/incidents?limit=bad",{headers})).status).toBe(400); expect((await app.request("/v1/incidents?state=nope",{headers})).status).toBe(400); const ack=await app.request("/v1/incidents/inc/ack",{method:"POST",headers}); expect(await ack.json()).toMatchObject({state:"acked",desk_timer_fires_at:1042}); expect((await app.request("/v1/incidents/inc/ack",{method:"POST",headers})).status).toBe(409); expect((await app.request("/v1/incidents/inc/close",{method:"POST",headers})).status).toBe(200);
  });
});

describe("incident detail and filters", () => {
  it("returns ordered complete messages and scopes details to the account", async () => {
    const db=openDatabase(":memory:"); migrate(db); for(const id of ["a","b"])db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES (?,'free',1)").run(id); for(const [id,account,token] of [["da","a","dv_a"],["db","b","dv_b"]])db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES (?, ?, ?, 'ios','x',1)").run(id,account,createHash("sha256").update(token).digest("hex")); db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('t','a','prod','https://a','h',1,30,60,30,'none',1)").run(); db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,last_message_at,max_ring_s) VALUES ('inc','t','open',1,2,60)").run(); db.prepare("INSERT INTO messages (id,topic_id,incident_id,title,body,priority,tags,click,markdown,created_at) VALUES ('m1','t','inc','one','first',5,'[\"x\"]','https://x',1,1),('m2','t','inc','two','second',5,'[]',NULL,0,2)").run();
    const app=createApp({config:{baseUrl:"https://a",relayUrl:"https://r",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false},db,clock:{now:()=>1},ids:{message:()=>"m",incident:()=>"i",timer:()=>"t"},dispatch:async()=>{}}); const h={Authorization:"Bearer dv_a"}; const detail=await app.request("/v1/incidents/inc",{headers:h}); const body=await detail.json() as {messages:{id:string;click?:string;markdown?:boolean;incident_id?:string}[]}; expect(body.messages).toEqual([expect.objectContaining({id:"m1",click:"https://x",markdown:true,incident_id:"inc"}),expect.objectContaining({id:"m2",incident_id:"inc"})]); expect((await app.request("/v1/incidents?state=open&topic=prod&limit=1",{headers:h})).status).toBe(200); expect((await app.request("/v1/incidents/inc",{headers:{Authorization:"Bearer dv_b"}})).status).toBe(404); expect((await app.request("/v1/incidents/inc/close",{method:"POST",headers:h})).status).toBe(409);
  });
});

describe("incident list filters", () => {
  it("applies state and topic filters before limiting newest incidents", async () => {
    const db=openDatabase(":memory:"); migrate(db); db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run(); db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    for(const [id,name] of [["prod","prod"],["acked","acked"],["stage","stage"]]) db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES (?, 'a', ?, 'https://a', ?,1,30,60,30,'none',1)").run(id,name,`h-${id}`);
    for(const [id,topic,state,opened] of [["inc_open","prod","open",40],["inc_acked","acked","acked",30],["inc_closed","prod","closed",20],["inc_stage","stage","open",10]]) db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,last_message_at,max_ring_s) VALUES (?,?,?,?,?,60)").run(id,topic,state,opened,opened);
    const app=createApp({config:{baseUrl:"https://a",relayUrl:"https://r",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false},db,clock:{now:()=>1},ids:{message:()=>"m",incident:()=>"i",timer:()=>"t"},dispatch:async()=>{}});const headers={Authorization:"Bearer dv_a"};
    const ids=async (path:string)=>((await (await app.request(path,{headers})).json()) as {id:string}[]).map(value=>value.id);
    expect(await ids("/v1/incidents?state=open")).toEqual(["inc_open","inc_stage"]);
    expect(await ids("/v1/incidents?topic=prod")).toEqual(["inc_open","inc_closed"]);
    expect(await ids("/v1/incidents?limit=2")).toEqual(["inc_open","inc_acked"]);
  });
});
