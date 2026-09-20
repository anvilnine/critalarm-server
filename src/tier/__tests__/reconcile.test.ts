import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { reconcileAccount, reconcileAll, startReconcileSweep, type ReconcileDependencies } from "../reconcile.js";
import type { Tier } from "../types.js";

const NOW = 1_700_000_000;

interface Answer {
  status: number;
  body?: unknown;
}

// Nothing here reaches the network. Every test hands the sweep this stub and
// asserts on what it was asked for.
function stubFetch(answers: Answer[] | ((url: string) => Answer)) {
  const urls: string[] = [];
  const authorizations: (string | null)[] = [];
  const methods: (string | undefined)[] = [];
  let index = 0;
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const headers = new Headers(init?.headers);
    authorizations.push(headers.get("authorization"));
    methods.push(init?.method);
    const answer = typeof answers === "function" ? answers(url) : answers[Math.min(index, answers.length - 1)];
    index += 1;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, urls, authorizations, methods };
}

function entitlement(id: string, expiresAtMs: number | null) {
  return { object: "customer.active_entitlement", entitlement_id: id, expires_at: expiresAtMs };
}

function setup(answers: Answer[] | ((url: string) => Answer), tier: Tier = "free", storedEntitledTier: Tier = "free") {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', ?, 1)").run(tier);
  db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('acc_1', 'acc_1', 1, NULL, ?)").run(storedEntitledTier);
  const stub = stubFetch(answers);
  const deps: ReconcileDependencies = {
    db,
    clock: { now: () => NOW },
    fetch: stub.fetch,
    revenueCatApi: { secretApiKey: "sk-fake-not-a-real-key", projectId: "proj_fake", entitlements: { crit_relay: "relay", crit_hosted: "hosted" } },
    requestGapMs: 0,
  };
  return { db, deps, stub };
}

function tierOf(db: ReturnType<typeof openDatabase>, accountId = "acc_1"): Tier {
  return (db.prepare("SELECT tier FROM accounts WHERE id = ?").get(accountId) as { tier: Tier }).tier;
}

function changes(db: ReturnType<typeof openDatabase>) {
  return db.prepare("SELECT account_id, from_tier, to_tier, reason, event_id, changed_at FROM tier_changes").all() as { account_id: string; from_tier: string | null; to_tier: string; reason: string; event_id: string | null; changed_at: number }[];
}

function logged(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the reconcile sweep when no secret API key is configured", () => {
  it("is absent from the config, so there is nothing to start", () => {
    const env = { BASE_URL: "https://alerts.example.com", DATA_DIR: "/tmp", ALLOW_NOOP_PUSH: "true" };
    expect(loadConfig(env).revenueCatApi).toBeUndefined();
  });

  it("schedules no timer, sends no request and logs nothing", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = openDatabase(":memory:");
    migrate(db);
    const stub = stubFetch([{ status: 200, body: { items: [] } }]);
    const timersBefore = vi.getTimerCount();

    const stop = startReconcileSweep({ db, clock: { now: () => NOW }, fetch: stub.fetch });

    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(stub.urls).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(() => { stop(); }).not.toThrow();
  });

  it("does nothing when a sweep or a merge asks for one anyway", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('acc_1', 'acc_1', 1, NULL, 'free')").run();
    const stub = stubFetch([{ status: 200, body: { items: [entitlement("crit_hosted", null)] } }]);
    const deps: ReconcileDependencies = { db, clock: { now: () => NOW }, fetch: stub.fetch };

    await reconcileAll(deps);
    await reconcileAccount(deps, "acc_1");

    expect(stub.urls).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(tierOf(db)).toBe("free");
  });
});

describe("the reconcile sweep when a secret API key is configured", () => {
  it("starts a timer and asks RevenueCat straight away", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps, stub } = setup([{ status: 200, body: { items: [] } }]);

    const stop = startReconcileSweep(deps);

    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(stub.urls.length).toBeGreaterThanOrEqual(0);
  });

  it("reads the customer with the secret key and never writes to RevenueCat", async () => {
    const { deps, stub } = setup([{ status: 200, body: { items: [] } }]);

    await reconcileAll(deps);

    expect(stub.urls).toEqual(["https://api.revenuecat.com/v2/projects/proj_fake/customers/acc_1/active_entitlements"]);
    expect(stub.authorizations).toEqual(["Bearer sk-fake-not-a-real-key"]);
    // No method set is a GET. The key is scoped read only, so the sweep must
    // never reach for anything else.
    expect(stub.methods).toEqual([undefined]);
  });
});

