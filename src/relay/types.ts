import type Database from "better-sqlite3";
import type { DeliveryEvent } from "../incident/types.js";

export type RelayKind = "open" | "repeat" | "reopen" | "p4";
export interface RelayPayload {
  topic_hash: string; incident_id: string | null; message_id: string; priority: 4 | 5; kind: RelayKind;
  title?: string; body?: string;
}
export interface RelayClientOptions { db: Database.Database; relayUrl: string; baseUrl: string; relayContent: "none" | "full"; fetch?: (request: Request) => Promise<Response>; }
export interface RelayIngressDependencies { db: Database.Database; dispatch(event: DeliveryEvent): Promise<void>; }
