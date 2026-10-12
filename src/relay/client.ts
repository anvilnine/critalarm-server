import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { DeliveryEvent } from "../incident/types.js";
import type { RelayClientOptions, RelayPayload } from "./types.js";
import { version } from "../version.js";
import { topicHash } from "./hash.js";

// A failure the client has already logged and backed off from. The caller needs
// no second log line for it.
export class RelayKeyError extends Error {}

// api.md §3.8. The challenge answers for 60 seconds at most.
const CHALLENGE_WINDOW_MS = 60_000;
// api.md §4.1. Registration retries with growing gaps: 30 s, doubling, 1 h cap.
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_CAP_MS = 3_600_000;
const REGISTER_TIMEOUT_MS = 15_000;

export class RelayClient {
  private challenge: { value: string; expiresAt: number } | undefined;
  private registration: Promise<string> | undefined;
  private backoffMs = 0;
  private nextAttemptAt = 0;
  private lastReason: string | undefined;
  private readonly warnedTopics = new Set<string>();
  // Forwards dropped because there was no key and registration failed or was
  // backing off, since the last registration log line. The next line reports it.
  private skipped = 0;

  constructor(private readonly options: RelayClientOptions) {}

  async forward(events: readonly DeliveryEvent[]): Promise<void> {
    for (const event of events) await this.forwardOne(event);
  }

  // api.md §3.8. True only for the value in flight, and only while the
  // registration call is out and inside the 60 second window.
  isRelayChallenge(value: string): boolean {
    const current = this.challenge;
    if (current === undefined || this.now() >= current.expiresAt) return false;
    const a = createHash("sha256").update(value).digest();
    const b = createHash("sha256").update(current.value).digest();
    return timingSafeEqual(a, b);
  }

  // The startup call. It runs after the listener is up, never throws and never
  // blocks the caller's startup. A server that already holds a key has nothing
  // to prove until a push says otherwise.
  async registerAtStartup(): Promise<void> {
    try {
      if (this.storedKey() !== undefined) { this.log({ event: "relay_key_present", relay_url: this.options.relayUrl }); return; }
      await this.key();
    } catch { /* already logged, and the backoff is running */ }
  }

  async forwardOne(event: DeliveryEvent): Promise<Response | undefined> {
    // api.md §4.1. Every kind goes over the wire, p5 included, so a phone behind
    // the relay hears about a message that joins a live incident. One p5 stays
    // home: the one that joins an acknowledged incident, which the server marks
    // not critical while it has an incident. The wire has no field for that
    // state, so the relay could not tell it from a p5 that should ring.
    if (event.kind === "p5" && event.incidentId !== null && !event.critical) return undefined;
    const payload: RelayPayload = { topic_hash: event.topicHash, topic: event.topic, incident_id: event.incidentId, message_id: event.messageId, priority: event.priority, kind: event.kind, ring_until: event.ringUntil };
    if (this.options.relayContent === "full") { payload.title = event.title; payload.body = event.body; }
    let key = await this.key();
    let response = await this.push(key, payload);
    if (response.status === 401) {
      // The relay replaced the key or forgot it. Drop it, register again
      // through the backoff, and try this one push once more.
      this.dropKey(key);
      key = await this.key();
      response = await this.push(key, payload);
    }
    if (await isTopicMismatch(response)) {
      // A topic's hash is stored when the topic is created and never worked
      // out again. Work it out from the BASE_URL set now. If it matches, the
      // topic is right and the key was registered under an older BASE_URL. If
      // it differs, the topic was created under another BASE_URL and no key
      // can fix that.
      if (topicHash(this.options.baseUrl, event.topic) !== event.topicHash) {
        this.warnForeignTopic(event.topic);
        throw new RelayKeyError("relay push refused: topic created under another BASE_URL");
      }
      this.dropKey(key);
      this.log({ event: "relay_key_replaced", relay_url: this.options.relayUrl, base_url: this.options.baseUrl, message: "The relay key was registered under an older BASE_URL. The server drops it and registers again with the current BASE_URL." });
      key = await this.key();
      response = await this.push(key, payload);
      if (await isTopicMismatch(response)) {
        this.log({ event: "relay_topic_mismatch", relay_url: this.options.relayUrl, base_url: this.options.baseUrl, message: "The relay refused a key it issued a moment ago for the current BASE_URL. Check that RELAY_URL points at a Crit Alarm relay and that BASE_URL is exactly the address the app uses for this server." });
        throw new RelayKeyError("relay push refused: topic mismatch");
      }
    }
    if (!response.ok) throw new Error(`relay push failed: ${response.status}`);
    return response;
  }

