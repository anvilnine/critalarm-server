import { ParseError, parseJsonPublish } from "../ingress/headers.js";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { DEFAULT_INCIDENT_LIMIT, IncidentConflictError, IncidentService, MAX_INCIDENT_LIMIT } from "../incident/service.js";
import type { Clock, DeliveryEvent, IdGenerator, IncidentWithMessages } from "../incident/types.js";
import { historyCutoff } from "../retention/window.js";
import type { DispatchResult } from "../domain-events.js";
import { PublishService } from "../ingress/service.js";
import type { TopicRecord } from "../ingress/types.js";
import { requireDevice, type V1Env } from "./auth.js";
import { mountAccountRoutes } from "./accounts.js";
import { sessionIdentityResolver, type IdentityResolver } from "../auth/identity.js";
import { providerTokenRevoker, type TokenRevoker } from "../auth/revoke.js";
import { addToken, createTopic, deleteToken, deleteTopic, listTokens, listTopics, ownedTopic, patchTopic, renameToken, view } from "./topics.js";
import { version } from "../version.js";
type Deps={db:Database.Database;config:Config;clock:Clock;ids:IdGenerator;incidents:IncidentService;dispatch(events:readonly DeliveryEvent[]):Promise<DispatchResult|void>;identities?:IdentityResolver;revoke?:TokenRevoker;reconcileAccount?:(accountId:string)=>void};
function incidentView(i:IncidentWithMessages){return {id:i.id,topic:i.topic,state:i.state,opened_at:i.openedAt,acked_at:i.ackedAt,closed_at:i.closedAt,last_message_at:i.lastMessageAt,updated_at:i.updatedAt,messages:i.messages.map(m=>({id:m.id,time:m.createdAt,expires:m.createdAt+43200,event:"message",topic:i.topic,title:m.title,message:m.body,priority:m.priority,tags:m.tags,...(m.click===null?{}:{click:m.click}),...(m.markdown?{markdown:true}:{}),...(m.incidentId===null?{}:{incident_id:m.incidentId})}))};}
function publishTopic(db:Database.Database,account:string,name:string):TopicRecord|undefined{return db.prepare("SELECT id, account_id AS accountId, name, base_url AS baseUrl, topic_hash AS topicHash, critical, repeat_interval_s AS repeatIntervalS, max_ring_s AS maxRingS, desk_timer_s AS deskTimerS, relay_content AS relayContent FROM topics WHERE account_id=? AND name=?").get(account,name) as TopicRecord|undefined;}
export function createV1Router(deps:Deps){const r=new Hono<V1Env>();const auth=requireDevice(deps.db,deps.config.mode ?? "hosted");const service=new PublishService({...deps,incidents:deps.incidents});r.get("/v1/info",c=>c.json({name:"critalarm",version,base_url:deps.config.baseUrl,relay_url:deps.config.relayUrl,relay_content:deps.config.relayContent,mode:deps.config.mode ?? "hosted"}));r.use("/v1/topics*",auth);r.use("/v1/incidents*",auth);r.use("/v1/test",auth);
  // api.md §3.7. These live in the v1 router, which is mounted in every mode,
  // because selfhosted has to answer 501 rather than the 404 an unmounted
  // router produces.
  mountAccountRoutes(r, auth, { db: deps.db, clock: deps.clock, identities: deps.identities ?? sessionIdentityResolver(deps.db, deps.clock), revoke: deps.revoke ?? providerTokenRevoker(deps.db, deps.config.auth, deps.clock), mode: deps.config.mode ?? "hosted", ...(deps.reconcileAccount === undefined ? {} : { reconcileAccount: deps.reconcileAccount }) });
  r.get("/v1/topics",c=>c.json(listTopics(deps.db,c.get("account").accountId)));
  r.post("/v1/topics",async c=>{let b:unknown;try{b=await c.req.json()}catch{return c.json({error:"invalid request"},400)}const t=createTopic(deps.db,deps.config,deps.clock,c.get("account").accountId,typeof b==="object"&&b!==null&&typeof (b as {name?:unknown}).name==="string"?(b as {name:string}).name:"",typeof b==="object"&&b!==null&&(b as {critical?:unknown}).critical===true,typeof b==="object"&&b!==null?(b as {token_name?:unknown}).token_name:undefined);if(t==="duplicate")return c.json({code:40901,http:409,error:"topic already exists"},409);if(t==="cap")return c.json({error:"cap",cap:"critical_topics"},429);return t===null?c.json({error:"invalid request"},400):c.json(t,201)});
  r.get("/v1/topics/:name/tokens",c=>{const t=listTokens(deps.db,c.get("account").accountId,c.req.param("name"));return t===undefined?c.json({error:"not found"},404):c.json(t)});
  // The body is optional here, so an absent or unreadable one is read as "no
  // name given" rather than a 400.
  r.post("/v1/topics/:name/tokens",async c=>{let b:unknown;try{b=await c.req.json()}catch{b=undefined}const t=addToken(deps.db,deps.clock,c.get("account").accountId,c.req.param("name"),typeof b==="object"&&b!==null?(b as {name?:unknown}).name:undefined);return t===undefined?c.json({error:"not found"},404):c.json(t,201)});
  r.patch("/v1/topics/:name/tokens/:tokenId",async c=>{let b:unknown;try{b=await c.req.json()}catch{return c.json({error:"invalid request"},400)}const n=typeof b==="object"&&b!==null?(b as {name?:unknown}).name:undefined;if(typeof n!=="string"||n.trim()==="")return c.json({error:"invalid request"},400);const t=renameToken(deps.db,c.get("account").accountId,c.req.param("name"),c.req.param("tokenId"),n);return t===undefined?c.json({error:"not found"},404):c.json(t)});
  r.delete("/v1/topics/:name/tokens/:tokenId",c=>{const result=deleteToken(deps.db,c.get("account").accountId,c.req.param("name"),c.req.param("tokenId"));return result==="deleted"?c.body(null,204):result==="final"?c.json({error:"topic must retain a token"},409):c.json({error:"not found"},404)});
  r.patch("/v1/topics/:name",async c=>{let b:unknown;try{b=await c.req.json()}catch{return c.json({error:"invalid request"},400)}const t=typeof b==="object"&&b!==null?patchTopic(deps.db,deps.config,c.get("account").accountId,c.req.param("name"),b as Record<string,unknown>):undefined;if(t==="cap")return c.json({error:"cap",cap:"critical_topics"},429);return t===undefined?c.json({error:"not found"},404):c.json(view(t))});r.delete("/v1/topics/:name",c=>deleteTopic(deps.db,c.get("account").accountId,c.req.param("name"))?c.body(null,204):c.json({error:"not found"},404));
  r.get("/v1/incidents",c=>{const limit=c.req.query("limit");const state=c.req.query("state");const since=c.req.query("since");if(limit!==undefined&&(!/^\d+$/.test(limit)||Number(limit)<1))return c.json({error:"invalid request"},400);if(state!==undefined&&!["open","acked","closed","expired"].includes(state))return c.json({error:"invalid request"},400);
    // api.md §3.2. Only a whole number of seconds. No message id, no duration
    // and no "all": those belong to the poll route, not here.
    if(since!==undefined&&!/^\d+$/.test(since))return c.json({error:"invalid request"},400);
    const accountId=c.get("account").accountId;
    const cutoff=historyCutoff(deps.db,deps.clock,deps.config.mode ?? "hosted",accountId);
    return c.json(deps.incidents.list(accountId,{limit:limit===undefined?DEFAULT_INCIDENT_LIMIT:Math.min(Number(limit),MAX_INCIDENT_LIMIT),state:state as "open"|"acked"|"closed"|"expired"|undefined,topic:c.req.query("topic"),...(since===undefined?{}:{since:Number(since)}),...(cutoff===undefined?{}:{openedAfter:cutoff})}).map(incidentView))});
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
