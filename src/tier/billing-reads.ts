import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "../incident/types.js";
import { readStore, viewEntitlements, type StoreAnswer, type StoreReadConfig } from "./entitlement-read.js";
import { highestEntitledTier, isHigherTier, resolveAccount } from "./revenuecat.js";
import type { Tier } from "./types.js";

// api.md §4.3. The read path: one read of a customer's active entitlements
// writes the tier that customer pays for and the packs it holds, in one
// transaction. This file is the only writer of either once reading is switched
// on, and it runs only then.
//
// Reads for one customer never cross. Two rules hold that, and every read goes
// through both whatever started it:
//
//   1. One in flight. A trigger that arrives while a read is running starts no
//      second one. It marks the customer dirty, and when the running read ends
//      exactly one more runs. This part is in memory, because the server is
//      one process.
//   2. A numbered fence. A read takes the next number for its customer when it
//      starts, and its result is written only if that number is above the
//      number of the last result written. This part is in the database, and it
//      is what covers a read that outlives the process that started it.
//
// A failed read writes nothing at all: not the tier, not a pack, not the fence.

export type ReadTrigger = "webhook" | "retry" | "refresh" | "sweep";

export interface BillingReadDependencies {
  db: Database.Database;
  clock: Clock;
  fetch: typeof globalThis.fetch;
  api: StoreReadConfig;
  // Milliseconds between two reads in one scan or one sweep.
  requestGapMs?: number;
  readTimeoutMs?: number;
}

// `ok` says the store was read with success. It says nothing about what the
// account holds.
export interface ReadOutcome {
  ok: boolean;
}

// RevenueCat v2 allows 480 Customer Information requests a minute. 250ms
// between reads asks at most 4 a second, the same pace as the reconcile sweep.
export const DEFAULT_REQUEST_GAP_MS = 250;

