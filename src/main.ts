import { serve } from "@hono/node-server";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createApp } from "./index.js";
import { ensureSelfHostedIdentity } from "./admin/credentials.js";
import { IncidentService } from "./incident/service.js";
import { startTimerScanner } from "./incident/scanner.js";
import { startHistoryPrune } from "./retention/prune.js";
import { openDatabase } from "./store/database.js";
import { migrate } from "./store/migrations.js";
import type { DeliveryEvent, IdGenerator } from "./incident/types.js";
import { ApnsSender } from "./push/apns.js";
import { FcmSender } from "./push/fcm.js";
import { PushDispatcher } from "./push/dispatcher.js";
import type { PushSender } from "./push/types.js";
import { RelayClient } from "./relay/client.js";
import { createAuthHandler } from "./auth/better-auth.js";
import { reconcileAccount, startReconcileSweep, type ReconcileDependencies } from "./tier/reconcile.js";

const config = loadConfig(process.env);
const db = openDatabase(join(config.dataDir, "critalarm.sqlite"));
migrate(db);
const identity = (config.mode ?? "relay") === "selfhosted" ? ensureSelfHostedIdentity(db) : undefined;
if (identity?.firstBoot) console.log(`admin token: ${identity.token}`);
const clock = { now: () => Math.floor(Date.now() / 1000) };
const ids: IdGenerator = { message: () => `m_${crypto.randomUUID()}`, incident: () => `inc_${crypto.randomUUID()}`, timer: () => `tm_${crypto.randomUUID()}` };
// 501, not 204. The dispatcher counts any 2xx as delivered, so a 2xx here
// booked every push to a platform with no provider configured as delivered
// when none had been sent. Before FCM was added to the dev server, every
// Android push was counted and none went out.
const noop: PushSender = { send: async () => ({ status: 501, stale: false }) };
const apnsSender = config.apns === undefined ? undefined : new ApnsSender({ ...config.apns, clock });
const apns: PushSender = apnsSender ?? noop;
const fcm = config.fcm === undefined ? noop : new FcmSender({ ...config.fcm, clock, fetch });
const dispatcher = new PushDispatcher(db, { apns, fcm, liveActivity: apnsSender }, clock);
const incidents = new IncidentService(db, clock, ids);
const relay = (config.mode ?? "relay") === "selfhosted" ? new RelayClient({ db, relayUrl: config.relayUrl, baseUrl: config.baseUrl, relayContent: config.relayContent, ...(config.relayRegistrationSecret === undefined ? {} : { registrationSecret: config.relayRegistrationSecret }) }) : undefined;
const dispatch = async (events: readonly DeliveryEvent[]) => {
  if (relay !== undefined) {
    try { await relay.forward(events); } catch (error: unknown) { console.error("relay forward failed", error); }
    return;
  }
  return dispatcher.dispatch(events);
};
// api.md §3.7. Undefined when no Apple or Google credential is configured, and
// that is the normal state today: the provider apps do not exist yet, so the
// server starts and serves everything else with no sign-in surface mounted.
const authHandler = (config.mode ?? "relay") === "selfhosted" ? undefined : createAuthHandler(config, db, clock);
// Guard 4: read entitlements back from RevenueCat instead of trusting the
// webhook. With no REVENUECAT_SECRET_API_KEY this schedules nothing and says
// nothing, which is the state every self-hosted server stays in.
const reconcile: ReconcileDependencies = { db, clock, fetch, ...(config.revenueCatApi === undefined ? {} : { revenueCatApi: config.revenueCatApi }) };
const stopReconcile = startReconcileSweep(reconcile);
// After a merge the surviving account holds billing ids it did not hold a
// moment ago. Reading those back is a network call, so it runs after the
// response rather than inside the merge transaction.
const reconcileAfterMerge = (accountId: string) => {
  void reconcileAccount(reconcile, accountId).catch((error: unknown) => { console.error("revenuecat reconcile failed", error); });
};
const app = createApp({ config, db, clock, ids, dispatch, reconcileAccount: reconcileAfterMerge, ...(authHandler === undefined ? {} : { authHandler }) });

await dispatch(incidents.scanDue());
const stop = startTimerScanner(incidents, dispatch, 250);
// api.md §4.2. Retention, on its own slower timer: the window moves by a day,
// so once an hour is enough. On a self-hosted server this starts nothing, and
// an unset mode is read as self-hosted so nothing is ever deleted by accident.
const stopPrune = startHistoryPrune(db, clock, config.mode ?? "selfhosted");
// One line per request, off unless asked for. Proving what the server did
// during device testing meant reading the SQLite file, because nothing was
// logged at all. Method, path, status and duration only: no tokens, no
// message bodies, no push tokens. Wrapped around fetch rather than added as
// Hono middleware, because middleware registered after the routes never runs.
const logRequests = process.env.LOG_REQUESTS === "true";
const handler: typeof app.fetch = logRequests
  ? async (request, ...rest) => {
      const startedAt = Date.now();
      const response = await app.fetch(request, ...rest);
      console.log(`${request.method} ${new URL(request.url).pathname} ${response.status} ${Date.now() - startedAt}ms`);
      return response;
    }
  : app.fetch;
serve({ fetch: handler, port: config.port });
const shutdown = () => { stop(); stopPrune(); stopReconcile(); apnsSender?.close(); db.close(); process.exit(0); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
