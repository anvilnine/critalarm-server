import type Database from "better-sqlite3";
import type { DeliveryEvent } from "../incident/types.js";

// api.md §4.1. The last three are state changes and never ring.
export type RelayKind = "open" | "repeat" | "reopen" | "p4" | "ack" | "close" | "expire";
export interface RelayPayload {
  topic_hash: string; incident_id: string | null; message_id: string; priority: 4 | 5; kind: RelayKind;
  title?: string; body?: string;
}
export interface RelayClientOptions { db: Database.Database; relayUrl: string; baseUrl: string; relayContent: "none" | "full"; registrationSecret?: string; fetch?: (request: Request) => Promise<Response>; }
export interface RelayIngressDependencies { db: Database.Database; dispatch(event: DeliveryEvent): Promise<void>; }
