import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { Clock } from "../incident/types.js";
import { capsFor } from "../tier/caps.js";
import { sweepTopicIntoDevices } from "../tier/subscriptions.js";
import type { Tier } from "../tier/types.js";
const namePattern=/^[-_A-Za-z0-9]{1,64}$/;
// api.md §3.1. A token name is trimmed and then cut to 40 characters, so a long
// one is shortened rather than refused. A name that is empty after trimming
// counts as missing, and a missing name becomes Token N, where N is the topic's
// current token count plus one.
function chooseTokenName(input:unknown,count:number){const trimmed=typeof input==="string"?input.trim().slice(0,40):"";return trimmed===""?`Token ${count+1}`:trimmed;}
type Row={id:string;name:string;critical:number;repeat_interval_s:number;max_ring_s:number;desk_timer_s:number;relay_content:"none"|"full";created_at:number};
function view(row:Row){return {name:row.name,critical:row.critical===1,repeat_interval_s:row.repeat_interval_s,max_ring_s:row.max_ring_s,desk_timer_s:row.desk_timer_s,relay_content:row.relay_content,created_at:row.created_at};}
export function listTopics(db:Database.Database,accountId:string){return (db.prepare("SELECT id,name,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at FROM topics WHERE account_id=? ORDER BY created_at,name").all(accountId) as Row[]).map(view);}
function criticalCapReached(db: Database.Database, config: Config, accountId: string): boolean {
  if (config.mode === "selfhosted") return false;
  const account = db.prepare("SELECT tier FROM accounts WHERE id=?").get(accountId) as { tier: Tier };
  const limit = capsFor(account.tier).critical_topics;
  if (limit === null) return false;
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM topics WHERE account_id=? AND critical=1").get(accountId) as { count: number };
  return count >= limit;
}
export function createTopic(db: Database.Database, config: Config, clock: Clock, accountId: string, name: string, critical = false, tokenName?: unknown) {
  if (!namePattern.test(name)) return null;
  return db.transaction(() => {
    if (ownedTopic(db, accountId, name) !== undefined) return "duplicate" as const;
    if (critical && criticalCapReached(db, config, accountId)) return "cap" as const;
    const token = `tk_${randomUUID().replaceAll("-", "")}`;
    const tokenId = `tok_${randomUUID()}`;
    const id = `top_${randomUUID()}`;
    const now = clock.now();
    const topicHash = createHash("sha256").update(`${config.baseUrl}/${name}`).digest("hex");
    db.prepare("INSERT INTO topics (id,account_id,name,base_url,topic_hash,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at) VALUES (?,?,?,?,?,?,30,1800,600,?,?)").run(id,accountId,name,config.baseUrl,topicHash,critical ? 1 : 0,config.relayContent,now);
    // A brand new topic holds no tokens yet, so an unnamed first token is
    // always Token 1.
    const chosen = chooseTokenName(tokenName, 0);
    db.prepare("INSERT INTO topic_tokens (id,topic_id,hash,name,created_at) VALUES (?,?,?,?,?)").run(tokenId,id,createHash("sha256").update(token).digest("hex"),chosen,now);
    sweepTopicIntoDevices(db, accountId, topicHash);
    return {...view(ownedTopic(db, accountId, name)!), token, token_id: tokenId, token_name: chosen};
  })();
}
export function ownedTopic(db:Database.Database,accountId:string,name:string){return db.prepare("SELECT id,name,critical,repeat_interval_s,max_ring_s,desk_timer_s,relay_content,created_at FROM topics WHERE account_id=? AND name=?").get(accountId,name) as Row|undefined;}
export function patchTopic(db: Database.Database, config: Config, accountId: string, name: string, input: Record<string, unknown>) {
  return db.transaction(() => {
    const topic = ownedTopic(db, accountId, name); if (topic === undefined) return undefined;
    if (input.critical === true && topic.critical === 0 && criticalCapReached(db, config, accountId)) return "cap" as const;
    const fields: [string, number][] = [];
    if (typeof input.critical === "boolean") fields.push(["critical", input.critical ? 1 : 0]);
    for (const key of ["repeat_interval_s", "max_ring_s", "desk_timer_s"] as const) if (typeof input[key] === "number" && Number.isInteger(input[key]) && input[key] > 0) fields.push([key, input[key]]);
    if (fields.length > 0) db.prepare(`UPDATE topics SET ${fields.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...fields.map(([, value]) => value), topic.id);
    return ownedTopic(db, accountId, name)!;
  })();
}
// Oldest first, as api.md §3.1 says. Two tokens made in the same second tie
// on created_at, and a token id is a random UUID, so ordering by it would
// hand back a different order each call. rowid is insertion order.
export function listTokens(db: Database.Database, accountId: string, name: string) { const topic=ownedTopic(db,accountId,name); if(topic===undefined)return undefined; return db.prepare("SELECT id AS token_id, name, created_at FROM topic_tokens WHERE topic_id=? ORDER BY created_at, rowid").all(topic.id) as {token_id:string;name:string;created_at:number}[]; }
export function addToken(db: Database.Database, clock: Clock, accountId: string, name: string, tokenName?: unknown) { const topic = ownedTopic(db, accountId, name); if (topic === undefined) return undefined; const token = `tk_${randomUUID().replaceAll("-", "")}`; const tokenId=`tok_${randomUUID()}`; const count=(db.prepare("SELECT COUNT(*) AS count FROM topic_tokens WHERE topic_id=?").get(topic.id) as {count:number}).count; const chosen=chooseTokenName(tokenName,count); db.prepare("INSERT INTO topic_tokens (id,topic_id,hash,name,created_at) VALUES (?,?,?,?,?)").run(tokenId,topic.id,createHash("sha256").update(token).digest("hex"),chosen,clock.now()); return { token, token_id: tokenId, name: chosen }; }
// The route rejects a missing or blank name with a 400 before this runs, so the
// Token N fallback never fires here; the name still goes through the same trim
// and cut as a new token.
export function renameToken(db: Database.Database, accountId: string, topicName: string, tokenId: string, name: string) { const topic=ownedTopic(db,accountId,topicName); if(topic===undefined)return undefined; if(db.prepare("UPDATE topic_tokens SET name=? WHERE topic_id=? AND id=?").run(chooseTokenName(name,0),topic.id,tokenId).changes===0)return undefined; return db.prepare("SELECT id AS token_id, name, created_at FROM topic_tokens WHERE id=?").get(tokenId) as {token_id:string;name:string;created_at:number}; }
export function deleteToken(db: Database.Database, accountId: string, name: string, tokenId: string): "deleted" | "final" | "missing" { const topic=ownedTopic(db,accountId,name); if(topic===undefined)return "missing"; return db.transaction(()=>{const row=db.prepare("SELECT id FROM topic_tokens WHERE topic_id=? AND id=?").get(topic.id,tokenId);if(row===undefined)return "missing";const count=(db.prepare("SELECT COUNT(*) AS count FROM topic_tokens WHERE topic_id=?").get(topic.id) as {count:number}).count;if(count===1)return "final";db.prepare("DELETE FROM topic_tokens WHERE id=?").run(tokenId);return "deleted";})(); }
// subscriptions has no foreign key to topics, so its rows outlive the topic
// unless they go in the same transaction.
export function deleteTopic(db: Database.Database, accountId: string, name: string) { return db.transaction(()=>{const topic=db.prepare("SELECT id,topic_hash FROM topics WHERE account_id=? AND name=?").get(accountId,name) as {id:string;topic_hash:string}|undefined;if(topic===undefined)return false;db.prepare("DELETE FROM subscriptions WHERE topic_hash=? AND device_id IN (SELECT id FROM devices WHERE account_id=?)").run(topic.topic_hash,accountId);db.prepare("DELETE FROM topics WHERE id=?").run(topic.id);return true;})(); }
export { view };
