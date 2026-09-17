import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BASE_URL: "https://alerts.example.com",
    RELAY_URL: "https://relay.critalarm.app",
    DATA_DIR: "/tmp",
    ALLOW_NOOP_PUSH: "true",
    ...extra,
  };
}

describe("the RevenueCat shared secret", () => {
  it("is refused when it is an empty string", () => {
    // The production check only caught undefined. An empty string is defined,
    // passed it, and then matched a request with no Authorization header.
    expect(() => loadConfig(env({ REVENUECAT_SHARED_SECRET: "" }))).toThrow("invalid configuration: RevenueCat shared secret");
  });

  it("is refused when it is unset in production on a relay", () => {
    expect(() => loadConfig(env({ NODE_ENV: "production", FCM_PROJECT_ID: "p", FCM_CLIENT_EMAIL: "e", FCM_PRIVATE_KEY: "k" }))).toThrow("invalid configuration: RevenueCat shared secret");
  });

  it("is absent from the config when unset, so the webhook is not mounted", () => {
    expect(loadConfig(env()).revenueCat).toBeUndefined();
  });

  it("is kept as given when set", () => {
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret" })).revenueCat).toEqual({ sharedSecret: "rc-secret", entitlements: {} });
  });
});

describe("the relay registration secret", () => {
  it("is absent when unset or empty, so POST /relay/v1/servers is not mounted", () => {
    expect(loadConfig(env()).relayRegistrationSecret).toBeUndefined();
    expect(loadConfig(env({ RELAY_REGISTRATION_SECRET: "" })).relayRegistrationSecret).toBeUndefined();
  });

  it("is read from the environment when set", () => {
    expect(loadConfig(env({ RELAY_REGISTRATION_SECRET: "registration-secret" })).relayRegistrationSecret).toBe("registration-secret");
  });
});

describe("Google client IDs", () => {
  it.each([
    ["one client ID without a comma", "a", ["a"]],
    ["three client IDs with the primary first", "a,b,c", ["a", "b", "c"]],
    ["whitespace around client IDs", " a , b ", ["a", "b"]],
    ["an empty entry between client IDs", "a,,b", ["a", "b"]],
  ])("parses %s", (_name, value, expected) => {
    const config = loadConfig(env({
      AUTH_SECRET: "a".repeat(32),
      AUTH_GOOGLE_CLIENT_ID: value,
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    }));
    expect(config.auth?.google?.clientId).toEqual(expected);
  });

  it("refuses an empty audience list when a client secret is present", () => {
    expect(() => loadConfig(env({
      AUTH_SECRET: "a".repeat(32),
      AUTH_GOOGLE_CLIENT_ID: ",",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    }))).toThrow("invalid configuration: AUTH_GOOGLE sign-in credentials");
  });
});
