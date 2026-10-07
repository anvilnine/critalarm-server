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

type Held = { pack: string; expires_at: number | null };

// Three sources, one answer: what the account's billing ids hold, what the
// operator granted, and what the configuration attaches to the account's tier.
// The clock is read here, on every call, so a pack ends on time with no second
// write. One entry per pack: no end date wins over any end date, and otherwise
// the latest end is reported.
export function packsFor(db: Database.Database, clock: Clock, accountId: string, includes: PackIncludes = {}): PackEntry[] {
  const account = db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: Tier } | undefined;
  if (account === undefined) return [];
  const now = clock.now();
  const held = db
    .prepare(
      `SELECT p.pack AS pack, p.expires_at AS expires_at
         FROM billing_packs p JOIN account_billing_ids b ON b.app_user_id = p.app_user_id
        WHERE b.account_id = ? AND (p.expires_at IS NULL OR p.expires_at > ?)
       UNION ALL
       SELECT pack, expires_at FROM account_pack_grants
        WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(accountId, now, accountId, now) as Held[];
  for (const pack of includes[account.tier] ?? []) held.push({ pack, expires_at: null });

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

export function holdsPack(db: Database.Database, clock: Clock, accountId: string, pack: PackId, includes: PackIncludes = {}): boolean {
  return packsFor(db, clock, accountId, includes).some((entry) => entry.id === pack);
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
