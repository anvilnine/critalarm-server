export interface Clock {
  now(): number;
}

export interface IdGenerator {
  message(): string;
  incident(): string;
  timer(): string;
}

export interface DeliveryEvent {
  kind: "open" | "repeat" | "reopen" | "p4" | "p5";
  topicHash: string;
  topic: string;
  incidentId: string | null;
  messageId: string;
  priority: 4 | 5;
  maxRingS: number;
  server: string;
  title: string;
  body: string;
  critical: boolean;
  relayContent?: "none" | "full";
}

export interface StoredMessageInput {
  title: string;
  body: string;
  priority: 5;
  tags: readonly string[];
  click: string | null;
  markdown: boolean;
}

export interface CriticalPublication {
  topicId: string;
  topicHash: string;
  topic: string;
  baseUrl: string;
  repeatIntervalS: number;
  maxRingS: number;
  deskTimerS: number;
  message: StoredMessageInput;
  relayContent?: "none" | "full";
}

export type IncidentState = "open" | "acked" | "closed" | "expired";

export interface MessageRecord {
  id: string;
  topicId: string;
  incidentId: string | null;
  title: string;
  body: string;
  priority: number;
  tags: string[];
  click: string | null;
  markdown: boolean;
  createdAt: number;
}

export interface IncidentRecord {
  id: string;
  topicId: string;
  state: IncidentState;
  openedAt: number;
  ackedAt: number | null;
  closedAt: number | null;
  lastMessageAt: number;
}

export interface IncidentWithMessages extends IncidentRecord {
  topic: string;
  messages: MessageRecord[];
}

export interface IncidentFilter {
  state?: IncidentState;
  topic?: string;
  limit?: number;
}
