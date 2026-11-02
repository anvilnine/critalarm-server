import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createTierRouter } from "../router.js";
import type { ProxyTrust } from "../../rate-limit.js";

// api.md §4.2: a POST /relay/v1/devices with no Authorization header is 20 per
// rolling 60 s and 200 per UTC day per client address.

const MIDNIGHT = 20_000 * 86_400;
const OVER = { code: 42901, http: 429, error: "rate limited" };
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } }) as never;

function setup(behindProxy: ProxyTrust = false) {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = { value: MIDNIGHT + 100, now() { return this.value; } };
  let account = 0;
  let token = 0;
  const app = createTierRouter({ db, clock, behindProxy, ids: { account: () => `acc_${++account}`, deviceToken: () => `dv_${++token}`, accountJoinToken: () => `aj_${account}` } });
  let device = 0;
  const create = (headers: Record<string, string> = {}, from = "192.0.2.1") => {
    device += 1;
    return app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ device_id: `dev_${String(device).padStart(8, "0")}-e89b-12d3-a456-426614174000`, platform: "ios", push_token: "aaaa0001", app_version: "1.0.0" }) }, peer(from));
  };
  const accounts = () => (db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number }).count;
  return { app, db, clock, create, accounts };
}

describe("anonymous account creation limit", () => {
  it("lets 20 calls through in 60 s, answers 42901 on the 21st and creates nothing for it", async () => {
    const { create, accounts, clock } = setup();
    for (let i = 0; i < 20; i += 1) expect((await create()).status).toBe(201);
    const over = await create();
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual(OVER);
    expect(accounts()).toBe(20);
    clock.value += 59;
    expect((await create()).status).toBe(429);
    expect(accounts()).toBe(20);
    clock.value += 1; // the first 20 calls are 60 s old and have left the window
    expect((await create()).status).toBe(201);
    expect(accounts()).toBe(21);
  });

  it("answers 42901 on the 201st call in a UTC day, and the count starts again at midnight", async () => {
    const { create, accounts, clock } = setup();
    // 10 minutes of 20 calls is 200 calls, none over the minute limit.
    for (let minute = 0; minute < 10; minute += 1) {
      clock.value = MIDNIGHT + 100 + minute * 60;
      for (let i = 0; i < 20; i += 1) expect((await create()).status).toBe(201);
    }
    expect(accounts()).toBe(200);
    clock.value = MIDNIGHT + 100 + 10 * 60; // a fresh minute window, still the same day
    const over = await create();
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual(OVER);
    expect(accounts()).toBe(200);
    clock.value = MIDNIGHT + 86_399;
    expect((await create()).status).toBe(429);
    clock.value = MIDNIGHT + 86_400;
    expect((await create()).status).toBe(201);
    expect(accounts()).toBe(201);
  });

  it("does not charge the day for a call the minute window refused", async () => {
    const { create, clock } = setup();
    for (let i = 0; i < 20; i += 1) await create();
    for (let i = 0; i < 300; i += 1) expect((await create()).status).toBe(429);
    clock.value += 60;
    expect((await create()).status).toBe(201);
  });

  it("does not count a call that carries a dv_ or an aj_", async () => {
    const { app, create, accounts, clock } = setup();
    const first = await create();
    const { device_token: deviceToken, account_join_token: joinToken } = await first.json() as { device_token: string; account_join_token: string };
    for (let i = 0; i < 19; i += 1) await create();
    expect((await create()).status).toBe(429);
    // The same device registers again with its dv_: an update, 200, not counted.
    const body = JSON.stringify({ device_id: "dev_00000001-e89b-12d3-a456-426614174000", platform: "ios", push_token: "bbbb0001", app_version: "1.0.1" });
    for (let i = 0; i < 25; i += 1) {
      const again = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${deviceToken}` }, body }, peer("192.0.2.1"));
      expect(again.status).toBe(200);
    }
    // A new device joining the account with its aj_: 201, not counted.
    for (let i = 0; i < 3; i += 1) {
      const joined = await app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${joinToken}` }, body: JSON.stringify({ device_id: `dev_9000000${i}-e89b-12d3-a456-426614174000`, platform: "android", push_token: "cccc0001", app_version: "1.0.0" }) }, peer("192.0.2.1"));
      expect(joined.status).toBe(201);
    }
    // Neither used up the anonymous window: it opens exactly when the 20 anonymous calls leave it.
    expect(accounts()).toBe(20);
    clock.value += 60;
    expect((await create()).status).toBe(201);
    // A wrong token is a 401 and is not counted either.
    for (let i = 0; i < 25; i += 1) expect((await create({ Authorization: "Bearer dv_wrong" })).status).toBe(401);
    expect((await create()).status).toBe(201);
  });

  it("counts per client address, the one behind-proxy names", async () => {
    const { app } = setup(1);
    const anonymous = (forwarded: string) => app.request("/relay/v1/devices", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": forwarded }, body: JSON.stringify({ device_id: "dev_00000000-e89b-12d3-a456-426614174000", platform: "ios", push_token: "aaaa0001", app_version: "1.0.0" }) }, peer("10.0.0.1"));
    for (let i = 0; i < 20; i += 1) expect((await anonymous(`198.51.100.${i}, 203.0.113.7`)).status).toBeLessThan(429);
    expect((await anonymous("198.51.100.99, 203.0.113.7")).status).toBe(429);
    expect((await anonymous("203.0.113.8")).status).toBeLessThan(429);
  });
});
