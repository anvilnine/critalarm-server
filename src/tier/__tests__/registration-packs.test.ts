import { describe, expect, it } from "vitest";
import { createTierRouter } from "../router.js";
import { database } from "./store-fakes.js";

// api.md §4.2: `packs` is on every registration response, beside `tier` and
// `caps`, and is [] when the account holds none.

const NOW = 1_700_000_000;
const first = { device_id: "dev_123e4567-e89b-12d3-a456-426614174000", platform: "ios", push_token: "apns-token", app_version: "1.0.0" } as const;
const second = { ...first, device_id: "dev_123e4567-e89b-12d3-a456-426614174001" };

function setup() {
  const db = database();
  let token = 0;
  const app = createTierRouter({ db, clock: { now: () => NOW }, ids: { account: () => "acc_1", deviceToken: () => { token += 1; return `dv_test_${token}`; }, accountJoinToken: () => "aj_test_1" } });
  const send = (method: string, path: string, body: unknown, bearer?: string) => app.request(path, { method, headers: { "content-type": "application/json", ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }) }, body: JSON.stringify(body) });
  const grant = () => { db.prepare("INSERT INTO account_pack_grants (account_id, pack, expires_at, reason, granted_at) VALUES ('acc_1', 'pro', ?, 'test', 1)").run(NOW + 900); };
  return { db, send, grant };
}

const HELD = [{ id: "pro", expires_at: NOW + 900 }];

describe("packs on the registration responses", () => {
  it("is an empty list on a first registration", async () => {
    const { send } = setup();
    const response = await send("POST", "/relay/v1/devices", first);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ account_id: "acc_1", tier: "free", packs: [] });
  });

  it("lists what the account holds when a known device registers again", async () => {
    const { send, grant } = setup();
    await send("POST", "/relay/v1/devices", first);
    grant();
    const response = await send("POST", "/relay/v1/devices", first, "dv_test_1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: "acc_1", packs: HELD });
  });

  it("lists what the account holds on a PATCH", async () => {
    const { send, grant } = setup();
    await send("POST", "/relay/v1/devices", first);
    grant();
    const response = await send("PATCH", `/relay/v1/devices/${first.device_id}`, { push_token: "new", app_version: "1.0.1" }, "dv_test_1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: "acc_1", packs: HELD });
  });

  it("lists what the account holds for a device that joins it", async () => {
    const { send, grant } = setup();
    await send("POST", "/relay/v1/devices", first);
    grant();
    const response = await send("POST", "/relay/v1/devices", second, "aj_test_1");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ account_id: "acc_1", device_token: "dv_test_2", packs: HELD });
  });
});
