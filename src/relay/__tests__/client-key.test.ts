import { describe, expect, it } from "vitest";
import { clientKey } from "../../rate-limit.js";

describe("clientKey", () => {
  it.each([
    ["203.0.114.7", "203.0.114.7"],
    ["::ffff:203.0.114.7", "203.0.114.7"],
    ["::ffff:cb00:7207", "203.0.114.7"],
    ["2606:4700:1:2::1", "v6:2606:4700:1:2"],
    ["2606:4700:0001:0002:ffff:ffff:ffff:ffff", "v6:2606:4700:1:2"],
    ["2606:4700:1:2::1%eth0", "v6:2606:4700:1:2"],
    ["::1", "v6:0:0:0:0"],
  ])("keys %s as %s", (address, key) => { expect(clientKey(address)).toBe(key); });

  it("hashes anything that is not an address, to a short key", () => {
    const key = clientKey("x".repeat(10_000));
    expect(key).toMatch(/^h:[0-9a-f]{32}$/);
    expect(clientKey("x".repeat(10_000))).toBe(key);
    expect(clientKey("anonymous")).not.toBe(clientKey("anonymous2"));
  });
});
