import type { KeyObject } from "node:crypto";
import type { DeliveryEvent } from "../domain-events.js";
import type { Clock } from "../incident/types.js";

export interface PushDevice {
  id: string;
  accountId: string;
  platform: "ios" | "android";
  pushToken: string;
}

export interface PushResult {
  status: number;
  stale: boolean;
}

export interface PushSender {
  send(device: PushDevice, event: DeliveryEvent): Promise<PushResult>;
}

export type PushFetch = (request: Request) => Promise<Response>;
export type PrivateKey = KeyObject | string | Buffer;

export interface SenderDependencies {
  clock: Clock;
  fetch: PushFetch;
}
