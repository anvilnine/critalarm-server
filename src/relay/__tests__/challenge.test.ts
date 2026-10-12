import { describe, expect, it, vi } from "vitest";
import { createChallengeConfirmer } from "../challenge.js";

const challenge = "c".repeat(40);

describe("the challenge confirmer", () => {
  it("makes no request when a name resolves to a private address", async () => {
    const resolve = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    expect(await createChallengeConfirmer(resolve)("https://alerts.example.com", challenge)).toBe(false);
    expect(resolve).toHaveBeenCalledWith("alerts.example.com");
  });

  it("refuses when any one of several answers is not public", async () => {
    const resolve = async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
    expect(await createChallengeConfirmer(resolve)("https://alerts.example.com", challenge)).toBe(false);
  });

  it("refuses when the name does not resolve", async () => {
    const resolve = async (): Promise<{ address: string; family: number }[]> => { throw new Error("ENOTFOUND"); };
    expect(await createChallengeConfirmer(resolve)("https://alerts.example.com", challenge)).toBe(false);
  });

  it("refuses a base_url that breaks the rules without resolving it", async () => {
    const resolve = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    expect(await createChallengeConfirmer(resolve)("http://alerts.example.com", challenge)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});
