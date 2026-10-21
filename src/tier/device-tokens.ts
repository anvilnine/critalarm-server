import { z } from "zod";
import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import type { TierDependencies } from "./types.js";

export const tokenKinds = ["apns", "fcm", "la_start", "la_update"] as const;
export type TokenKind = (typeof tokenKinds)[number];

export const tokenKindSchema = z.enum(tokenKinds);

// What a push token may look like. The relay puts the token in the APNs
// request path or the FCM message, so a token of any length or character used
// to reach the sender as typed. A 70000-character token made the APNs client
// throw before it sent anything (the HTTP/2 header limit is about 64 KiB).
//
// APNs: the app sends Apple's raw token bytes as hex, for the alarm token
// (ios/Runner/AppDelegate.swift) and for both Live Activity tokens
// (ios/Shared/Alarm/IncidentActivityCoordinator.swift). A device token is 32
// bytes today and an activity token about 80. Apple says the length may grow,
// so up to 256 bytes is allowed.
//
// FCM: the token Firebase Messaging hands the Android app. Firebase does not
// publish a format. Tokens seen so far are about 160 characters of URL-safe
// base64 with one colon, so this allows the URL-unreserved characters plus the
// colon, up to 4096.
export const apnsTokenSchema = z.string().regex(/^[0-9A-Fa-f]{1,512}$/);
export const fcmTokenSchema = z.string().regex(/^[A-Za-z0-9._~:-]{1,4096}$/);

export function tokenSchemaForKind(kind: TokenKind): z.ZodString {
  return kind === "fcm" ? fcmTokenSchema : apnsTokenSchema;
}

export function pushTokenSchemaFor(platform: "ios" | "android"): z.ZodString {
  return platform === "ios" ? apnsTokenSchema : fcmTokenSchema;
}

// api.md §4.2. activity_id belongs to la_update and only to it, because an
// la_update token points at one running Live Activity. The other three kinds
// are one per device, so they are stored with an empty activity_id.
export const tokenSchema = z
  .object({
    kind: tokenKindSchema,
    token: z.string().min(1),
    activity_id: z.string().min(1).optional(),
    incident_id: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (!tokenSchemaForKind(value.kind).safeParse(value.token).success) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["token"], message: "not a token of this kind" });
    }
    if (value.kind === "la_update" && value.activity_id === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["activity_id"], message: "required for la_update" });
    }
    if (value.kind !== "la_update" && value.activity_id !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["activity_id"], message: "only allowed for la_update" });
    }
    if (value.kind !== "la_update" && value.incident_id !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["incident_id"], message: "only allowed for la_update" });
    }
  });

export type TokenInput = z.infer<typeof tokenSchema>;

export function putDeviceToken(deps: TierDependencies, deviceId: string, input: TokenInput): void {
  deps.db
    .prepare(
      `INSERT INTO device_tokens (device_id, kind, activity_id, incident_id, token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, kind, activity_id)
       DO UPDATE SET token = excluded.token, incident_id = excluded.incident_id, updated_at = excluded.updated_at`,
    )
    .run(deviceId, input.kind, input.activity_id ?? "", input.incident_id ?? null, input.token, deps.clock.now());
}

export function deleteDeviceTokens(deps: TierDependencies, deviceId: string, kind: TokenKind, activityId?: string): void {
  if (activityId === undefined) {
    deps.db.prepare("DELETE FROM device_tokens WHERE device_id = ? AND kind = ?").run(deviceId, kind);
    return;
  }
  deps.db
    .prepare("DELETE FROM device_tokens WHERE device_id = ? AND kind = ? AND activity_id = ?")
    .run(deviceId, kind, activityId);
}

// The alarm token registered through push_token on POST /relay/v1/devices and
// PATCH /relay/v1/devices/{device_id}, kept in the same list as every other
// token so the push sender has one place to read from.
export function setAlarmToken(
  db: Database.Database,
  clock: Clock,
  deviceId: string,
  platform: "ios" | "android",
  token: string,
): void {
  const kind: TokenKind = platform === "ios" ? "apns" : "fcm";
  db.prepare("DELETE FROM device_tokens WHERE device_id = ? AND kind IN ('apns', 'fcm')").run(deviceId);
  db.prepare(
    "INSERT INTO device_tokens (device_id, kind, activity_id, incident_id, token, updated_at) VALUES (?, ?, '', NULL, ?, ?)",
  ).run(deviceId, kind, token, clock.now());
}