// Seconds to wait after the first, second, third and fourth failure. A fifth
// failure drops the queued read, and the daily read of every known customer
// picks the customer up again.
const RETRY_AFTER_S = [60, 300, 900, 3_600];

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function report(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

interface Flight {
  // Set when somebody is waiting for the one more read that follows this one.
  follow?: { promise: Promise<ReadOutcome>; resolve: (outcome: Promise<ReadOutcome>) => void; trigger: ReadTrigger };
}

type BillingRow = { account_id: string; entitled_tier: Tier; applied_seq: number };

export class BillingReads {
  private readonly flights = new Map<string, Flight>();
  // Numbers given to reads of a customer id that has no billing row yet, so
  // there is nowhere in the database to count them. When the row is made it
  // starts from this number. A read from before a restart cannot land for such
  // an id, because nothing but this process is waiting on it.
  private readonly unlinked = new Map<string, number>();
  private scanning: Promise<void> | undefined;
  private scanAgain = false;

  constructor(private readonly deps: BillingReadDependencies) {}

  // A read is due for this customer. Only the queue is written here, so this is
  // safe inside somebody else's transaction and it never waits on the network.
  enqueue(appUserId: string): void {
    if (this.flights.has(appUserId)) {
      this.markDirty(appUserId);
      return;
    }
    this.deps.db
      .prepare("INSERT INTO billing_reads (app_user_id, due_at, attempts, dirty) VALUES (?, ?, 0, 0) ON CONFLICT(app_user_id) DO UPDATE SET due_at = excluded.due_at, attempts = 0")
      .run(appUserId, this.deps.clock.now());
  }

  // Read this customer now and say whether the store could be read. When a
  // read is already running, no second one starts: the answer is that of the
  // one more read that follows it, so it is never older than this call.
  read(appUserId: string, trigger: ReadTrigger): Promise<ReadOutcome> {
    const flight = this.flights.get(appUserId);
    if (flight === undefined) return this.start(appUserId, trigger);
    this.markDirty(appUserId);
    if (flight.follow === undefined) {
      let resolve: (outcome: Promise<ReadOutcome>) => void = () => {};
      const promise = new Promise<ReadOutcome>((settle) => { resolve = settle; });
      flight.follow = { promise, resolve, trigger };
    }
    return flight.follow.promise;
  }

  // Run every queued read that is due. One scan at a time: a call that arrives
  // during a scan asks for one more pass after it.
  scan(): Promise<void> {
    if (this.scanning !== undefined) {
      this.scanAgain = true;
      return this.scanning;
    }
    const run = async (): Promise<void> => {
      do {
        this.scanAgain = false;
        await this.scanOnce();
      } while (this.scanAgain);
    };
    this.scanning = run().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  // The same scan, for a caller that does not wait: a webhook answers 200 once
  // the read is queued.
  wake(): void {
    void this.scan().catch((error: unknown) => { console.error("billing read scan failed", error); });
  }

  // The billing row an event or a read hangs its result on. A new row starts at
  // `free` and holds no pack. An existing row is repointed when its account was
  // merged into another one since.
  link(appUserId: string, accountId: string): void {
    const now = this.deps.clock.now();
    const existing = this.deps.db.prepare("SELECT account_id FROM account_billing_ids WHERE app_user_id = ?").get(appUserId) as { account_id: string } | undefined;
    if (existing === undefined) {
      this.deps.db
        .prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier, read_seq, applied_seq) VALUES (?, ?, ?, NULL, 'free', ?, 0)")
        .run(appUserId, accountId, now, this.unlinked.get(appUserId) ?? 0);
      this.unlinked.delete(appUserId);
      return;
    }
    if (existing.account_id !== accountId) this.deps.db.prepare("UPDATE account_billing_ids SET account_id = ? WHERE app_user_id = ?").run(accountId, appUserId);
  }

  private async scanOnce(): Promise<void> {
    const gap = this.deps.requestGapMs ?? DEFAULT_REQUEST_GAP_MS;
    // A dirty row with no read running is a trigger a dead process left behind.
    const due = this.deps.db
      .prepare("SELECT app_user_id, attempts FROM billing_reads WHERE due_at <= ? OR dirty = 1 ORDER BY due_at, app_user_id")
      .all(this.deps.clock.now()) as { app_user_id: string; attempts: number }[];
    let started = 0;
    for (const row of due) {
      // The running read reschedules or clears the row itself when it ends.
      if (this.flights.has(row.app_user_id)) continue;
      if (started > 0 && gap > 0) await sleep(gap);
      if (this.flights.has(row.app_user_id)) continue;
      started += 1;
      this.takeDirty(row.app_user_id);
      await this.start(row.app_user_id, row.attempts > 0 ? "retry" : "webhook");
    }
  }

  private start(appUserId: string, trigger: ReadTrigger): Promise<ReadOutcome> {
    const flight: Flight = {};
    this.flights.set(appUserId, flight);
    return this.once(appUserId, trigger)
      .catch((error: unknown): ReadOutcome => {
        // A bug or a database error, not an answer from the store. It counts as
        // a failed read, so nothing was written and nothing is lowered.
        console.error("billing read failed", error);
        return { ok: false };
      })
      .then((outcome) => {
        this.flights.delete(appUserId);
        // Exactly one more, however many triggers arrived. It starts here, in
        // the same turn the flight was cleared, so nothing can slip in between.
        const dirty = this.takeDirty(appUserId);
        if (dirty || flight.follow !== undefined) {
          const next = this.start(appUserId, flight.follow?.trigger ?? "webhook");
          flight.follow?.resolve(next);
        } else {
          // No read is out for this customer now, so no number is outstanding.
          this.unlinked.delete(appUserId);
        }
        return outcome;
      });
  }

  private async once(appUserId: string, trigger: ReadTrigger): Promise<ReadOutcome> {
    const seq = this.takeNumber(appUserId);
    const answer: StoreAnswer = await readStore(this.deps, appUserId);
    // The store answering "never seen" about a customer who holds a paid tier
    // or a pack is not believed. A wrong project id answers the same way for
    // every customer, and believing it would take every plan away at once.
    if (answer.ok && answer.status === 404 && this.holdsSomething(appUserId)) {
      report({ event: "billing_read_failed", app_user_id: appUserId, trigger, reason: "not found for a customer who holds a paid tier or a pack", status: 404 });
      this.failed(appUserId);
      return { ok: false };
    }
    if (!answer.ok) {
      report({ event: "billing_read_failed", app_user_id: appUserId, trigger, reason: answer.reason, status: answer.status });
      this.failed(appUserId);
      return { ok: false };
    }
    this.apply(appUserId, seq, answer.items, trigger);
    return { ok: true };
  }

  // The next number for this customer, one above the last one given.
  private takeNumber(appUserId: string): number {
    const row = this.deps.db.prepare("UPDATE account_billing_ids SET read_seq = read_seq + 1 WHERE app_user_id = ? RETURNING read_seq").get(appUserId) as { read_seq: number } | undefined;
    if (row !== undefined) return row.read_seq;
    const next = (this.unlinked.get(appUserId) ?? 0) + 1;
    this.unlinked.set(appUserId, next);
    return next;
  }

  private holdsSomething(appUserId: string): boolean {
    const row = this.deps.db.prepare("SELECT entitled_tier FROM account_billing_ids WHERE app_user_id = ?").get(appUserId) as { entitled_tier: Tier } | undefined;
    if (row === undefined) return false;
    if (row.entitled_tier !== "free") return true;
    return this.deps.db.prepare("SELECT 1 FROM billing_packs WHERE app_user_id = ? LIMIT 1").get(appUserId) !== undefined;
  }

  private markDirty(appUserId: string): void {
    this.deps.db
      .prepare("INSERT INTO billing_reads (app_user_id, due_at, attempts, dirty) VALUES (?, ?, 0, 1) ON CONFLICT(app_user_id) DO UPDATE SET dirty = 1")
      .run(appUserId, this.deps.clock.now());
  }

  private takeDirty(appUserId: string): boolean {
    return this.deps.db.prepare("UPDATE billing_reads SET dirty = 0 WHERE app_user_id = ? AND dirty = 1").run(appUserId).changes > 0;
  }

  // Only the queue moves. The tier, the packs, checked_at and the fence stay
  // exactly as they were.
  private failed(appUserId: string): void {
    this.deps.db.transaction(() => {
      const row = this.deps.db.prepare("SELECT attempts, dirty FROM billing_reads WHERE app_user_id = ?").get(appUserId) as { attempts: number; dirty: number } | undefined;
      // One more read is about to run for this customer, and its own result
      // decides what is queued next.
      if (row !== undefined && row.dirty === 1) return;
      const failures = (row?.attempts ?? 0) + 1;
      const wait = RETRY_AFTER_S[failures - 1];
      if (wait === undefined) {
        this.deps.db.prepare("DELETE FROM billing_reads WHERE app_user_id = ?").run(appUserId);
        return;
      }
      this.deps.db
        .prepare("INSERT INTO billing_reads (app_user_id, due_at, attempts, dirty) VALUES (?, ?, ?, 0) ON CONFLICT(app_user_id) DO UPDATE SET due_at = excluded.due_at, attempts = excluded.attempts")
        .run(appUserId, this.deps.clock.now() + wait, failures);
    })();
  }

  private apply(appUserId: string, seq: number, items: Parameters<typeof viewEntitlements>[0], trigger: ReadTrigger): void {
    const { db, clock } = this.deps;
    db.transaction(() => {
      const now = clock.now();
      const view = viewEntitlements(items, this.deps.api, now);
      let row = db.prepare("SELECT account_id, entitled_tier, applied_seq FROM account_billing_ids WHERE app_user_id = ?").get(appUserId) as BillingRow | undefined;
      if (row !== undefined && seq <= row.applied_seq) {
        report({ event: "billing_read_stale", app_user_id: appUserId, trigger, seq, applied_seq: row.applied_seq });
        return;
      }
      for (const unknown of view.unknownIds) report({ event: "billing_unknown_entitlement", app_user_id: appUserId, entitlement_id: unknown });

      const accountId = resolveAccount({ db }, appUserId);
      if (row === undefined) {
        // No account, so nothing to hang a result on. And a customer with
        // nothing live is not linked, so an account the store lists nothing for
        // gets no row.
        if (accountId === null || (view.tier === "free" && view.packs.size === 0)) {
          if (accountId === null) report({ event: "billing_read_unresolved", app_user_id: appUserId, trigger });
          db.prepare("DELETE FROM billing_reads WHERE app_user_id = ? AND dirty = 0").run(appUserId);
          return;
        }
        this.link(appUserId, accountId);
        row = { account_id: accountId, entitled_tier: "free", applied_seq: 0 };
      } else if (accountId !== null && accountId !== row.account_id) {
        this.link(appUserId, accountId);
        row = { ...row, account_id: accountId };
      }

      // An entitlement neither map names might be the one that pays for this
      // customer. A list that carries one may raise a tier and add a pack. It
      // may not lower a tier or remove a pack.
      const guarded = view.unknownIds.length > 0;
      const tier = guarded && isHigherTier(row.entitled_tier, view.tier) ? row.entitled_tier : view.tier;
      db.prepare("UPDATE account_billing_ids SET entitled_tier = ?, checked_at = ?, applied_seq = ?, read_seq = MAX(read_seq, ?) WHERE app_user_id = ?").run(tier, now, seq, seq, appUserId);

      for (const [pack, expiresAt] of view.packs) {
        db.prepare("INSERT INTO billing_packs (app_user_id, pack, expires_at) VALUES (?, ?, ?) ON CONFLICT(app_user_id, pack) DO UPDATE SET expires_at = excluded.expires_at").run(appUserId, pack, expiresAt);
      }
      if (!guarded) {
        const held = db.prepare("SELECT pack FROM billing_packs WHERE app_user_id = ?").all(appUserId) as { pack: string }[];
        for (const { pack } of held) {
          if (![...view.packs.keys()].some((listed) => listed === pack)) db.prepare("DELETE FROM billing_packs WHERE app_user_id = ? AND pack = ?").run(appUserId, pack);
        }
      }

      // The account's tier is the highest across its billing ids, the same
      // ranking the event path uses, so one customer lapsing does not take
      // down an account another one still pays for.
      const current = db.prepare("SELECT tier FROM accounts WHERE id = ?").get(row.account_id) as { tier: Tier } | undefined;
      if (current !== undefined) {
        const next = highestEntitledTier({ db }, row.account_id);
        if (next !== current.tier) {
          db.prepare("UPDATE accounts SET tier = ? WHERE id = ?").run(next, row.account_id);
          db.prepare("INSERT INTO tier_changes (id, account_id, from_tier, to_tier, reason, event_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(`tch_${randomUUID()}`, row.account_id, current.tier, next, `revenuecat read (${trigger}) for ${appUserId}`, null, now);
        }
      }

      // A retry queued for an older failure must not run again after this.
      db.prepare("DELETE FROM billing_reads WHERE app_user_id = ? AND dirty = 0").run(appUserId);
    })();
  }
}
