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

// Production runs on environment variables only: no critalarm.yml is in the
// repo and none is copied into the image. Before REVENUECAT_ENTITLEMENTS the
// map could only come from that file, so production ran with an empty map and
// every purchase webhook returned 200 and upgraded nobody.
describe("the RevenueCat entitlement map", () => {
  const FILE = [
    "revenuecat:",
    "  shared-secret: file-secret",
    "  entitlements:",
    "    file_hosted: hosted",
    "",
  ].join("\n");

  it("is read from REVENUECAT_ENTITLEMENTS as comma separated key=tier pairs", () => {
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret", REVENUECAT_ENTITLEMENTS: "hosted=hosted,relay=relay" })).revenueCat).toEqual({
      sharedSecret: "rc-secret",
      entitlements: { hosted: "hosted", relay: "relay" },
    });
  });

  it("keeps all three tiers and ignores spaces around a pair", () => {
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret", REVENUECAT_ENTITLEMENTS: "a=free, b = relay ,c=hosted" })).revenueCat?.entitlements).toEqual({
      a: "free",
      b: "relay",
      c: "hosted",
    });
  });

  it("is read from the config file when the environment does not set it", () => {
    expect(loadConfig(env(), () => FILE).revenueCat).toEqual({ sharedSecret: "file-secret", entitlements: { file_hosted: "hosted" } });
  });

  it("takes REVENUECAT_ENTITLEMENTS over the config file", () => {
    expect(loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=hosted" }), () => FILE).revenueCat).toEqual({
      sharedSecret: "file-secret",
      entitlements: { hosted: "hosted" },
    });
  });

  it("falls back to the config file when the environment value is empty", () => {
    expect(loadConfig(env({ REVENUECAT_ENTITLEMENTS: "" }), () => FILE).revenueCat?.entitlements).toEqual({ file_hosted: "hosted" });
  });

  it("is empty when nothing sets it outside hosted production", () => {
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret" })).revenueCat?.entitlements).toEqual({});
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret", REVENUECAT_ENTITLEMENTS: "" })).revenueCat?.entitlements).toEqual({});
  });

  it("does not create the config on its own, so a map with no secret mounts no webhook", () => {
    expect(loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=hosted" })).revenueCat).toBeUndefined();
  });

  // Every one of these used to be a silent "no upgrades", so none of them is
  // dropped: they all stop startup.
  it("refuses a tier outside the three", () => {
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=Hosted" }))).toThrow("invalid configuration: RevenueCat entitlements");
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=premium" }))).toThrow("invalid configuration: RevenueCat entitlements");
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=hosted,relay=relais" }))).toThrow("invalid configuration: RevenueCat entitlements");
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=" }))).toThrow("invalid configuration: RevenueCat entitlements");
  });

  it("refuses a pair with no equals sign", () => {
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted" }))).toThrow("invalid configuration: RevenueCat entitlements");
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=hosted,relay" }))).toThrow("invalid configuration: RevenueCat entitlements");
  });

  // Somebody types this into a Coolify box. A comma with nothing after it says
  // nothing, so it is skipped rather than kept from booting.
  it("ignores a trailing comma", () => {
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret", REVENUECAT_ENTITLEMENTS: "hosted=hosted,relay=relay," })).revenueCat?.entitlements).toEqual({
      hosted: "hosted",
      relay: "relay",
    });
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret", REVENUECAT_ENTITLEMENTS: "hosted=hosted," })).revenueCat?.entitlements).toEqual({ hosted: "hosted" });
  });

  it("ignores a repeated comma", () => {
    expect(loadConfig(env({ REVENUECAT_SHARED_SECRET: "rc-secret", REVENUECAT_ENTITLEMENTS: "hosted=hosted,,relay=relay" })).revenueCat?.entitlements).toEqual({
      hosted: "hosted",
      relay: "relay",
    });
  });

  it("refuses an empty key", () => {
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "=hosted" }))).toThrow("invalid configuration: RevenueCat entitlements");
    expect(() => loadConfig(env({ REVENUECAT_ENTITLEMENTS: "hosted=hosted, =relay" }))).toThrow("invalid configuration: RevenueCat entitlements");
  });

  it("is refused when it is empty in production on a relay", () => {
    const production = { NODE_ENV: "production", FCM_PROJECT_ID: "p", FCM_CLIENT_EMAIL: "e", FCM_PRIVATE_KEY: "k", REVENUECAT_SHARED_SECRET: "rc-secret" };
    expect(() => loadConfig(env(production))).toThrow("invalid configuration: RevenueCat entitlements");
    expect(loadConfig(env({ ...production, REVENUECAT_ENTITLEMENTS: "hosted=hosted,relay=relay" })).revenueCat?.entitlements).toEqual({ hosted: "hosted", relay: "relay" });
  });

  it("is not demanded in production on a self-hosted box", () => {
    expect(loadConfig(env({ NODE_ENV: "production", MODE: "selfhosted" })).revenueCat).toBeUndefined();
  });
});
