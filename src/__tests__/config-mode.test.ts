import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BASE_URL: "https://alerts.example.com",
    DATA_DIR: "/tmp",
    ALLOW_NOOP_PUSH: "true",
    ...extra,
  };
}

// Enough APNs values to make apnsConfig return a provider.
const APNS: NodeJS.ProcessEnv = {
  APNS_TEAM_ID: "team",
  APNS_KEY_ID: "key",
  APNS_PRIVATE_KEY: "pem",
  APNS_BUNDLE_ID: "app.critalarm.example",
};

describe("mode as a setting", () => {
  it("is read from MODE, even on a box that has APNs credentials", () => {
    // This is the operator the old inference read wrong: own APNs key, no
    // relay URL, inferred as a relay, handed accounts, caps and billing.
    expect(loadConfig(env({ ...APNS, MODE: "selfhosted" })).mode).toBe("selfhosted");
  });

  it("is read from the config file", () => {
    expect(loadConfig(env(APNS), () => "mode: selfhosted\n").mode).toBe("selfhosted");
  });

  it("takes MODE over the config file", () => {
    expect(loadConfig(env({ MODE: "hosted" }), () => "mode: selfhosted\n").mode).toBe("hosted");
  });

  it("keeps all three values", () => {
    for (const mode of ["selfhosted", "relay", "hosted"] as const) {
      expect(loadConfig(env({ ...APNS, MODE: mode })).mode).toBe(mode);
      expect(loadConfig(env(APNS), () => `mode: ${mode}\n`).mode).toBe(mode);
    }
  });

  it("fails startup on a value outside the three", () => {
    expect(() => loadConfig(env({ MODE: "selfhost" }))).toThrow("invalid configuration: mode");
    expect(() => loadConfig(env({ MODE: "Selfhosted" }))).toThrow("invalid configuration: mode");
    expect(() => loadConfig(env({ MODE: "" }))).toThrow("invalid configuration: mode");
    expect(() => loadConfig(env(), () => "mode: local\n")).toThrow("invalid configuration: mode");
  });
});

describe("an absent mode", () => {
  it("still infers selfhosted with no push provider", () => {
    expect(loadConfig(env()).mode).toBe("selfhosted");
  });

  it("still infers relay with a push provider and no relay URL", () => {
    expect(loadConfig(env(APNS)).mode).toBe("relay");
  });

  it("still infers hosted with a push provider and an explicit relay URL", () => {
    expect(loadConfig(env({ ...APNS, RELAY_URL: "https://relay.critalarm.app" })).mode).toBe("hosted");
  });
});
