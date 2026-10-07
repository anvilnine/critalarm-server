import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { createApp } from "../index.js";
import { openDatabase } from "../store/database.js";
import { migrate } from "../store/migrations.js";
import { BillingReads } from "../tier/billing-reads.js";
import { PACK_IDS } from "../tier/packs.js";
import type { StoreReads, Tier } from "../tier/types.js";

afterEach(() => { vi.restoreAllMocks(); });

const NOW = 1_760_000_000;

function setup(options: { mode: NonNullable<Config["mode"]>; tier?: Tier; packIncludes?: Config["packIncludes"]; storeReads?: (db: ReturnType<typeof openDatabase>) => StoreReads }) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', ?, 1)").run(options.tier ?? "free");
  db.prepare("INSERT INTO devices (id, account_id, device_token_hash, platform, push_token, last_seen) VALUES ('dev_one', 'acc_1', ?, 'ios', 'x', 1)").run(createHash("sha256").update("dv_one").digest("hex"));
  const storeReads = options.storeReads?.(db);
  const app = createApp({
    config: { mode: options.mode, baseUrl: "https://alerts.example.com", relayUrl: "https://relay.example.com", relayContent: "none", listen: ":8080", port: 8080, dataDir: "/data", behindProxy: false, revenueCat: { sharedSecret: "rc-secret", entitlements: { ent_hosted: "hosted" } }, ...(options.packIncludes === undefined ? {} : { packIncludes: options.packIncludes }) },
    db,
    clock: { now: () => NOW },
    ids: { message: () => "m_1", incident: () => "inc_1", timer: () => "tm_1" },
    dispatch: async () => {},
    ...(storeReads === undefined ? {} : { storeReads }),
  });
  return { app, db };
}

const authorized = { headers: { Authorization: "Bearer dv_one" } };

describe("where the pack routes are served", () => {
  it("serves both on a relay and on a hosted server", async () => {
    for (const mode of ["relay", "hosted"] as const) {
      const { app } = setup({ mode });
      const read = await app.request("/relay/v1/packs", authorized);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ packs: [], checked_at: null });
      const refresh = await app.request("/relay/v1/packs/refresh", { method: "POST", ...authorized });
      expect(refresh.status).toBe(200);
      expect(await refresh.json()).toMatchObject({ confirmed: false, packs: [] });
    }
  });

  // api.md §4.2: a self-hosted server is not involved. A phone reads its packs
  // from the relay.
  it("serves neither on a self-hosted server", async () => {
    const { app } = setup({ mode: "selfhosted" });
    expect((await app.request("/relay/v1/packs", authorized)).status).toBe(404);
    expect((await app.request("/relay/v1/packs/refresh", { method: "POST", ...authorized })).status).toBe(404);
  });

  it("answers from the configured include map, whichever tier and pack it names", async () => {
    for (const tier of ["free", "relay", "hosted"] as const) {
      for (const pack of PACK_IDS) {
        const { app } = setup({ mode: "relay", tier, packIncludes: { [tier]: [pack] } });
        expect(await (await app.request("/relay/v1/packs", authorized)).json()).toEqual({ packs: [{ id: pack, expires_at: null }], checked_at: null });
      }
    }
  });

  it("hands the store reads through to the webhook", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const asked: string[] = [];
    const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ items: [{ entitlement_id: "ent_hosted", expires_at: null }] }), { status: 200 });
    }) as typeof globalThis.fetch;
    let reads: BillingReads | undefined;
    const { app, db } = setup({
      mode: "relay",
      storeReads: (database) => {
        reads = new BillingReads({ db: database, clock: { now: () => NOW }, fetch, api: { secretApiKey: "sk-fake-not-a-real-key", projectId: "proj_fake", entitlements: { ent_hosted: "hosted" }, packEntitlements: {} }, requestGapMs: 0 });
        return { mode: "on", reads };
      },
    });

    // The event says the plan expired. The store says it is live, and the store decides.
    const response = await app.request("/webhooks/revenuecat", { method: "POST", headers: { Authorization: "Bearer rc-secret", "content-type": "application/json" }, body: JSON.stringify({ event: { id: "evt_1", app_user_id: "acc_1", type: "EXPIRATION" } }) });
    await reads?.scan();

    expect(response.status).toBe(200);
    expect(asked).toEqual(["https://api.revenuecat.com/v2/projects/proj_fake/customers/acc_1/active_entitlements"]);
    expect(db.prepare("SELECT tier FROM accounts WHERE id = 'acc_1'").get()).toEqual({ tier: "hosted" });
  });
});