  // One line per topic, not per alarm. The topic is the server's own, and the
  // operator needs its name to delete it.
  private warnForeignTopic(topic: string): void {
    if (this.warnedTopics.has(topic)) return;
    this.warnedTopics.add(topic);
    this.log({ event: "relay_topic_other_base_url", base_url: this.options.baseUrl, topic, message: `Topic ${topic} was created under another BASE_URL. Phones subscribed to it will not ring through the relay. Delete the topic and create it again, then add it to the phone again.` });
  }

  private push(key: string, payload: RelayPayload): Promise<Response> {
    return this.call(new Request(`${this.relayBase()}/relay/v1/push`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
  }

  // A relay URL that redirects would carry the body, the secret or the key to
  // another address. Requests are made with redirect "error", and a push that
  // meets one fails with a message that says why.
  private async call(request: Request): Promise<Response> {
    try { return await (this.options.fetch ?? fetch)(request); } catch (error: unknown) {
      if (isRedirectError(error)) throw new Error("relay push failed: the relay answered with a redirect, and the server does not follow it. Set RELAY_URL to the final address.");
      throw error;
    }
  }

  private async key(): Promise<string> {
    const stored = this.storedKey();
    if (stored !== undefined) return stored;
    // Two forwards at once share one registration.
    this.registration ??= this.register().finally(() => { this.registration = undefined; });
    try { return await this.registration; } catch (error: unknown) {
      if (error instanceof RelayKeyError) this.skipped += 1;
      throw error;
    }
  }

  // The count for the log line about to be written, then back to zero. Left
  // out of the line when nothing was skipped.
  private takeSkipped(): { skipped_forwards?: number } {
    const count = this.skipped;
    this.skipped = 0;
    return count === 0 ? {} : { skipped_forwards: count };
  }

  private async register(): Promise<string> {
    if (this.now() < this.nextAttemptAt) throw new RelayKeyError("relay registration is backing off");
    // Only for a relay the operator runs. The secret skips the challenge, so
    // its holder can register any base_url and it is never handed to a stranger.
    const secret = this.options.registrationSecret;
    const challenge = randomBytes(32).toString("base64url");
    this.challenge = { value: challenge, expiresAt: this.now() + CHALLENGE_WINDOW_MS };
    try {
      const response = await (this.options.fetch ?? fetch)(new Request(`${this.relayBase()}/relay/v1/servers`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS), headers: { "content-type": "application/json", ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }) }, body: JSON.stringify({ base_url: this.options.baseUrl, version, challenge }) }));
      if (!response.ok) return this.fail(await this.reasonFor(response));
      const body = await response.json().catch(() => undefined) as unknown;
      if (typeof body !== "object" || body === null || typeof (body as { relay_key?: unknown }).relay_key !== "string") return this.fail({ reason: "bad_answer", status: response.status, say: "The relay answered without a relay key. Check that RELAY_URL points at a Crit Alarm relay." });
      const key = (body as { relay_key: string }).relay_key;
      this.options.db.prepare("INSERT INTO relay_client_credentials (relay_url, relay_key, created_at) VALUES (?, ?, ?) ON CONFLICT(relay_url) DO UPDATE SET relay_key=excluded.relay_key").run(this.options.relayUrl, key, Math.floor(this.now() / 1000));
      this.backoffMs = 0; this.nextAttemptAt = 0; this.lastReason = undefined;
      this.log({ event: "relay_registered", relay_url: this.options.relayUrl, base_url: this.options.baseUrl, ...this.takeSkipped() });
      return key;
    } catch (error: unknown) {
      if (error instanceof RelayKeyError) throw error;
      if (isRedirectError(error)) return this.fail({ reason: "redirect", say: "The relay answered with a redirect, and the server does not follow redirects. Set RELAY_URL to the relay's final address." });
      return this.fail({ reason: "network", say: `The relay could not be reached (${error instanceof Error ? error.name : "error"}). Check RELAY_URL and the server's outbound network.` });
    } finally {
      this.challenge = undefined;
    }
  }

  private async reasonFor(response: Response): Promise<{ reason: string; status: number; say: string }> {
    const status = response.status;
    const error = await errorText(response);
    if (status === 400 && error === "invalid base_url") return { reason: "invalid_base_url", status, say: `The relay only accepts a public https address with a host name, no IP address, no trailing slash. BASE_URL is set to ${this.options.baseUrl}. Check it.` };
    if (status === 422 && error === "challenge failed") return { reason: "challenge_failed", status, say: `The relay could not reach ${this.options.baseUrl}/v1/relay-challenge/... from the internet. Check that the address is reachable from outside your network and that the reverse proxy passes /v1/ through to this server.` };
    if (status === 403 && error === "registration closed") return { reason: "registration_closed", status, say: "The relay's operator has closed registration. Check RELAY_URL. A relay you run yourself accepts this server with RELAY_REGISTRATION_SECRET." };
    if (status === 429) return { reason: "rate_limited", status, say: "The relay rate-limited this registration. The server tries again later." };
    return { reason: `status_${status}`, status, say: `The relay refused registration with status ${status}.` };
  }

  // Records the failure, starts or extends the backoff, and logs once per
  // reason: the first failure, and again when the reason changes.
  private fail(failure: { reason: string; status?: number; say: string }): never {
    this.backoffMs = this.backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.nextAttemptAt = this.now() + this.backoffMs;
    if (failure.reason !== this.lastReason) {
      this.lastReason = failure.reason;
      this.log({ event: "relay_registration_failed", reason: failure.reason, ...(failure.status === undefined ? {} : { status: failure.status }), relay_url: this.options.relayUrl, message: failure.say, ...this.takeSkipped() });
    }
    throw new RelayKeyError(`relay registration failed: ${failure.reason}`);
  }

  private storedKey(): string | undefined {
    const row = this.options.db.prepare("SELECT relay_key FROM relay_client_credentials WHERE relay_url = ?").get(this.options.relayUrl) as { relay_key: string } | undefined;
    return row?.relay_key;
  }

  // Only the key that failed. A second push that already got a new key keeps it.
  private dropKey(key: string): void {
    this.options.db.prepare("DELETE FROM relay_client_credentials WHERE relay_url = ? AND relay_key = ?").run(this.options.relayUrl, key);
  }

  private relayBase(): string { return this.options.relayUrl.replace(/\/$/, ""); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private log(line: Record<string, unknown>): void { (this.options.log ?? ((value) => console.error(JSON.stringify(value))))(line); }
}

// undici reports redirect: "error" as a TypeError whose cause names the redirect.
function isRedirectError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth += 1) {
    if (/redirect/i.test(current.message)) return true;
  }
  return false;
}

async function isTopicMismatch(response: Response): Promise<boolean> {
  return response.status === 403 && await errorText(response) === "topic mismatch";
}

async function errorText(response: Response): Promise<string | undefined> {
  const body = await response.clone().json().catch(() => undefined) as unknown;
  return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : undefined;
}

export function relayKeyHash(key: string): string { return createHash("sha256").update(key).digest("hex"); }
export function newRelayKey(): string { return `rk_${randomUUID().replaceAll("-", "")}`; }
