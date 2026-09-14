import { ParseError, parseJsonPublish } from "../ingress/headers.js";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { IncidentConflictError, IncidentService } from "../incident/service.js";
import type { Clock, DeliveryEvent, IdGenerator, IncidentWithMessages } from "../incident/types.js";
import type { DispatchResult } from "../domain-events.js";
import { PublishService } from "../ingress/service.js";
import type { TopicRecord } from "../ingress/types.js";
import { requireDevice, type V1Env } from "./auth.js";
import { addToken, createTopic, deleteToken, deleteTopic, listTopics, ownedTopic, patchTopic, view } from "./topics.js";
type Deps={db:Database.Database;config:Config;clock:Clock;ids:IdGenerator;incidents:IncidentService;dispatch(events:readonly DeliveryEvent[]):Promise<DispatchResult|void>};
function incidentView(i:IncidentWithMessages){return {id:i.id,topic:i.topic,state:i.state,opened_at:i.openedAt,acked_at:i.ackedAt,closed_at:i.closedAt,last_message_at:i.lastMessageAt,messages:i.messages.map(m=>({id:m.id,time:m.createdAt,expires:m.createdAt+43200,event:"message",topic:i.topic,title:m.title,message:m.body,priority:m.priority,tags:m.tags,...(m.click===null?{}:{click:m.click}),...(m.markdown?{markdown:true}:{}),...(m.incidentId===null?{}:{incident_id:m.incidentId})}))};}
function publishTopic(db:Database.Database,account:string,name:string):TopicRecord|undefined{return db.prepare("SELECT id, account_id AS accountId, name, base_url AS baseUrl, topic_hash AS topicHash, critical, repeat_interval_s AS repeatIntervalS, max_ring_s AS maxRingS, desk_timer_s AS deskTimerS, relay_content AS relayContent FROM topics WHERE account_id=? AND name=?").get(account,name) as TopicRecord|undefined;}
export function createV1Router(deps:Deps){const r=new Hono<V1Env>();const auth=requireDevice(deps.db,deps.config.mode ?? "hosted");const service=new PublishService({...deps,incidents:deps.incidents});r.get("/v1/info",c=>c.json({name:"critalarm",version:"0.1.0",base_url:deps.config.baseUrl,relay_url:deps.config.relayUrl,relay_content:deps.config.relayContent,mode:deps.config.mode ?? "hosted"}));r.use("/v1/topics*",auth);r.use("/v1/incidents*",auth);r.use("/v1/test",auth);
  r.get("/v1/topics",c=>c.json(listTopics(deps.db,c.get("account").accountId)));
  r.post("/v1/topics",async c=>{let b:unknown;try{b=await c.req.json()}catch{return c.json({error:"invalid request"},400)}const t=createTopic(deps.db,deps.config,deps.clock,c.get("account").accountId,typeof b==="object"&&b!==null&&typeof (b as {name?:unknown}).name==="string"?(b as {name:string}).name:"");return t===null?c.json({error:"invalid request"},400):c.json(t,201)});
  r.post("/v1/topics/:name/tokens",c=>{const t=addToken(deps.db,deps.clock,c.get("account").accountId,c.req.param("name"));return t===undefined?c.json({error:"not found"},404):c.json(t,201)});
  r.delete("/v1/topics/:name/tokens/:tokenId",c=>{const result=deleteToken(deps.db,c.get("account").accountId,c.req.param("name"),c.req.param("tokenId"));return result==="deleted"?c.body(null,204):result==="final"?c.json({error:"topic must retain a token"},409):c.json({error:"not found"},404)});
  r.patch("/v1/topics/:name",async c=>{let b:unknown;try{b=await c.req.json()}catch{return c.json({error:"invalid request"},400)}const t=typeof b==="object"&&b!==null?patchTopic(deps.db,c.get("account").accountId,c.req.param("name"),b as Record<string,unknown>):undefined;return t===undefined?c.json({error:"not found"},404):c.json(view(t))});r.delete("/v1/topics/:name",c=>deleteTopic(deps.db,c.get("account").accountId,c.req.param("name"))?c.body(null,204):c.json({error:"not found"},404));
  r.get("/v1/incidents",c=>{const limit=c.req.query("limit");const state=c.req.query("state");if(limit!==undefined&&(!/^\d+$/.test(limit)||Number(limit)<1))return c.json({error:"invalid request"},400);if(state!==undefined&&!["open","acked","closed","expired"].includes(state))return c.json({error:"invalid request"},400);return c.json(deps.incidents.list(c.get("account").accountId,{limit:limit===undefined?20:Number(limit),state:state as "open"|"acked"|"closed"|"expired"|undefined,topic:c.req.query("topic")}).map(incidentView))});
  r.get("/v1/incidents/:id",c=>{const i=deps.incidents.get(c.get("account").accountId,c.req.param("id"));return i===null?c.json({error:"not found"},404):c.json(incidentView(i))});
  r.post("/v1/incidents/:id/ack",async c=>{try{const {incident:i,events}=deps.incidents.acknowledge(c.get("account").accountId,c.req.param("id"));const timer=deps.db.prepare("SELECT fire_at FROM timers WHERE incident_id=? AND kind='desk'").get(i.id) as {fire_at:number};await deps.dispatch(events);return c.json({...incidentView(deps.incidents.get(c.get("account").accountId,i.id)!),desk_timer_fires_at:timer.fire_at})}catch(e){return e instanceof IncidentConflictError?c.json({error:"incident state conflict"},409):c.json({error:"not found"},404)}});
  r.post("/v1/incidents/:id/close",async c=>{try{const {incident:i,events}=deps.incidents.close(c.get("account").accountId,c.req.param("id"));await deps.dispatch(events);return c.json(incidentView(deps.incidents.get(c.get("account").accountId,i.id)!))}catch(e){return e instanceof IncidentConflictError?c.json({error:"incident state conflict"},409):c.json({error:"not found"},404)}});
  r.post("/v1/topics/:name/send", async c => {
    const topic = publishTopic(deps.db, c.get("account").accountId, c.req.param("name"));
    if (topic === undefined) return c.json({ error: "not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid request" }, 400); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid request" }, 400);
    const fields = body as Record<string, unknown>;
    if (typeof fields.message !== "string") return c.json({ error: "message is required" }, 400);
    if (Buffer.byteLength(fields.message) > 4096) return c.json({ code: 41301, http: 413, error: "message too large" }, 413);
    try {
      const input = parseJsonPublish({ topic: topic.name, message: fields.message, title: fields.title, priority: fields.priority, tags: fields.tags });
      const result = await service.publish(topic, input);
      return c.json({ id: result.id, incident_id: result.incident_id ?? null });
    } catch (error: unknown) {
      if (error instanceof ParseError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
  r.post("/v1/test",async c=>{const topic=publishTopic(deps.db,c.get("account").accountId,c.req.query("topic")??"");if(topic===undefined)return c.json({error:"not found"},404);if(!topic.critical)return c.json({error:"topic is not critical"},409);const result=await service.publish(topic,{topic:topic.name,message:"triggered",title:"Crit Alarm test",priority:5,tags:[],markdown:false});return c.json({incident_id:result.incident_id!})});return r;}
