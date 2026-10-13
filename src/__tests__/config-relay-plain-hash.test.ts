import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

// api.md §4.1, 1.21.0. relay-plain-hash is on or off, and on by default.

const env = (extra: Record<string, string> = {}) => ({ ALLOW_NOOP_PUSH: "true", BASE_URL: "https://alerts.example.com", ...extra });

describe("relay-plain-hash", () => {
  it("is on when unset", () => {
    expect(loadConfig(env()).relayPlainHash).toBe("on");
  });

  it("reads RELAY_PLAIN_HASH", () => {
    expect(loadConfig(env({ RELAY_PLAIN_HASH: "off" })).relayPlainHash).toBe("off");
    expect(loadConfig(env({ RELAY_PLAIN_HASH: "on" })).relayPlainHash).toBe("on");
  });

  it("reads the config file key, and the variable wins", () => {
    const file = () => "relay-plain-hash: off";
    expect(loadConfig(env(), file).relayPlainHash).toBe("off");
    expect(loadConfig(env({ RELAY_PLAIN_HASH: "on" }), file).relayPlainHash).toBe("on");
  });

  it("refuses any other value", () => {
    expect(() => loadConfig(env({ RELAY_PLAIN_HASH: "false" }))).toThrow("relay-plain-hash");
  });
});
