import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import type { Tier } from "./types.js";

// api.md §4.2. A pack is an add-on an account holds beside its tier. This file
// is the one place that answers "which packs does this account hold now".
// Every reader goes through packsFor, so a pack is never worked out from the
// tier or from anything else at a call site.

export const PACK_IDS = ["pro"] as const;
export type PackId = (typeof PACK_IDS)[number];

export function isPackId(value: string): value is PackId {
  return (PACK_IDS as readonly string[]).includes(value);
}

export interface PackEntry {
  id: PackId;
  // Epoch seconds, or null when the pack has no end date.
  expires_at: number | null;
}

// Packs the relay's own configuration attaches to a tier. Empty unless the
// operator sets it.
export type PackIncludes = Partial<Record<Tier, readonly PackId[]>>;

// What a reader of packs has to be told. It is built once where the process
// is wired and handed to every reader, so the pack routes and the weekly check
// always answer by the same rules.
export interface PackRules {
  // Packs the configuration attaches to a tier. Absent means none.
  includes?: PackIncludes;
  // True only on a relay that reads the store and writes what it reads
  // (api.md §4.3, REVENUECAT_READS=on with an API key). Absent means false.
  storeReads?: boolean;
}

type Held = { pack: string; expires_at: number | null };

// Three sources, one answer: what the account's billing ids hold, what the
// operator granted, and what the configuration attaches to the account's tier.
//
// The two stored sources end in different ways.
//
//   store pack      on a relay that reads the store (rules.storeReads), ends
//                   when a read succeeds and no longer lists its entitlement.
//                   That read deletes the row. The saved end date alone ends
//                   nothing: api.md §4.3 says a failed read never removes a
//                   pack, and a renewal whose read failed leaves an old end
//                   date behind. So a store pack can be reported with an end
//                   date that has passed.
//
//                   On a relay that does not write what the store lists
//                   (reading off, shadow, or no API key) no read will ever
//                   delete the row, and no read failed either. There a store
//                   pack ends on its saved end date, like a grant. This is
//                   also what ends the packs of a relay that had reading on
//                   and switched it off.
//   operator grant  ends on its date. The clock is read here, on every call,
//                   so it ends on time with no second write and no read.
//
// One entry per pack: no end date wins over any end date, and otherwise the
// latest end is reported.
export function packsFor(db: Database.Database, clock: Clock, accountId: string, rules: PackRules = {}): PackEntry[] {
  const account = db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: Tier } | undefined;
  if (account === undefined) return [];
  const now = clock.now();
  const held = db
    .prepare(
      `SELECT p.pack AS pack, p.expires_at AS expires_at
         FROM billing_packs p JOIN account_billing_ids b ON b.app_user_id = p.app_user_id
        WHERE b.account_id = ? AND (? = 1 OR p.expires_at IS NULL OR p.expires_at > ?)
       UNION ALL
       SELECT pack, expires_at FROM account_pack_grants
        WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(accountId, rules.storeReads === true ? 1 : 0, now, accountId, now) as Held[];
  for (const pack of rules.includes?.[account.tier] ?? []) held.push({ pack, expires_at: null });

  const best = new Map<PackId, number | null>();
  for (const row of held) {
    if (!isPackId(row.pack)) continue;
    if (!best.has(row.pack)) {
      best.set(row.pack, row.expires_at);
      continue;
    }
    const current = best.get(row.pack) ?? null;
    if (current === null) continue;
    best.set(row.pack, row.expires_at === null ? null : Math.max(current, row.expires_at));
  }
  return PACK_IDS.filter((id) => best.has(id)).map((id) => ({ id, expires_at: best.get(id) ?? null }));
}

export function holdsPack(db: Database.Database, clock: Clock, accountId: string, pack: PackId, rules: PackRules = {}): boolean {
  return packsFor(db, clock, accountId, rules).some((entry) => entry.id === pack);
}

// api.md §4.2, checked_at: the oldest successful store read among the account's
// billing ids. Null when none has ever been read with success, which includes
// an account with no billing id.
export function packsCheckedAt(db: Database.Database, accountId: string): number | null {
  const row = db.prepare("SELECT MIN(checked_at) AS checked_at FROM account_billing_ids WHERE account_id = ? AND checked_at IS NOT NULL").get(accountId) as { checked_at: number | null };
  return row.checked_at;
}

// api.md §1.8. The answer of a route that needs a pack the account does not
// hold.
export function packRequired(pack: PackId): Response {
  return Response.json({ error: "pack", pack }, { status: 403 });
}
