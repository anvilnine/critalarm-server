import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("loads the hosted defaults from YAML and environment overrides", () => {
    const config = loadConfig(
      { CONFIG_PATH: "/tmp/critalarm.yml", PORT: "9090" },
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
    expect(() => loadConfig({}, () => "relay-content: none")).toThrow("base-url");
  });

  it("rejects relay content other than none", () => {
    expect(() => loadConfig({}, () => "base-url: https://alerts.example.com\nrelay-content: full")).toThrow("relay-content");
  });

  it("rejects malformed URLs and invalid ports", () => {
    expect(() => loadConfig({}, () => "base-url: not-a-url")).toThrow("base-url");
    expect(() => loadConfig({ PORT: "70000" }, () => "base-url: https://alerts.example.com")).toThrow("port");
  });

  it("uses CONFIG_PATH and PORT ahead of YAML", () => {
    let path = "";
    const config = loadConfig(
      { CONFIG_PATH: "/etc/critalarm.yml", PORT: "8181" },
      (value) => {
        path = value;
        return "base-url: https://alerts.example.com\nlisten: :8080";
      },
    );

    expect(path).toBe("/etc/critalarm.yml");
    expect(config.port).toBe(8181);
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
    expect(() => loadConfig({ NODE_ENV: "production" }, () => "base-url: https://alerts.example.com")).toThrow("push provider");
    expect(() => loadConfig({ NODE_ENV: "production" }, () => [
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
});
