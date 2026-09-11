import { describe, expect, it } from "vitest";
import { topicHash } from "../hash.js";

describe("relay topic hash", () => {
  it("hashes base URL slash topic exactly", () => {
    expect(topicHash("https://alerts.example.com", "prod")).toBe("64522a744e6392d6167cb88a2e39726b3f7e4c4b5ffecf49942015e600f0f167");
  });
});
