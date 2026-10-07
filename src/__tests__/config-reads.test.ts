import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { PACK_IDS } from "../tier/packs.js";

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BASE_URL: "https://alerts.example.com",
    RELAY_URL: "https://relay.critalarm.app",
    DATA_DIR: "/tmp",
    ALLOW_NOOP_PUSH: "true",
    ...extra,
  };
}

const keyed = { REVENUECAT_SECRET_API_KEY: "sk-fake", REVENUECAT_PROJECT_ID: "proj_fake", REVENUECAT_ENTITLEMENTS: "crit_hosted=hosted" };

describe("REVENUECAT_READS", () => {
  it("is off when unset or empty", () => {
    expect(loadConfig(env()).revenueCatReads).toBe("off");
    expect(loadConfig(env({ REVENUECAT_READS: "" })).revenueCatReads).toBe("off");
    expect(loadConfig(env(keyed)).revenueCatReads).toBe("off");
  });

  it("accepts off, shadow and on", () => {
    for (const value of ["off", "shadow", "on"] as const) {
      expect(loadConfig(env({ ...keyed, REVENUECAT_READS: value })).revenueCatReads).toBe(value);
    }
  });

  it("stops startup on any other value, so a typo is not read as a switch", () => {
    for (const value of ["ON", "true", "1", "shadows", "yes"]) {
      expect(() => loadConfig(env({ ...keyed, REVENUECAT_READS: value }))).toThrow("invalid configuration: REVENUECAT_READS");
    }
  });

  it("is kept as asked when the API key is missing, and the server still starts", () => {
    expect(loadConfig(env({ REVENUECAT_READS: "on" })).revenueCatReads).toBe("on");
    expect(loadConfig(env({ REVENUECAT_READS: "on" })).revenueCatApi).toBeUndefined();
  });
});

describe("REVENUECAT_PACK_ENTITLEMENTS", () => {
  it("is an empty map when unset, so no entitlement gives a pack", () => {
    expect(loadConfig(env()).revenueCatPackEntitlements).toEqual({});
    expect(loadConfig(env({ REVENUECAT_PACK_ENTITLEMENTS: "  " })).revenueCatPackEntitlements).toEqual({});
  });

  it("maps an entitlement identifier to a pack, in the same form as the tier map", () => {
    for (const pack of PACK_IDS) {
      expect(loadConfig(env({ REVENUECAT_PACK_ENTITLEMENTS: `ent_one=${pack}, ent_two=${pack},` })).revenueCatPackEntitlements).toEqual({ ent_one: pack, ent_two: pack });
    }
  });

  it("stops startup on a pack name it does not know, or a pair that does not parse", () => {
    expect(() => loadConfig(env({ REVENUECAT_PACK_ENTITLEMENTS: "ent_one=unheard_of" }))).toThrow("invalid configuration: RevenueCat pack entitlements");
    expect(() => loadConfig(env({ REVENUECAT_PACK_ENTITLEMENTS: "ent_one" }))).toThrow("invalid configuration: RevenueCat pack entitlements");
    expect(() => loadConfig(env({ REVENUECAT_PACK_ENTITLEMENTS: "=pro" }))).toThrow("invalid configuration: RevenueCat pack entitlements");
  });

  it("is separate from the tier map: neither reads the other's variable", () => {
    const config = loadConfig(env({ ...keyed, REVENUECAT_PACK_ENTITLEMENTS: `ent_pack=${PACK_IDS[0]}` }));
    expect(config.revenueCatApi?.entitlements).toEqual({ crit_hosted: "hosted" });
    expect(config.revenueCatPackEntitlements).toEqual({ ent_pack: PACK_IDS[0] });
  });
});

describe("PACK_INCLUDES", () => {
  it("is empty when unset or empty", () => {
    expect(loadConfig(env()).packIncludes).toEqual({});
    expect(loadConfig(env({ PACK_INCLUDES: "" })).packIncludes).toEqual({});
  });

  it("reads tier=pack pairs for any tier and any known pack", () => {
    for (const tier of ["free", "relay", "hosted"] as const) {
      for (const pack of PACK_IDS) {
        expect(loadConfig(env({ PACK_INCLUDES: `${tier}=${pack}` })).packIncludes).toEqual({ [tier]: [pack] });
      }
    }
  });

  it("stops startup on a tier or a pack it does not know", () => {
    expect(() => loadConfig(env({ PACK_INCLUDES: `gold=${PACK_IDS[0]}` }))).toThrow("invalid configuration: PACK_INCLUDES");
    expect(() => loadConfig(env({ PACK_INCLUDES: "free=unheard_of" }))).toThrow("invalid configuration: PACK_INCLUDES");
    expect(() => loadConfig(env({ PACK_INCLUDES: "free" }))).toThrow("invalid configuration: PACK_INCLUDES");
  });
});
