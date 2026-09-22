import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import { capsFor } from "../tier/caps.js";
import type { Tier } from "../tier/types.js";

export type ServerMode = "selfhosted" | "relay" | "hosted";

export interface PruneResult {
  accounts: number;
  incidents: number;
  messages: number;
}

const day = 86_400;

// api.md §4.2. history_days is a retention window on a relay or hosted server:
// closed and expired incidents older than the owning account's window go, and
// so do their messages and any message with no incident. An open or acked
// incident is never deleted, whatever its age. A self-hosted server has no
// tiers and no plan, so it deletes nothing and there is no setting for it.
export function pruneHistory(db: Database.Database, clock: Clock, mode: ServerMode): PruneResult {
  if (mode !== "hosted" && mode !== "relay") return { accounts: 0, incidents: 0, messages: 0 };
  const now = clock.now();
  const accounts = db.prepare("SELECT id, tier FROM accounts").all() as { id: string; tier: Tier }[];
  const deleteMessages = db.prepare(
    `DELETE FROM messages
      WHERE created_at < ?
        AND topic_id IN (SELECT id FROM topics WHERE account_id = ?)
        AND (incident_id IS NULL OR incident_id IN (SELECT id FROM incidents WHERE state IN ('closed', 'expired')))`,
  );
  const deleteIncidents = db.prepare(
    `DELETE FROM incidents
      WHERE state IN ('closed', 'expired')
        AND opened_at < ?
        AND topic_id IN (SELECT id FROM topics WHERE account_id = ?)`,
  );
  let incidents = 0;
  let messages = 0;
  for (const account of accounts) {
    const cutoff = now - capsFor(account.tier).history_days * day;
    db.transaction(() => {
      messages += deleteMessages.run(cutoff, account.id).changes;
      incidents += deleteIncidents.run(cutoff, account.id).changes;
    })();
  }
  console.log(JSON.stringify({ event: "history_pruned", accounts: accounts.length, incidents, messages }));
  return { accounts: accounts.length, incidents, messages };
}

// Its own timer, next to the incident timer scanner and slower than it: the
// window moves by a day, so once an hour is plenty. The first run waits a
// minute so a boot is not competing with it.
export function startHistoryPrune(
  db: Database.Database,
  clock: Clock,
  mode: ServerMode,
  intervalMs = 3_600_000,
  firstRunMs = 60_000,
): () => void {
  if (mode !== "hosted" && mode !== "relay") return () => {};
  let repeat: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    try {
      pruneHistory(db, clock, mode);
    } catch (error: unknown) {
      console.error("history prune failed", error);
    }
  };
  const first = setTimeout(() => {
    run();
    repeat = setInterval(run, intervalMs);
  }, firstRunMs);
  return () => {
    clearTimeout(first);
    if (repeat !== undefined) clearInterval(repeat);
  };
}
