import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { DeliveryEvent } from "../incident/types.js";
import type { RelayClientOptions, RelayPayload } from "./types.js";
import { version } from "../version.js";

export class RelayClient {
  constructor(private readonly options: RelayClientOptions) {}

  async forward(events: readonly DeliveryEvent[]): Promise<void> {
    for (const event of events) await this.forwardOne(event);
  }

  async forwardOne(event: DeliveryEvent): Promise<Response | undefined> {
    // p5 rings locally, so the relay never hears it. The three state kinds do go
    // over the wire: a device behind the relay has to hear that the incident was
    // handled on another phone (api.md §4.1).
    if (event.kind === "p5") return undefined;
    const key = await this.key();
    const payload: RelayPayload = { topic_hash: event.topicHash, incident_id: event.incidentId, message_id: event.messageId, priority: event.priority, kind: event.kind };
    if (this.options.relayContent === "full") { payload.title = event.title; payload.body = event.body; }
    const response = await (this.options.fetch ?? fetch)(new Request(`${this.options.relayUrl.replace(/\/$/, "")}/relay/v1/push`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
    if (!response.ok) throw new Error(`relay push failed: ${response.status}`);
    return response;
  }

  private async key(): Promise<string> {
    const row = this.options.db.prepare("SELECT relay_key FROM relay_client_credentials WHERE relay_url = ?").get(this.options.relayUrl) as { relay_key: string } | undefined;
    if (row !== undefined) return row.relay_key;
    // A relay that gates registration hands its operator's secret to the people
    // it wants forwarding to it, and refuses a caller without it.
    const registration = this.options.registrationSecret;
    const response = await (this.options.fetch ?? fetch)(new Request(`${this.options.relayUrl.replace(/\/$/, "")}/relay/v1/servers`, { method: "POST", headers: { "content-type": "application/json", ...(registration === undefined ? {} : { authorization: `Bearer ${registration}` }) }, body: JSON.stringify({ base_url: this.options.baseUrl, version }) }));
    if (!response.ok) throw new Error(`relay key request failed: ${response.status}`);
    const body = await response.json() as unknown;
    if (typeof body !== "object" || body === null || typeof (body as { relay_key?: unknown }).relay_key !== "string") throw new Error("relay key missing");
    const key = (body as { relay_key: string }).relay_key;
    this.options.db.prepare("INSERT INTO relay_client_credentials (relay_url, relay_key, created_at) VALUES (?, ?, ?) ON CONFLICT(relay_url) DO UPDATE SET relay_key=excluded.relay_key").run(this.options.relayUrl, key, Math.floor(Date.now() / 1000));
    return key;
  }
}

export function relayKeyHash(key: string): string { return createHash("sha256").update(key).digest("hex"); }
export function newRelayKey(): string { return `rk_${randomUUID().replaceAll("-", "")}`; }
