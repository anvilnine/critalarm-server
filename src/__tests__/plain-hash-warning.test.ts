import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { warnRelayPlainHash } from "../startup-warnings.js";

// api.md 4.1, 1.26.0: relay-plain-hash stays on by default. A self-hosted
// server with it on says once at startup what that costs.

function config(extra: Partial<Config>): Config {
  return { baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false, ...extra };
}

describe("relay-plain-hash startup warning", () => {
  it("warns once in selfhosted mode with the hash on, and when unset", () => {
    for (const extra of [{ relayPlainHash: "on" as const }, {}]) {
      const warn = vi.fn();
      warnRelayPlainHash(config({ mode: "selfhosted", ...extra }), warn);
      expect(warn).toHaveBeenCalledTimes(1);
      const text = String(warn.mock.calls[0]?.[0]);
      expect(text).toContain("guesses a topic name");
      expect(text).toContain("1.21.0");
    }
  });

  it("is silent with the hash off", () => {
    const warn = vi.fn();
    warnRelayPlainHash(config({ mode: "selfhosted", relayPlainHash: "off" }), warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent in relay and hosted mode", () => {
    for (const mode of ["relay", "hosted", undefined] as const) {
      const warn = vi.fn();
      warnRelayPlainHash(config({ ...(mode === undefined ? {} : { mode }), relayPlainHash: "on" }), warn);
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
