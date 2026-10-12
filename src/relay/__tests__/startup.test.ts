import { describe, expect, it } from "vitest";
import { runAfterListen } from "../startup.js";

describe("runAfterListen", () => {
  it("listens, then registers, then scans due timers", async () => {
    const order: string[] = [];
    await runAfterListen(
      (onListening) => { order.push("listen"); setTimeout(() => { order.push("listening"); onListening(); }, 0); },
      { register: async () => { order.push("register"); }, scanDue: async () => { order.push("scan"); } },
    );
    expect(order).toEqual(["listen", "listening", "register", "scan"]);
  });

  it("still scans when registration rejects, and does not throw", async () => {
    const order: string[] = [];
    await runAfterListen((onListening) => onListening(), { register: async () => { throw new Error("x"); }, scanDue: async () => { order.push("scan"); } });
    expect(order).toEqual(["scan"]);
  });

  it("scans with no relay client", async () => {
    const order: string[] = [];
    await runAfterListen((onListening) => onListening(), { scanDue: async () => { order.push("scan"); } });
    expect(order).toEqual(["scan"]);
  });
});
