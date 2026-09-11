import type { PublishInput } from "./types.js";

export class ParseError extends Error {
  constructor(
    public readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

type ParsedPublish = Omit<PublishInput, "topic">;

const priorityNames: Record<string, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
  max: 5,
};

function firstHeader(headers: Headers, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = headers.get(alias);
    if (value !== null) return value;
  }
  return undefined;
}

function priority(value: unknown): number {
  const stringValue = String(value).toLowerCase();
  const parsed = priorityNames[stringValue] ?? Number(stringValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new ParseError(400, "invalid priority");
  }
  return parsed;
}

function tags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function markdown(value: unknown): boolean {
  return value === true || (typeof value === "string" && ["true", "1", "yes"].includes(value.toLowerCase()));
}

function hasDelay(headers: Headers): boolean {
  return firstHeader(headers, ["X-Delay", "Delay", "X-At", "At", "X-In", "In"]) !== undefined;
}

function normalize(fields: {
  message?: unknown;
  title?: unknown;
  priority?: unknown;
  tags?: unknown;
  click?: unknown;
  markdown?: unknown;
}): ParsedPublish {
  return {
    message: typeof fields.message === "string" && fields.message.length > 0 ? fields.message : "triggered",
    ...(typeof fields.title === "string" ? { title: fields.title } : {}),
    priority: fields.priority === undefined ? 3 : priority(fields.priority),
    tags: tags(fields.tags),
    ...(typeof fields.click === "string" ? { click: fields.click } : {}),
    markdown: markdown(fields.markdown),
  };
}

export async function parsePublishRequest(request: Request): Promise<ParsedPublish> {
  if (hasDelay(request.headers)) {
    throw new ParseError(400, "scheduled delivery not supported");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 4096) {
    throw new ParseError(413, "message too large");
  }
  const query = new URL(request.url).searchParams;
  return normalize({
    message: query.get("m") ?? new TextDecoder().decode(bytes),
    title: query.get("t") ?? firstHeader(request.headers, ["X-Title", "Title", "ti", "t"]),
    priority: query.get("p") ?? firstHeader(request.headers, ["X-Priority", "Priority", "prio", "p"]),
    tags: query.get("ta") ?? firstHeader(request.headers, ["X-Tags", "Tags", "tag", "ta"]),
    click: firstHeader(request.headers, ["X-Click", "Click"]),
    markdown: firstHeader(request.headers, ["X-Markdown", "Markdown", "md"]),
  });
}

export function parseJsonPublish(value: unknown): PublishInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ParseError(400, "invalid JSON publish");
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.delay !== "undefined") {
    throw new ParseError(400, "scheduled delivery not supported");
  }
  if (typeof fields.topic !== "string" || fields.topic.length === 0) {
    throw new ParseError(400, "topic is required");
  }
  const input = normalize(fields);
  return { topic: fields.topic, ...input };
}
