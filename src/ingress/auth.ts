import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { TopicRecord } from "./types.js";

type TopicRow = {
  id: string;
  account_id: string;
  name: string;
  base_url: string;
  topic_hash: string;
  critical: number;
  repeat_interval_s: number;
  max_ring_s: number;
  desk_timer_s: number;
  relay_content: "none" | "full";
};

function tokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    return decoded.split(":").slice(1).join(":") || null;
  }
  const auth = new URL(request.url).searchParams.get("auth");
  if (auth === null) return null;
  const decoded = Buffer.from(auth, "base64").toString("utf8");
  return decoded.startsWith("Bearer ") ? decoded.slice("Bearer ".length) : null;
}

function topicRecord(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    baseUrl: row.base_url,
    topicHash: row.topic_hash,
    critical: row.critical === 1,
    repeatIntervalS: row.repeat_interval_s,
    maxRingS: row.max_ring_s,
    deskTimerS: row.desk_timer_s,
    relayContent: row.relay_content,
  };
}

export function authenticateTopic(db: Database.Database, request: Request, name: string): TopicRecord | null {
  const token = tokenFromRequest(request);
  if (token === null) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const row = db
    .prepare(
      `SELECT t.id, t.account_id, t.name, t.base_url, t.topic_hash, t.critical, t.repeat_interval_s, t.max_ring_s, t.desk_timer_s, t.relay_content
       FROM topic_tokens tt JOIN topics t ON t.id = tt.topic_id
       WHERE tt.hash = ? AND t.name = ?`,
    )
    .get(hash, name) as TopicRow | undefined;
  return row === undefined ? null : topicRecord(row);
}
