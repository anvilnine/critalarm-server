// Bounded request body reads. Every route that reads a body goes through
// here, so no request makes the process hold more than its route's limit.
//
// A Content-Length over the limit is refused without reading anything. A body
// with no Content-Length, or a wrong one, is read only until it passes the
// limit, and then the stream is cancelled. request.json(), request.text() and
// request.arrayBuffer() read the whole body first and check its size after,
// which let an unauthenticated POST / of 8 MiB sit in memory before its 413.

// Largest body for a route that takes a small JSON object: a device
// registration, a token, a topic, an account call, a check switch. The biggest
// field any of them carries is a push token (up to 4096 characters) or an
// identity token (a JWT of a few KB).
export const SMALL_JSON_BYTES = 16_384;

export class BodyTooLarge extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLarge";
  }
}

export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array | "too large"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return "too large";
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// The body as parsed JSON, or "too large", or undefined when it is not JSON.
export async function readJson(request: Request, maxBytes: number): Promise<unknown | "too large" | undefined> {
  const bytes = await readBytes(request, maxBytes);
  if (bytes === "too large") return "too large";
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

// The same read for a handler written around request.json(): the parsed body,
// or a throw. BodyTooLarge for a body over the limit, SyntaxError for one that
// is not JSON (an empty body included), the same error request.json() throws.
export async function jsonBody(request: Request, maxBytes: number = SMALL_JSON_BYTES): Promise<unknown> {
  const bytes = await readBytes(request, maxBytes);
  if (bytes === "too large") throw new BodyTooLarge();
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
}

// The body as text, or a BodyTooLarge throw.
export async function textBody(request: Request, maxBytes: number = SMALL_JSON_BYTES): Promise<string> {
  const bytes = await readBytes(request, maxBytes);
  if (bytes === "too large") throw new BodyTooLarge();
  return Buffer.from(bytes).toString("utf8");
}

// The same request with its body read through readBytes, for a handler that
// reads the body itself (better-auth on /api/auth/*). The bytes go back in as
// the new body, so the handler sees the same method, URL, headers and body it
// would have seen, and can still call request.json() or request.formData().
// Content-Length and Transfer-Encoding are dropped: the new body is a buffer
// and carries its own length. A request with no body is handed on untouched.
export async function boundedRequest(request: Request, maxBytes: number): Promise<Request | "too large"> {
  if (request.body === null) return request;
  const bytes = await readBytes(request, maxBytes);
  if (bytes === "too large") return "too large";
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, { method: request.method, headers, body: bytes, signal: request.signal });
}
