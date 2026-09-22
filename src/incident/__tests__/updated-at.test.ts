import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { IncidentService } from "../service.js";
import { createApp } from "../../index.js";
import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../types.js";

class FakeClock implements Clock {
  constructor(public value: number) {}
  now(): number { return this.value; }
}
class FixedIds implements IdGenerator {
  private n = 0; private inc = 0; private tm = 0;
  message(): string { this.n+=1; return `m_${this.n}`; }
  incident(): string { this.inc+=1; return `inc_${this.inc}`; }
  timer(): string { this.tm+=1; return `tm_${this.tm}`; }
}
function setupApp(clock: FakeClock, db: ReturnType<typeof openDatabase>) {
  return createApp({config:{baseUrl:"https://a",relayUrl:"https://r",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false,mode:"hosted"},db,clock,ids:{message:()=>"m",incident:()=>"i",timer:()=>"t"},dispatch:async()=>{}});
}
function publication() {
  return { topicId:"top_1", topicHash:"h", topic:"prod", baseUrl:"https://a", repeatIntervalS:30, maxRingS:60, deskTimerS:30, message:{title:"t",body:"b",priority:5 as const,tags:[],click:null,markdown:false}};
}

describe("updated_at and since filter", () => {
  it("acks an incident opened at T1 at T3, returned for since=T2 and not for since=T3", async () => {
    const clock = new FakeClock(1000);
    const db = openDatabase(":memory:"); migrate(db);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','a','prod','https://a','h',1,30,60,30,'none',1)").run();
    const svc = new IncidentService(db, clock, new FixedIds());
    clock.value = 1000;
    const opened = svc.publishCritical(publication());
    clock.value = 3000;
    svc.acknowledge("a", opened.incident.id);
    const app = setupApp(clock, db);
    const headers={Authorization:"Bearer dv_a"};
    const ids = async (path:string)=>((await (await app.request(path,{headers})).json()) as {id:string}[]).map(v=>v.id);
    expect(await ids("/v1/incidents?since=2000")).toContain("inc_1");
    expect(await ids("/v1/incidents?since=3000")).not.toContain("inc_1");
  });

  it("does not return an incident with no change since since", async () => {
    const clock = new FakeClock(1000);
    const db = openDatabase(":memory:"); migrate(db);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','a','prod','https://a','h',1,30,60,30,'none',1)").run();
    const svc = new IncidentService(db, clock, new FixedIds());
    clock.value = 1000;
    svc.publishCritical(publication());
    clock.value = 2000;
    const app = setupApp(clock, db);
    expect(((await (await app.request("/v1/incidents?since=1500",{headers:{Authorization:"Bearer dv_a"}})).json()) as unknown[])).toHaveLength(0);
  });

  it("a new message moves updated_at and makes it show for since", async () => {
    const clock = new FakeClock(1000);
    const db = openDatabase(":memory:"); migrate(db);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','a','prod','https://a','h',1,30,60,30,'none',1)").run();
    const svc = new IncidentService(db, clock, new FixedIds());
    clock.value = 1000;
    svc.publishCritical(publication());
    clock.value = 2000;
    svc.publishCritical(publication());
    const app = setupApp(clock, db);
    const ids = async (path:string)=>((await (await app.request(path,{headers:{Authorization:"Bearer dv_a"}})).json()) as {id:string}[]).map(v=>v.id);
    expect(await ids("/v1/incidents?since=1500")).toContain("inc_1");
    expect(await ids("/v1/incidents?since=2000")).toHaveLength(0);
  });

  it("retention cutoff still hides a row opened before the window even when acked inside", async () => {
    const day = 86400;
    const now = 100*day;
    const clock = new FakeClock(now);
    const db = openDatabase(":memory:"); migrate(db);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','a','prod','https://a','h',1,30,60,30,'none',1)").run();
    const svc = new IncidentService(db, {now:()=> now-8*day}, new FixedIds());
    svc.publishCritical(publication());
    clock.value = now;
    svc.acknowledge("a","inc_1");
    // updated_at is now inside window, but opened_at is 8 days ago, outside free 7d window
    const app = setupApp(clock, db);
    expect(((await (await app.request("/v1/incidents",{headers:{Authorization:"Bearer dv_a"}})).json()) as unknown[])).toHaveLength(0);
    expect(((await (await app.request("/v1/incidents?since="+(now-2*day),{headers:{Authorization:"Bearer dv_a"}})).json()) as unknown[])).toHaveLength(0);
  });

  it("updated_at is present on every incident in list and single responses", async () => {
    const clock = new FakeClock(1000);
    const db = openDatabase(":memory:"); migrate(db);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_a").digest("hex"));
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('top_1','a','prod','https://a','h',1,30,60,30,'none',1)").run();
    const svc = new IncidentService(db, clock, new FixedIds());
    svc.publishCritical(publication());
    const app = setupApp(clock, db);
    const list = await (await app.request("/v1/incidents",{headers:{Authorization:"Bearer dv_a"}})).json() as {updated_at:number}[];
    expect(list.every(r=> typeof r.updated_at==="number")).toBe(true);
    const single = await (await app.request("/v1/incidents/inc_1",{headers:{Authorization:"Bearer dv_a"}})).json() as {updated_at:number};
    expect(typeof single.updated_at).toBe("number");
  });

  it("migration backfills updated_at as COALESCE", async () => {
    const db = openDatabase(":memory:"); migrate(db, 17);
    db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('t','a','prod','https://a','h',1,30,60,30,'none',1)").run();
    db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,acked_at,closed_at,last_message_at,max_ring_s) VALUES ('inc_closed','t','closed',100,200,300,150,60)").run();
    db.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,last_message_at,max_ring_s) VALUES ('inc_open','t','open',400,400,60)").run();
    migrate(db);
    expect(db.prepare("SELECT updated_at FROM incidents WHERE id='inc_closed'").get()).toEqual({updated_at:300});
    expect(db.prepare("SELECT updated_at FROM incidents WHERE id='inc_open'").get()).toEqual({updated_at:400});
    // acked but not closed
    const db2 = openDatabase(":memory:"); migrate(db2, 17);
    db2.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run();
    db2.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES ('t','a','prod','https://a','h',1,30,60,30,'none',1)").run();
    db2.prepare("INSERT INTO incidents (id,topic_id,state,opened_at,acked_at,last_message_at,max_ring_s) VALUES ('inc_acked','t','acked',100,250,220,60)").run();
    migrate(db2);
    expect(db2.prepare("SELECT updated_at FROM incidents WHERE id='inc_acked'").get()).toEqual({updated_at:250});
  });
});
