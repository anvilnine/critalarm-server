import * as Sentry from "@sentry/node";

// Crash reporting, off unless GLITCHTIP_DSN is set. Reads process.env directly
// because only the Node entry point calls it.
//
// There is no analytics here. If Crit Alarm ever wants server-side events, add
// them behind the same env gate: unset means silent, never a stray network
// call from an alarm server.
const dsn = process.env.GLITCHTIP_DSN;

export function initCrashReporting(): void {
  if (dsn) {
    Sentry.init({ dsn, environment: process.env.NODE_ENV ?? "development" });
  }
}
