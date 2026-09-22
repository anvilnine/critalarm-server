import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import { capsFor } from "../tier/caps.js";
import type { Tier } from "../tier/types.js";
import type { ServerMode } from "./prune.js";

const day = 86_400;

// api.md §2 and §3.2. The oldest second a relay or hosted server answers with
// for this account. The prune runs hourly, so between runs there are rows on
// disk that are already outside the window; this hides them. Undefined on a
// self-hosted server, which has no window, and for an account that is gone.
export function historyCutoff(
  db: Database.Database,
  clock: Clock,
  mode: ServerMode,
  accountId: string,
): number | undefined {
  if (mode !== "hosted" && mode !== "relay") return undefined;
  const account = db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: Tier } | undefined;
  if (account === undefined) return undefined;
  return clock.now() - capsFor(account.tier).history_days * day;
}
