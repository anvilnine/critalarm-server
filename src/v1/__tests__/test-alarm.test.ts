import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import { migrate } from "../../store/migrations.js";
import { openDatabase } from "../../store/database.js";

describe("test alarm", () => {
  it("uses the normal critical publish path and rejects a noncritical topic", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    for (const [id,name,critical] of [["t1","prod",1],["t2","quiet",0]]) db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES (?, 'a', ?, 'https://alerts.example.com', ?, ?,30,1800,600,'none',1)").run(id,name,`hash-${name}`,critical);
    let timer = 0; const app = createApp({ config:{baseUrl:"https://alerts.example.com",relayUrl:"https://relay.critalarm.app",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false},db,clock:{now:()=>1000},ids:{message:()=>"m",incident:()=>"inc",timer:()=>`tm_${++timer}`},dispatch:async()=>{} });
    expect(await (await app.request("/v1/test?topic=prod",{method:"POST",headers:{Authorization:"Bearer dv_a"}})).json()).toEqual({incident_id:"inc"});
    const rejected=await app.request("/v1/test?topic=quiet",{method:"POST",headers:{Authorization:"Bearer dv_a"}}); expect(rejected.status).toBe(409); expect(await rejected.json()).toEqual({error:"topic is not critical"});
  });
});
