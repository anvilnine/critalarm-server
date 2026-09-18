import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("loads the hosted defaults from YAML and environment overrides", () => {
    const config = loadConfig(
      { CONFIG_PATH: "/tmp/critalarm.yml", PORT: "9090", ALLOW_NOOP_PUSH: "true" },
      () => [
        "base-url: https://alerts.example.com",
        "relay-content: none",
        "listen: :8080",
        "data-dir: /var/lib/critalarm",
        "behind-proxy: true",
      ].join("\n"),
    );

    expect(config).toMatchObject({
      baseUrl: "https://alerts.example.com",
      relayContent: "none",
      port: 9090,
      dataDir: "/var/lib/critalarm",
      behindProxy: true,
    });
  });

  it("rejects a configuration without a base URL", () => {
    expect(() => loadConfig({ ALLOW_NOOP_PUSH: "true" }, () => "relay-content: none")).toThrow("base-url");
  });

  it("supports full relay content", () => {
    expect(loadConfig({ ALLOW_NOOP_PUSH: "true" }, () => "base-url: https://alerts.example.com\nrelay-content: full").relayContent).toBe("full");
  });

  it("rejects malformed URLs and invalid ports", () => {
    expect(() => loadConfig({ ALLOW_NOOP_PUSH: "true" }, () => "base-url: not-a-url")).toThrow("base-url");
    expect(() => loadConfig({ PORT: "70000", ALLOW_NOOP_PUSH: "true" }, () => "base-url: https://alerts.example.com")).toThrow("port");
  });

  it("uses CONFIG_PATH and PORT ahead of YAML", () => {
    let path = "";
    const config = loadConfig(
      { CONFIG_PATH: "/etc/critalarm.yml", PORT: "8181", ALLOW_NOOP_PUSH: "true" },
      (value) => {
        path = value;
        return "base-url: https://alerts.example.com\nlisten: :8080";
      },
    );

    expect(path).toBe("/etc/critalarm.yml");
    expect(config.port).toBe(8181);
  });

  it("reads critalarm.yml when CONFIG_PATH is absent", () => {
    let path = "";
    loadConfig({ ALLOW_NOOP_PUSH: "true" }, (value) => { path = value; return "base-url: https://alerts.example.com"; });
    expect(path).toBe("critalarm.yml");
  });

  it("requires a complete push provider and RevenueCat secret in production", () => {
    const incomplete = [
      "base-url: https://alerts.example.com",
      "apns:",
      "  team-id: team",
      "  key-id: key",
      "  private-key: secret-private-key",
    ].join("\n");
    let error: unknown;
    try {
      loadConfig({ NODE_ENV: "production" }, () => incomplete);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/APNs/);
    expect((error as Error).message).not.toContain("secret-private-key");
    expect(loadConfig({ NODE_ENV: "production" }, () => "base-url: https://alerts.example.com").mode).toBe("selfhosted");
    // Hosted production also needs the entitlement map, and it comes from the
    // environment: there is no config file in the image.
    expect(() => loadConfig({ NODE_ENV: "production", REVENUECAT_ENTITLEMENTS: "hosted=hosted,relay=relay" }, () => [
      "base-url: https://alerts.example.com",
      "apns:",
      "  team-id: team",
      "  key-id: key",
      "  private-key: secret-private-key",
      "  bundle-id: app.critalarm",
      "revenuecat:",
      "  shared-secret: another-secret",
    ].join("\n"))).not.toThrow();
  });

  it("only permits no-op push when explicitly enabled outside production", () => {
    expect(() => loadConfig({}, () => "base-url: https://alerts.example.com")).toThrow("push provider");
    expect(() => loadConfig({ ALLOW_NOOP_PUSH: "true" }, () => "base-url: https://alerts.example.com")).not.toThrow();
    expect(loadConfig({ NODE_ENV: "production", ALLOW_NOOP_PUSH: "true" }, () => "base-url: https://alerts.example.com").mode).toBe("selfhosted");
  });
});
