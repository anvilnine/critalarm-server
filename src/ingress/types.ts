import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { DeliveryEvent, DispatchResult } from "../domain-events.js";
import type { IncidentService } from "../incident/service.js";
import type { Clock, IdGenerator } from "../incident/types.js";

export interface PublishInput {
  topic: string;
  message: string;
  title?: string;
  priority: number;
  tags: string[];
  click?: string;
  markdown: boolean;
}

export interface NtfyMessage {
  id: string;
  time: number;
  expires: number;
  event: "message";
  topic: string;
  title: string;
  message: string;
  priority: number;
  tags: string[];
  click?: string;
  markdown?: boolean;
}

export interface PublishResult extends NtfyMessage {
  incident_id?: string;
}

export interface TopicRecord {
  id: string;
  accountId: string;
  name: string;
  baseUrl: string;
  topicHash: string;
  critical: boolean;
  repeatIntervalS: number;
  maxRingS: number;
  deskTimerS: number;
  relayContent?: "none" | "full";
}

export interface IngressDependencies {
  db: Database.Database;
  incidents: IncidentService;
  clock: Clock;
  ids: IdGenerator;
  dispatch(events: readonly DeliveryEvent[]): Promise<DispatchResult | void>;
  publishLimit?: number;
  behindProxy?: boolean;
}

export type IngressRouter = Hono;