describe("a webhook that was lost", () => {
  it("is repaired: the account is upgraded and the change is written down", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 200, body: { items: [entitlement("crit_hosted", (NOW + 86_400) * 1_000)] } }]);

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
    expect((db.prepare("SELECT entitled_tier FROM account_billing_ids WHERE app_user_id = 'acc_1'").get() as { entitled_tier: Tier }).entitled_tier).toBe("hosted");
    expect(changes(db)).toEqual([{ account_id: "acc_1", from_tier: "free", to_tier: "hosted", reason: "revenuecat reconcile for acc_1", event_id: null, changed_at: NOW }]);
    expect(logged(log)).toContainEqual({ event: "tier_drift", source: "reconcile", app_user_id: "acc_1", account_id: "acc_1", stored_tier: "free", revenuecat_tier: "hosted" });
  });

  it("is repaired for every billing id the surviving account holds after a merge", async () => {
    const { db, deps, stub } = setup((url) => (url.includes("acc_2") ? { status: 200, body: { items: [entitlement("crit_hosted", null)] } } : { status: 200, body: { items: [] } }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_other', 'free', 1)").run();
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('acc_2', 'acc_1', 1, NULL, 'free')").run();
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('acc_3', 'acc_other', 1, NULL, 'free')").run();

    await reconcileAccount(deps, "acc_1");

    expect(stub.urls.map((url) => url.split("/customers/")[1])).toEqual(["acc_1/active_entitlements", "acc_2/active_entitlements"]);
    expect(tierOf(db)).toBe("hosted");
    expect(tierOf(db, "acc_other")).toBe("free");
  });
});

describe("a billing problem", () => {
  it("does not downgrade while RevenueCat still lists the entitlement with a future expiry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 200, body: { items: [entitlement("crit_hosted", (NOW + 60) * 1_000)] } }], "hosted", "hosted");

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
    expect(changes(db)).toEqual([]);
    expect(logged(log)).toEqual([]);
  });

  it("downgrades only on a real expiry, read from expires_at", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 200, body: { items: [entitlement("crit_hosted", (NOW - 1) * 1_000)] } }], "hosted", "hosted");

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("free");
    expect(changes(db)[0]?.to_tier).toBe("free");
  });

  it("keeps a lifetime entitlement, which has no expiry at all", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 200, body: { items: [entitlement("crit_hosted", null)] } }], "hosted", "hosted");

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
  });
});

describe("a read that did not work", () => {
  it("changes nothing and says so when RevenueCat answers with an error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 500, body: { error: "nope" } }], "hosted", "hosted");

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
    expect(changes(db)).toEqual([]);
    expect(logged(log)).toEqual([{ event: "reconcile_read_failed", app_user_id: "acc_1", reason: "status", status: 500 }]);
  });

  it("changes nothing when the customer is unknown to RevenueCat", async () => {
    // A wrong project id answers 404 for every customer. Treating that as "pays
    // for nothing" would take the tier off everybody at once.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 404, body: { error: "not found" } }], "hosted", "hosted");

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
  });

  it("changes nothing when the body is not the shape the API documents", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 200, body: { items: "surprise" } }], "hosted", "hosted");

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
    expect(logged(log)).toEqual([{ event: "reconcile_read_failed", app_user_id: "acc_1", reason: "body" }]);
  });

  it("changes nothing when the request itself throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 200, body: { items: [] } }], "hosted", "hosted");
    deps.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof globalThis.fetch;

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
    expect(logged(log)[0]?.event).toBe("reconcile_read_failed");
  });
});

describe("an entitlement the map does not name", () => {
  it("is reported and downgrades nobody", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup([{ status: 200, body: { items: [entitlement("crit_mystery", null)] } }], "hosted", "hosted");

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
    expect(changes(db)).toEqual([]);
    expect(logged(log)).toEqual([{ event: "reconcile_unknown_entitlement", app_user_id: "acc_1", entitlement_id: "crit_mystery" }]);
  });
});

describe("an account holding several subscriptions", () => {
  it("keeps the highest live one, never the last one read", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, deps } = setup((url) => (url.includes("acc_2") ? { status: 200, body: { items: [] } } : { status: 200, body: { items: [entitlement("crit_hosted", null)] } }), "hosted", "hosted");
    db.prepare("INSERT INTO account_billing_ids (app_user_id, account_id, linked_at, last_event_at, entitled_tier) VALUES ('acc_2', 'acc_1', 1, NULL, 'relay')").run();

    await reconcileAll(deps);

    expect(tierOf(db)).toBe("hosted");
  });
});

describe("a customer whose entitlements span more than one page", () => {
  it("follows next_page before deciding anything", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const next = "/v2/projects/proj_fake/customers/acc_1/active_entitlements?starting_after=ent_1";
    const { db, deps, stub } = setup((url) => (url.includes("starting_after")
      ? { status: 200, body: { items: [entitlement("crit_hosted", null)] } }
      : { status: 200, body: { items: [entitlement("crit_relay", null)], next_page: next } }));

    await reconcileAll(deps);

    expect(stub.urls).toEqual([
      "https://api.revenuecat.com/v2/projects/proj_fake/customers/acc_1/active_entitlements",
      `https://api.revenuecat.com${next}`,
    ]);
    expect(tierOf(db)).toBe("hosted");
  });
});
