import type Database from "better-sqlite3";
import type { DeliveryEvent } from "../incident/types.js";

// api.md §4.1. The last three are state changes and never ring. p5 is a
// priority-5 message that joins a live incident, or one on a topic whose switch
// is off, which has no incident.
export type RelayKind = "open" | "repeat" | "reopen" | "p4" | "p5" | "ack" | "close" | "expire";
export interface RelayPayload {
  topic_hash: string; incident_id: string | null; message_id: string; priority: 4 | 5; kind: RelayKind;
  // api.md §4.1. opened_at + max_ring_s on the pushing server, so the relay can
  // pass the ring window on. Null on p4, on a p5 with no incident, and on the state kinds.
  ring_until: number | null;
  title?: string; body?: string;
}
export interface RelayClientOptions { db: Database.Database; relayUrl: string; baseUrl: string; relayContent: "none" | "full"; registrationSecret?: string; fetch?: (request: Request) => Promise<Response>; }
export interface RelayIngressDependencies { db: Database.Database; dispatch(event: DeliveryEvent): Promise<void>; }
