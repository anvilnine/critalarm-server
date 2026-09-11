import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { Clock } from "../incident/types.js";
const namePattern=/^[-_A-Za-z0-9]{1,64}$/;
type Row={id:string;name:string;critical:number;repeat_interval_s:number;max_ring_s:number;desk_timer_s:number;relay_content:"none";created_at:number};
function view(row:Row){return {name:row.name,critical:row.critical===1,repeat_interval_s:row.repeat_interval_s,max_ring_s:row.max_ring_s,desk_timer_s:row.desk_timer_s,relay_content:row.relay_content,created_at:row.created_at};}
export function listTopics(db:Database.Database,accountId:string){return (db.prepare("SELECT id,name,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at FROM topics WHERE account_id=? ORDER BY created_at,name").all(accountId) as Row[]).map(view);}
export function createTopic(db:Database.Database,config:Config,clock:Clock,accountId:string,name:string){if(!namePattern.test(name))return null;const token=`tk_${randomUUID().replaceAll("-","")}`;const row=db.transaction(()=>{const id=`top_${randomUUID()}`;const now=clock.now();db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES (?,?,?,?,?,0,30,1800,600,'none',?)").run(id,accountId,name,config.baseUrl,createHash("sha256").update(`${config.baseUrl}/${name}`).digest("hex"),now);db.prepare("INSERT INTO topic_tokens (id,topic_id,hash,created_at) VALUES (?,?,?,?)").run(`tok_${randomUUID()}`,id,createHash("sha256").update(token).digest("hex"),now);return db.prepare("SELECT id,name,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at FROM topics WHERE id=?").get(id) as Row;})();return {...view(row),token};}
export function ownedTopic(db:Database.Database,accountId:string,name:string){return db.prepare("SELECT id,name,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at FROM topics WHERE account_id=? AND name=?").get(accountId,name) as Row|undefined;}
export function patchTopic(db: Database.Database, accountId: string, name: string, input: Record<string, unknown>) {
  const topic = ownedTopic(db, accountId, name); if (topic === undefined) return undefined;
  const fields: [string, number][] = [];
  if (typeof input.critical === "boolean") fields.push(["critical", input.critical ? 1 : 0]);
  for (const key of ["repeat_interval_s", "max_ring_s", "desk_timer_s"] as const) if (typeof input[key] === "number" && Number.isInteger(input[key]) && input[key] > 0) fields.push([key, input[key]]);
  if (fields.length > 0) db.prepare(`UPDATE topics SET ${fields.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...fields.map(([, value]) => value), topic.id);
  return ownedTopic(db, accountId, name)!;
}
export function addToken(db: Database.Database, clock: Clock, accountId: string, name: string) { const topic = ownedTopic(db, accountId, name); if (topic === undefined) return undefined; const token = `tk_${randomUUID().replaceAll("-", "")}`; const tokenId=`tok_${randomUUID()}`; db.prepare("INSERT INTO topic_tokens (id,topic_id,hash,created_at) VALUES (?,?,?,?)").run(tokenId,topic.id,createHash("sha256").update(token).digest("hex"),clock.now()); return { token, token_id: tokenId }; }
export function deleteToken(db: Database.Database, accountId: string, name: string, tokenId: string): "deleted" | "final" | "missing" { const topic=ownedTopic(db,accountId,name); if(topic===undefined)return "missing"; return db.transaction(()=>{const row=db.prepare("SELECT id FROM topic_tokens WHERE topic_id=? AND id=?").get(topic.id,tokenId);if(row===undefined)return "missing";const count=(db.prepare("SELECT COUNT(*) AS count FROM topic_tokens WHERE topic_id=?").get(topic.id) as {count:number}).count;if(count===1)return "final";db.prepare("DELETE FROM topic_tokens WHERE id=?").run(tokenId);return "deleted";})(); }
export function deleteTopic(db: Database.Database, accountId: string, name: string) { return db.prepare("DELETE FROM topics WHERE account_id=? AND name=?").run(accountId,name).changes>0; }
export { view };
