import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../index.js";
import { IncidentService } from "../../incident/service.js";
import type { Clock, IdGenerator } from "../../incident/types.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
const clock: Clock = { now: () => 1000 }; const ids: IdGenerator = { message: () => "m_1", incident: () => "inc_1", timer: () => "tm_1" };
function app() { const db = openDatabase(":memory:"); migrate(db); db.prepare("INSERT INTO accounts (id,tier,created_at) VALUES ('a','free',1)").run(); db.prepare("INSERT INTO devices (id,account_id,device_token_hash,platform,push_token,last_seen) VALUES ('d','a',?,'ios','x',1)").run(createHash("sha256").update("dv_test").digest("hex")); return createApp({ config: { baseUrl:"https://alerts.example.com",relayUrl:"https://relay.critalarm.app",relayContent:"none",listen:":8080",port:8080,dataDir:"/data",behindProxy:false }, db, clock, ids, dispatch: async () => {} }); }
describe("V1 authentication", () => { it("accepts only a valid device token", async () => { const server=app(); expect((await server.request("/v1/topics")).status).toBe(401); expect((await server.request("/v1/topics",{headers:{Authorization:"Bearer ad_no"}})).status).toBe(401); expect((await server.request("/v1/topics",{headers:{Authorization:"Bearer dv_test"}})).status).toBe(200); }); });
