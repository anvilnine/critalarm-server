import type { KeyObject } from "node:crypto";
import type { DeliveryEvent } from "../domain-events.js";
import type { Clock } from "../incident/types.js";

// Which Apple push host a token belongs to. A Debug or Profile build of the
// iOS app registers a sandbox token, a Release, TestFlight or App Store build
// registers a production one, and each host refuses the other's.
export type ApnsEnvironment = "sandbox" | "production";

export interface PushDevice {
  id: string;
  accountId: string;
  platform: "ios" | "android";
  pushToken: string;
  // The host that last rang this device, or absent when the server has not
  // learned it yet. Absent means start at the configured APNS_ENVIRONMENT.
  apnsEnvironment?: ApnsEnvironment;
}

export interface PushResult {
  status: number;
  stale: boolean;
  // The host that answered. Only APNs sets it. The dispatcher writes it back
  // so the next push to this device starts on the right host.
  apnsEnvironment?: ApnsEnvironment;
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

// api.md §5.3. The Live Activity push that rides next to the alarm push.
export interface LiveActivityPush {
  token: string;
  event: "start" | "update" | "end";
  incidentId: string;
  topic: string;
  server: string;
  state: "open" | "acked" | "closed" | "expired";
  title: string;
  openedAt: number;
  // The owning device's known host, when there is one. A Live Activity token
  // is minted by the same build as the alarm token, so it lives in the same
  // environment.
  apnsEnvironment?: ApnsEnvironment;
}

export interface LiveActivitySender {
  sendLiveActivity(push: LiveActivityPush): Promise<PushResult>;
}
