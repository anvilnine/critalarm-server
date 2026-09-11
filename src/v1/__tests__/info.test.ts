import { describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import { migrate } from "../../store/migrations.js";
import { openDatabase } from "../../store/database.js";

describe("V1 info", () => {
  it("does not require a credential", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const app = createApp({ config: { baseUrl: "https://alerts.example.com", relayUrl: "https://relay.critalarm.app", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false }, db, clock: { now: () => 1 }, ids: { message: () => "m", incident: () => "i", timer: () => "t" }, dispatch: async () => {} });
    expect((await app.request("/v1/info")).status).toBe(200);
  });
});
