import { Hono } from "hono";
import type { Context } from "hono";
import { makeRateLimiter } from "../rate-limit.js";
import { authenticateTopic } from "./auth.js";
import { ParseError, parseJsonPublish, parsePublishRequest, rejectDelayHeaders } from "./headers.js";
import { PublishService } from "./service.js";
import type { IngressDependencies } from "./types.js";

const validTopic = /^[-_A-Za-z0-9]{1,64}$/;
type IngressEnv = {
  Bindings: { ALLOWED_ORIGINS: string; PORT?: string };
  Variables: Record<string, never>;
};

function numericError(code: number, http: number, error: string): { code: number; http: number; error: string } {
  return { code, http, error };
}

function parseError(c: { json: (value: unknown, status: 400 | 413) => Response }, error: ParseError): Response {
  if (error.status === 413) return c.json(numericError(41301, 413, error.message), 413);
  return c.json({ error: error.message }, 400);
}

async function jsonValue(request: Request): Promise<unknown> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 4096) throw new ParseError(413, "message too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ParseError(400, "invalid JSON");
  }
}

type PollMessageRow = {
  sequence: number;
  id: string;
  incident_id: string | null;
  title: string;
  body: string;
  priority: number;
  tags: string;
  click: string | null;
  markdown: number;
  created_at: number;
};

function pollSince(value: string | undefined, now: number): { timestamp: number; inclusive: boolean } | "all" | { messageId: string } {
  if (value === undefined) return { timestamp: now - 43_200, inclusive: true };
  if (value === "all") return "all";
  if (/^\d+$/.test(value)) return { timestamp: Number(value), inclusive: false };
  const duration = /^(\d+)([smhd])$/.exec(value);
  if (duration !== null) {
    const unit = { s: 1, m: 60, h: 3_600, d: 86_400 }[duration[2] as "s" | "m" | "h" | "d"];
    return { timestamp: now - Number(duration[1]) * unit, inclusive: true };
  }
  return { messageId: value };
}

export function createIngressRouter(deps: IngressDependencies): Hono<IngressEnv> {
  const router = new Hono<IngressEnv>();
  const service = new PublishService(deps);
  const publishLimit = makeRateLimiter(
    (c) => c.json(numericError(42901, 429, "rate limited"), 429),
    deps.publishLimit ?? 30,
    deps.behindProxy ?? false,
  );

  const publish = async (c: Context<IngressEnv, "/:topic">) => {
    const name = c.req.param("topic");
    if (!validTopic.test(name)) return c.json(numericError(40001, 400, "invalid topic name"), 400);
    const topic = authenticateTopic(deps.db, c.req.raw, name);
    if (topic === null) return c.json(numericError(40101, 401, "unauthorized"), 401);
    try {
      return c.json(await service.publish(topic, { topic: name, ...await parsePublishRequest(c.req.raw) }));
    } catch (error: unknown) {
      if (error instanceof ParseError) return parseError(c, error);
      throw error;
    }
  };

  router.post("/", publishLimit, async (c) => {
    try {
      rejectDelayHeaders(c.req.raw.headers);
      const input = parseJsonPublish(await jsonValue(c.req.raw));
      if (!validTopic.test(input.topic)) return c.json(numericError(40001, 400, "invalid topic name"), 400);
      const topic = authenticateTopic(deps.db, c.req.raw, input.topic);
      if (topic === null) return c.json(numericError(40101, 401, "unauthorized"), 401);
      return c.json(await service.publish(topic, input));
    } catch (error: unknown) {
      if (error instanceof ParseError) return parseError(c, error);
      throw error;
    }
  });
  router.post("/:topic", publishLimit, publish);
  router.put("/:topic", publishLimit, publish);

  router.get("/:topic/json", (c) => {
    const name = c.req.param("topic");
    if (!validTopic.test(name)) return c.json(numericError(40001, 400, "invalid topic name"), 400);
    const topic = authenticateTopic(deps.db, c.req.raw, name);
    if (topic === null) return c.json(numericError(40101, 401, "unauthorized"), 401);
    if (c.req.query("poll") !== "1") return c.json({ error: "streaming not supported" }, 501);

    const since = pollSince(c.req.query("since"), deps.clock.now());
    let rows: PollMessageRow[];
    if (since === "all") {
      rows = deps.db.prepare("SELECT rowid AS sequence, id, incident_id, title, body, priority, tags, click, markdown, created_at FROM messages WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC").all(topic.id) as PollMessageRow[];
    } else if ("messageId" in since) {
      const boundary = deps.db.prepare("SELECT created_at, rowid AS sequence FROM messages WHERE topic_id = ? AND id = ?").get(topic.id, since.messageId) as { created_at: number; sequence: number } | undefined;
      rows = boundary === undefined
        ? []
        : deps.db.prepare("SELECT rowid AS sequence, id, incident_id, title, body, priority, tags, click, markdown, created_at FROM messages WHERE topic_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?)) ORDER BY created_at ASC, rowid ASC").all(topic.id, boundary.created_at, boundary.created_at, boundary.sequence) as PollMessageRow[];
    } else {
      const operator = since.inclusive ? ">=" : ">";
      rows = deps.db.prepare(`SELECT rowid AS sequence, id, incident_id, title, body, priority, tags, click, markdown, created_at FROM messages WHERE topic_id = ? AND created_at ${operator} ? ORDER BY created_at ASC, rowid ASC`).all(topic.id, since.timestamp) as PollMessageRow[];
    }
    const body = rows.map((message) => JSON.stringify({
      id: message.id,
      time: message.created_at,
      expires: message.created_at + 43_200,
      event: "message",
      topic: topic.name,
      title: message.title,
      message: message.body,
      priority: message.priority,
      tags: JSON.parse(message.tags) as string[],
      ...(message.click === null ? {} : { click: message.click }),
      ...(message.markdown === 1 ? { markdown: true } : {}),
      ...(message.incident_id === null ? {} : { incident_id: message.incident_id }),
    })).join("\n");
    return c.body(body === "" ? body : `${body}\n`, 200, { "content-type": "application/x-ndjson" });
  });
  for (const path of ["/:topic/sse", "/:topic/ws", "/:topic/raw"]) {
    router.get(path, (c) => c.json({ error: "streaming not supported" }, 501));
  }
  return router;
}
