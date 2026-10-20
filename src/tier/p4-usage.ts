import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import { capsFor } from "./caps.js";
import type { Tier } from "./types.js";

// api.md §4.2. caps.p4_daily is counted across the whole account, per UTC day,
// in relay_p4_usage. This is the one place that checks the cap and charges it,
// for a publish on this server (ingress) and for a push a self-hosted server
// relays here. Check and charge run in one transaction, so two publishes
// cannot both take the last slot.
//
// True when the account was under its cap and has been charged one. False when
// it is at its cap, and nothing is charged.
export function chargeP4(db: Database.Database, clock: Clock, accountId: string): boolean {
  return db.transaction(() => {
    const account = db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: Tier } | undefined;
    const day = Math.floor(clock.now() / 86_400) * 86_400;
    const row = db.prepare("SELECT count FROM relay_p4_usage WHERE account_id = ? AND day_start = ?").get(accountId, day) as { count: number } | undefined;
    if ((row?.count ?? 0) >= capsFor(account?.tier ?? "free").p4_daily) return false;
    db.prepare("INSERT INTO relay_p4_usage (account_id, day_start, count) VALUES (?, ?, 1) ON CONFLICT(account_id, day_start) DO UPDATE SET count = count + 1").run(accountId, day);
    return true;
  }).immediate();
}
