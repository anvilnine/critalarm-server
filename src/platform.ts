// api.md §4.2. The three device platforms. A Mac registers like an iPhone, so
// `ios` and `macos` both hold an `apns` alarm token and ring through APNs, and
// `android` holds an `fcm` one.
export const platforms = ["ios", "android", "macos"] as const;
export type Platform = (typeof platforms)[number];

export type AlarmTokenKind = "apns" | "fcm";

export function alarmTokenKind(platform: Platform): AlarmTokenKind {
  return platform === "android" ? "fcm" : "apns";
}

export function usesApns(platform: Platform): boolean {
  return alarmTokenKind(platform) === "apns";
}

// The same choice in SQL, for queries that join a device to its alarm token.
// Anything that is not an Apple platform is FCM, as it was before macos.
export function alarmTokenKindSql(platformColumn: string): string {
  return `CASE WHEN ${platformColumn} IN ('ios', 'macos') THEN 'apns' ELSE 'fcm' END`;
}
