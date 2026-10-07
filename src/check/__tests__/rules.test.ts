import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccount } from "../../v1/accounts.js";
import { pruneCheckRounds } from "../../retention/prune.js";
import { roundAfter, slotAtOrAfter, slotFor } from "../schedule.js";
import { DAY, HOUR, T0, WEEK, type Harness, addAccount, addDevice, enrolled, grantPack, lastCheckId, removePack, setup } from "./fakes.js";

// One test per rule of api.md §4.5, named for the rule. The describe blocks
// follow the paragraphs of the section in order.

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const N1 = roundAfter("dev_a", T0);

// Lets a round close with no receipt.
async function missRound(harness: Harness, opensAt: number) {
  await harness.scanAt(opensAt);
  await harness.scanAt(opensAt + 6 * HOUR);
  await harness.scanAt(opensAt + 18 * HOUR);
  await harness.scanAt(opensAt + DAY);
}

describe("the check is never an alert", () => {
  it("opens no incident and stores no message when a check is sent and answered", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM incidents").get()).toEqual({ n: 0 });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(harness.sender.sent).toHaveLength(1);
    expect(Object.keys(harness.sender.sent[0]?.push ?? {}).sort()).toEqual(["attempt", "checkId"]);
  });
});

describe("all four routes take the device's own dv_", () => {
  const routes = (deviceId: string): [string, string, unknown?][] => [
    ["PUT", `/relay/v1/devices/${deviceId}/check`, { enabled: true }],
    ["GET", `/relay/v1/devices/${deviceId}/check`],
    ["POST", `/relay/v1/devices/${deviceId}/checks/chk_00000000000000000000000000000000/receipt`, {}],
    ["GET", `/relay/v1/devices/${deviceId}/checks`],
  ];

  it("answers 401 with no token and with a token no device holds", async () => {
    const harness = await enrolled();
    for (const [method, path, body] of routes("dev_a")) {
      expect((await harness.api.call(method, path, undefined, body)).status).toBe(401);
      expect((await harness.api.call(method, path, "dv_nobody", body)).status).toBe(401);
    }
  });

  it("answers 404 to another device's token, including another device on the same account", async () => {
    const harness = await enrolled();
    addDevice(harness.db, "dev_b", "acc_1");
    addAccount(harness.db, "acc_2");
    addDevice(harness.db, "dev_c", "acc_2");
    for (const other of ["dv_b", "dv_c"]) {
      for (const [method, path, body] of routes("dev_a")) {
        const response = await harness.api.call(method, path, other, body);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not found" });
      }
    }
    // Nothing of dev_a's changed because of those calls.
    expect((await harness.api.check("dev_a")).enabled).toBe(true);
  });

  it("each route reaches that one device's data and no other's", async () => {
    const harness = await enrolled();
    addDevice(harness.db, "dev_b", "acc_1");
    await harness.scanAt(T0);
    expect(await harness.api.rounds("dev_a")).toHaveLength(1);
    expect(await harness.api.rounds("dev_b")).toEqual([]);
    expect((await harness.api.check("dev_b")).enabled).toBe(false);
  });
});

describe("enrolling", () => {
  it("enabling without the pack answers 403 and names the pack", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1", { pack: false });
    addDevice(harness.db, "dev_a", "acc_1");
    const response = await harness.api.enable("dev_a");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "pack", pack: "pro" });
    expect((await harness.api.check("dev_a")).enabled).toBe(false);
    await harness.scanAt(T0 + WEEK);
    expect(harness.sender.sent).toEqual([]);
  });

  it("enabling with the pack answers 200 with the check", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    const response = await harness.api.enable("dev_a");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, state: "waiting", reason: null, misses: 0, last_sent_at: null, last_received_at: null, next_due_at: T0, notice_after: roundAfter("dev_a", T0) + DAY });
  });

  it("enabled:false stops the checks and always answers 200", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1", { pack: false });
    addDevice(harness.db, "dev_a", "acc_1");
    // Never enrolled, and no pack.
    const never = await harness.api.disable("dev_a");
    expect(never.status).toBe(200);
    expect(await never.json()).toMatchObject({ enabled: false, state: "off", reason: "disabled" });

    grantPack(harness.db, "acc_1");
    await harness.api.enable("dev_a");
    const off = await harness.api.disable("dev_a");
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, state: "off", reason: "disabled" });
    // Twice is the same answer.
    expect((await harness.api.disable("dev_a")).status).toBe(200);
    await harness.scanAt(T0 + 5 * WEEK);
    expect(harness.sender.sent).toEqual([]);
  });

  it("a device that never calls the route is never sent a check", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    addDevice(harness.db, "dev_b", "acc_1");
    await harness.api.enable("dev_a");
    for (let week = 0; week < 6; week += 1) {
      await harness.scanAt(T0 + week * WEEK);
      await harness.scanAt(T0 + week * WEEK + DAY);
    }
    expect(harness.sender.sent.length).toBeGreaterThan(0);
    expect(harness.sender.sent.every((sent) => sent.target.pushToken === "push-dev_a")).toBe(true);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_rounds WHERE device_id = 'dev_b'").get()).toEqual({ n: 0 });
  });

  it("a device is sent checks only while its account holds the pack", async () => {
    const harness = await enrolled();
    removePack(harness.db, "acc_1");
    await harness.scanAt(T0);
    expect(harness.sender.sent).toEqual([]);
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "off", reason: "pack" });
    // The pack comes back and the checks resume at the next round.
    grantPack(harness.db, "acc_1");
    await harness.scanAt(N1);
    expect(harness.sender.sent).toHaveLength(1);
  });

  it("no check goes out when the pack lapses between two attempts of a round", async () => {
    const harness = await enrolled();
    grantPack(harness.db, "acc_1", T0 + 2 * HOUR);
    await harness.scanAt(T0);
    expect(harness.sender.sent).toHaveLength(1);
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    await harness.scanAt(T0 + DAY);
    expect(harness.sender.sent).toHaveLength(1);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: "skipped", reason: "pack", closed_at: T0 + 6 * HOUR }]);
    expect((await harness.api.check("dev_a")).misses).toBe(0);
  });

  it("the first round opens within 24 hours of enrolling", async () => {
    const harness = await enrolled();
    // The device is due the moment it enrols, so the first scan opens it.
    expect(harness.store.due(100)).toEqual(["dev_a"]);
    await harness.scanAt(T0 + 60);
    const [round] = await harness.api.rounds("dev_a");
    expect(round?.opened_at).toBe(T0 + 60);
    expect((round?.opened_at ?? 0) - T0).toBeLessThan(DAY);
  });
});

describe("a round", () => {
  it("fixes closes_at 24 hours after it opens, and closes_at never changes", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0 + 100);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ opened_at: T0 + 100, closes_at: T0 + 100 + DAY, closed_at: null, result: null });
    await harness.scanAt(T0 + 100 + 6 * HOUR);
    await harness.scanAt(T0 + 100 + 18 * HOUR);
    expect((await harness.api.rounds("dev_a"))[0]?.closes_at).toBe(T0 + 100 + DAY);
    await harness.scanAt(T0 + 100 + 2 * DAY);
    expect((await harness.api.rounds("dev_a")).at(-1)).toMatchObject({ closes_at: T0 + 100 + DAY, closed_at: T0 + 100 + DAY, result: "missed" });
  });

  it("is up to three pushes, when it opens, 6 hours later and 18 hours later, with one check_id and attempts 1, 2 and 3", async () => {
    const harness = await enrolled();
    const times = [T0, T0 + 6 * HOUR - 1, T0 + 6 * HOUR, T0 + 18 * HOUR - 1, T0 + 18 * HOUR, T0 + 23 * HOUR, T0 + DAY];
    const counts: number[] = [];
    for (const time of times) {
      await harness.scanAt(time);
      counts.push(harness.sender.sent.length);
    }
    expect(counts).toEqual([1, 1, 2, 2, 3, 3, 3]);
    expect(harness.sender.sent.map((sent) => sent.push.attempt)).toEqual([1, 2, 3]);
    expect(new Set(harness.sender.sent.map((sent) => sent.push.checkId)).size).toBe(1);
    expect(lastCheckId(harness.sender)).toMatch(/^chk_[0-9a-f]{32}$/);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 3, result: "missed" });
  });

  it("the first counted receipt ends the round and no further push is sent", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    const response = await harness.api.receipt("dev_a", lastCheckId(harness.sender), { attempt: 1 });
    expect(await response.json()).toMatchObject({ counted: true });
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    await harness.scanAt(T0 + DAY);
    expect(harness.sender.sent).toHaveLength(1);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 1, result: "received", closed_at: T0 });
  });

  it("after its first round a device has a fixed moment in the week from its device_id, and rounds are 7 days apart", async () => {
    const harness = await enrolled();
    const opened: number[] = [];
    let due = T0;
    for (let round = 0; round < 4; round += 1) {
      await harness.scanAt(due);
      await harness.api.receipt("dev_a", lastCheckId(harness.sender));
      opened.push(due);
      due = (await harness.api.check("dev_a")).next_due_at ?? 0;
    }
    const slot = slotFor("dev_a");
    // The second round is on the device's slot, at least 3 days after the first.
    expect(opened[1]).toBe(slotAtOrAfter(slot, T0 + 3 * DAY));
    expect((opened[1] ?? 0) - T0).toBeGreaterThanOrEqual(3 * DAY);
    expect((opened[1] ?? 0) - T0).toBeLessThan(3 * DAY + WEEK);
    // From then on the same second of the week, 7 days apart.
    expect((opened[2] ?? 0) - (opened[1] ?? 0)).toBe(WEEK);
    expect((opened[3] ?? 0) - (opened[2] ?? 0)).toBe(WEEK);
    const rounds = await harness.api.rounds("dev_a");
    expect(rounds.map((round) => round.opened_at)).toEqual([...opened].reverse());
  });

  it("two devices may have the same moment, and both get their round", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    addDevice(harness.db, "dev_b", "acc_1");
    await harness.api.enable("dev_a");
    await harness.api.enable("dev_b");
    // Put both on the same due second, as two devices with one slot would be.
    harness.db.prepare("UPDATE device_checks SET next_due_at = ?, next_attempt_at = ?").run(T0 + 500, T0 + 500);
    await harness.scanAt(T0 + 500);
    expect(harness.sender.sent.map((sent) => sent.target.pushToken)).toEqual(["push-dev_a", "push-dev_b"]);
    expect(harness.sender.sent[0]?.push.checkId).not.toBe(harness.sender.sent[1]?.push.checkId);
  });

  it("next_due_at is when the next round is due", async () => {
    const harness = await enrolled();
    expect((await harness.api.check("dev_a")).next_due_at).toBe(T0);
    await harness.scanAt(T0);
    // While a round is open it names the round after it.
    expect((await harness.api.check("dev_a")).next_due_at).toBe(N1);
    const receipt = await (await harness.api.receipt("dev_a", lastCheckId(harness.sender))).json() as { next_due_at: number };
    expect(receipt.next_due_at).toBe(N1);
    await harness.scanAt(N1 - 1);
    expect(harness.sender.sent).toHaveLength(1);
    await harness.scanAt(N1);
    expect(harness.sender.sent).toHaveLength(2);
    expect((await harness.api.check("dev_a")).next_due_at).toBe(N1 + WEEK);
  });
});

describe("when more devices are due than the relay sends at once", () => {
  it("the oldest due goes first and none is skipped", async () => {
    const harness = setup({ batch: 3 });
    addAccount(harness.db, "acc_1");
    const ids = ["dev_a", "dev_b", "dev_c", "dev_d", "dev_e", "dev_f", "dev_g"];
    for (const id of ids) {
      addDevice(harness.db, id, "acc_1");
      await harness.api.enable(id);
    }
    // dev_g has waited longest, dev_a least. dev_c and dev_d are tied and go by id.
    const dueAt: Record<string, number> = { dev_g: T0 - 600, dev_f: T0 - 500, dev_e: T0 - 400, dev_d: T0 - 300, dev_c: T0 - 300, dev_b: T0 - 200, dev_a: T0 - 100 };
    for (const [id, at] of Object.entries(dueAt)) harness.db.prepare("UPDATE device_checks SET next_due_at = ?, next_attempt_at = ? WHERE device_id = ?").run(at, at, id);

    const order = () => harness.sender.sent.map((sent) => sent.target.pushToken.replace("push-", ""));
    expect(await harness.scanAt(T0)).toBe(3);
    expect(order()).toEqual(["dev_g", "dev_f", "dev_e"]);
    expect(await harness.scanAt(T0 + 60)).toBe(3);
    expect(order()).toEqual(["dev_g", "dev_f", "dev_e", "dev_c", "dev_d", "dev_b"]);
    expect(await harness.scanAt(T0 + 120)).toBe(1);
    expect(order()).toEqual(["dev_g", "dev_f", "dev_e", "dev_c", "dev_d", "dev_b", "dev_a"]);
    expect(await harness.scanAt(T0 + 180)).toBe(0);
  });

  it("a round that opens later than next_due_at is not dropped and runs for its own 24 hours", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    // The relay gets to it 3 weeks and 5 hours late. One round opens, not three.
    const late = N1 + 3 * WEEK + 5 * HOUR;
    await harness.scanAt(late);
    expect(harness.sender.sent).toHaveLength(2);
    const [round] = await harness.api.rounds("dev_a");
    expect(round).toMatchObject({ opened_at: late, closes_at: late + DAY, result: null });
    await harness.scanAt(late + 6 * HOUR);
    expect(harness.sender.sent).toHaveLength(3);
    await harness.scanAt(late + DAY - 1);
    expect((await harness.api.rounds("dev_a"))[0]?.result).toBeNull();
    // The round after it is back on the device's moment in the week.
    expect((await harness.api.check("dev_a")).next_due_at).toBe(roundAfter("dev_a", late));
  });
});

describe("an attempt is recorded before it is sent", () => {
  it("has the attempt on record at the moment the push leaves", async () => {
    const harness = await enrolled();
    const seen: unknown[] = [];
    harness.sender.reply = () => {
      seen.push(harness.db.prepare("SELECT r.attempts, a.attempt, a.recorded_at, a.outcome FROM check_rounds r JOIN check_attempts a ON a.round_id = r.id").all());
      return { outcome: "accepted", status: 200 };
    };
    await harness.scanAt(T0);
    expect(seen).toEqual([[{ attempts: 1, attempt: 1, recorded_at: T0, outcome: null }]]);
    expect(harness.db.prepare("SELECT attempt, outcome, status FROM check_attempts").all()).toEqual([{ attempt: 1, outcome: "accepted", status: 200 }]);
  });

  it("a second copy of the same push is answered by one receipt and is harmless", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    const checkId = lastCheckId(harness.sender);
    const first = await harness.api.receipt("dev_a", checkId, { attempt: 1 });
    const second = await harness.api.receipt("dev_a", checkId, { attempt: 1 });
    expect(await second.json()).toEqual(await first.json());
    expect(harness.counters.read().totals.checks_received).toBe(1);
  });
});

describe("a closed round stays closed", () => {
  it("closes when a receipt is counted", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + 40;
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "received", closed_at: T0 + 40 });
  });

  it("closes when the relay's clock reaches closes_at, even before the scan gets there", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + DAY - 1;
    expect((await harness.api.rounds("dev_a"))[0]?.result).toBeNull();
    harness.clock.value = T0 + DAY;
    // No scan has run. Reading is enough to see it closed, at its own close time.
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "missed", closed_at: T0 + DAY });
  });

  it("writes its result once, and a late receipt does not reopen it", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    const before = (await harness.api.rounds("dev_a"))[0];
    harness.clock.value = T0 + DAY + 5;
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    const after = (await harness.api.rounds("dev_a"))[0];
    expect(after).toEqual({ ...before, late_receipt_at: T0 + DAY + 5 });
    expect(after?.result).toBe("missed");
  });

  it("a change to the relay's clock does not reopen it", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    const closed = (await harness.api.rounds("dev_a"))[0];
    // Back to a moment when the round was still open.
    await harness.scanAt(T0 + HOUR);
    await harness.scanAt(T0 + 7 * HOUR);
    expect(harness.sender.sent).toHaveLength(3);
    expect(await harness.api.rounds("dev_a")).toEqual([closed]);
    // A receipt at that moment is late all the same.
    const response = await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    expect(await response.json()).toMatchObject({ counted: false });
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "missed", closed_at: T0 + DAY, late_receipt_at: T0 + 7 * HOUR });
    expect((await harness.api.check("dev_a")).misses).toBe(1);
  });
});

describe("the receipt", () => {
  it("check_id is in the push and nowhere else: no route returns it and rounds have a different id", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    const checkId = lastCheckId(harness.sender);
    const bodies = [
      await (await harness.api.call("GET", "/relay/v1/devices/dev_a/check", "dv_a")).text(),
      await (await harness.api.call("GET", "/relay/v1/devices/dev_a/checks", "dv_a")).text(),
      await (await harness.api.receipt("dev_a", checkId)).text(),
      await (await harness.api.enable("dev_a")).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toContain(checkId);
      expect(body).not.toContain("chk_");
    }
    const [round] = await harness.api.rounds("dev_a");
    expect(round?.id).toMatch(/^rnd_/);
    expect(Object.keys(round ?? {}).sort()).toEqual(["attempt_received", "attempts", "closed_at", "closes_at", "device_received_at", "id", "late_receipt_at", "opened_at", "reason", "receipt_at", "result"]);
    // A round's own id is not a check_id.
    expect((await harness.api.receipt("dev_a", round?.id ?? "")).status).toBe(404);
  });

  it("counts when it reaches the relay while its round is open, by the relay's clock", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + DAY - 1;
    const response = await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counted: true, next_due_at: N1, notice_after: N1 + WEEK + DAY });
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "received", receipt_at: T0 + DAY - 1, closed_at: T0 + DAY - 1 });
  });

  it("a round that closed as missed stays missed: a receipt after the close is recorded in late_receipt_at and answers counted false", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    // Exactly at closes_at is already too late, with no scan in between.
    harness.clock.value = T0 + DAY;
    const response = await harness.api.receipt("dev_a", lastCheckId(harness.sender), { attempt: 1, received_at: T0 + 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ counted: false });
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "missed", closed_at: T0 + DAY, late_receipt_at: T0 + DAY, receipt_at: null, device_received_at: null, attempt_received: null });
    expect(harness.counters.read().totals.checks_received).toBe(0);
  });

  it("sending the same receipt twice gives the same answer both times and changes nothing the second time", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    const checkId = lastCheckId(harness.sender);
    harness.clock.value = T0 + 10;
    const first = await (await harness.api.receipt("dev_a", checkId, { attempt: 1, received_at: T0 + 4 })).json();
    const rows = () => JSON.stringify([harness.db.prepare("SELECT * FROM check_rounds").all(), harness.db.prepare("SELECT * FROM device_checks").all(), harness.db.prepare("SELECT * FROM counters").all()]);
    const before = rows();
    harness.clock.value = T0 + 500;
    const second = await (await harness.api.receipt("dev_a", checkId, { attempt: 3, received_at: 1 })).json();
    expect(second).toEqual(first);
    expect(rows()).toBe(before);

    // The same holds for a late one.
    await missRound(harness, N1);
    const lateId = lastCheckId(harness.sender);
    harness.clock.value = N1 + DAY + 1;
    const lateFirst = await (await harness.api.receipt("dev_a", lateId)).json();
    const lateBefore = rows();
    harness.clock.value = N1 + DAY + 99;
    expect(await (await harness.api.receipt("dev_a", lateId)).json()).toEqual(lateFirst);
    expect(rows()).toBe(lateBefore);
  });

  it("answers 404 when this device has no such check", async () => {
    const harness = await enrolled();
    addDevice(harness.db, "dev_b", "acc_1");
    await harness.api.enable("dev_b");
    await harness.scanAt(T0);
    const forA = harness.sender.sent.find((sent) => sent.target.pushToken === "push-dev_a")?.push.checkId ?? "";
    for (const checkId of ["chk_00000000000000000000000000000000", "nonsense", "chk_"]) {
      const response = await harness.api.receipt("dev_a", checkId);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
    // dev_b holds a valid token and a check_id that belongs to dev_a's round.
    const response = await harness.api.receipt("dev_b", forA);
    expect(response.status).toBe(404);
    expect((await harness.api.rounds("dev_a"))[0]?.result).toBeNull();
  });
});

describe("received_at and attempt are notes", () => {
  it("received_at is stored as device_received_at and used for nothing", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    // A device clock inside the round does not move a late receipt into it.
    harness.clock.value = T0 + DAY + 10;
    const late = await harness.api.receipt("dev_a", lastCheckId(harness.sender), { received_at: T0 + 5 });
    expect(await late.json()).toMatchObject({ counted: false });
    expect((await harness.api.rounds("dev_a"))[0]?.result).toBe("missed");

    // A device clock far outside the round does not stop a receipt counting.
    await harness.scanAt(N1);
    const counted = await harness.api.receipt("dev_a", lastCheckId(harness.sender), { received_at: 12 });
    expect(await counted.json()).toMatchObject({ counted: true });
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "received", receipt_at: N1, device_received_at: 12 });
  });

  it("attempt is stored as attempt_received only when it is a whole number from 1 to the attempts on record, and null otherwise", async () => {
    const cases: [unknown, number | null][] = [[1, 1], [2, 2], [3, null], [0, null], [-1, null], [1.5, null], ["2", null], [null, null], [undefined, null], [true, null]];
    for (const [attempt, stored] of cases) {
      const harness = await enrolled();
      await harness.scanAt(T0);
      await harness.scanAt(T0 + 6 * HOUR);
      // Two attempts are on record.
      const response = await harness.api.receipt("dev_a", lastCheckId(harness.sender), attempt === undefined ? {} : { attempt });
      expect(await response.json()).toMatchObject({ counted: true });
      expect((await harness.api.rounds("dev_a"))[0]?.attempt_received).toBe(stored);
    }
  });

  it("neither field can make a receipt count, stop it counting or cause an error", async () => {
    const bodies: unknown[] = [undefined, "not json", "[]", "null", "7", { attempt: "x", received_at: "y" }, { attempt: {}, received_at: [] }, { received_at: 1e40 }, { received_at: -5.5 }];
    for (const body of bodies) {
      const harness = await enrolled();
      await harness.scanAt(T0);
      const response = await harness.api.receipt("dev_a", lastCheckId(harness.sender), body);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ counted: true });
      expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ result: "received", attempt_received: null, device_received_at: null });
    }
  });
});

describe("result of a round", () => {
  it("received: a receipt reached the relay while the round was open", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + 4;
    await harness.api.receipt("dev_a", lastCheckId(harness.sender), { attempt: 1, received_at: T0 + 3 });
    expect(await harness.api.rounds("dev_a")).toEqual([{ id: expect.stringMatching(/^rnd_/), opened_at: T0, closes_at: T0 + DAY, closed_at: T0 + 4, attempts: 1, result: "received", attempt_received: 1, receipt_at: T0 + 4, device_received_at: T0 + 3, late_receipt_at: null, reason: null }]);
  });

  it("missed: the round closed with no receipt", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    expect(await harness.api.rounds("dev_a")).toEqual([{ id: expect.stringMatching(/^rnd_/), opened_at: T0, closes_at: T0 + DAY, closed_at: T0 + DAY, attempts: 3, result: "missed", attempt_received: null, receipt_at: null, device_received_at: null, late_receipt_at: null, reason: null }]);
  });

  it("refused: the provider refused the device's push token, and the round ends there", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(T0);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 1, result: "refused", closed_at: T0, reason: null });
    await harness.scanAt(T0 + 6 * HOUR);
    await harness.scanAt(T0 + 18 * HOUR);
    expect(harness.sender.sent).toHaveLength(1);
    // The check touched neither the device's token nor anything else of it.
    expect(harness.db.prepare("SELECT push_token, apns_environment FROM devices WHERE id = 'dev_a'").get()).toEqual({ push_token: "push-dev_a", apns_environment: null });
  });

  it("an answer that is neither an acceptance nor a refused token uses the attempt and leaves the round open", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "failed", status: 503 });
    await harness.scanAt(T0);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 1, result: null });
    harness.sender.reply = () => { throw new Error("socket hang up"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await harness.scanAt(T0 + 6 * HOUR);
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ attempts: 2, result: null });
    expect((await harness.api.check("dev_a")).last_sent_at).toBeNull();
  });

  it("skipped with reason pack: nothing was sent, and it is not counted as a miss", async () => {
    const harness = await enrolled();
    removePack(harness.db, "acc_1");
    await harness.scanAt(T0);
    await harness.scanAt(N1);
    grantPack(harness.db, "acc_1");
    expect(harness.sender.sent).toEqual([]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 0, result: "skipped", reason: "pack", opened_at: N1 }, { attempts: 0, result: "skipped", reason: "pack", opened_at: T0 }]);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "waiting", misses: 0 });
  });

  it("skipped with reason no_token: nothing was sent, and it is not counted as a miss", async () => {
    const harness = await enrolled();
    harness.db.prepare("UPDATE devices SET push_token = '' WHERE id = 'dev_a'").run();
    await harness.scanAt(T0);
    expect(harness.sender.sent).toEqual([]);
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 0, result: "skipped", reason: "no_token" }]);
    expect((await harness.api.check("dev_a")).misses).toBe(0);
  });

  it("skipped with reason disabled: a round open when the device switches off is not counted as a miss", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    harness.clock.value = T0 + HOUR;
    await harness.api.disable("dev_a");
    expect(await harness.api.rounds("dev_a")).toMatchObject([{ attempts: 1, result: "skipped", reason: "disabled", closed_at: T0 + HOUR }]);
    await harness.scanAt(T0 + 6 * HOUR);
    expect(harness.sender.sent).toHaveLength(1);
    expect((await harness.api.check("dev_a")).misses).toBe(0);
    // Switching back on keeps the schedule. It does not make the device due.
    await harness.api.enable("dev_a");
    await harness.scanAt(T0 + 7 * HOUR);
    expect(harness.sender.sent).toHaveLength(1);
    expect((await harness.api.check("dev_a")).next_due_at).toBe(N1);
  });
});

describe("state", () => {
  it("waiting: enrolled, and no round has closed yet", async () => {
    const harness = await enrolled();
    expect((await harness.api.check("dev_a")).state).toBe("waiting");
    await harness.scanAt(T0);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "waiting", reason: null, last_sent_at: T0 });
  });

  it("received: the last closed round was received", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    await harness.scanAt(N1);
    harness.clock.value = N1 + 9;
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "received", misses: 0, last_received_at: N1 + 9, last_sent_at: N1 });
  });

  it("missed_once: the last closed round was missed, and the one before it was not", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "missed_once", misses: 1 });
    // After a received round, a miss is one miss again.
    await harness.scanAt(N1);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    await missRound(harness, N1 + WEEK);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "missed_once", misses: 1 });
  });

  it("missed_repeatedly: the last two or more closed rounds were missed or refused", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    await missRound(harness, N1);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "missed_repeatedly", misses: 2 });
    // A refused round after two misses keeps the run going.
    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(N1 + WEEK);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "missed_repeatedly", misses: 3 });
  });

  it("missed_repeatedly: a missed round straight after a refused one", async () => {
    const harness = await enrolled();
    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(T0);
    harness.sender.reply = () => ({ outcome: "accepted", status: 200 });
    await missRound(harness, N1);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "missed_repeatedly", misses: 2 });
  });

  it("token_refused: the last closed round was refused, and the one before it was not", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(N1);
    expect(await harness.api.check("dev_a")).toMatchObject({ state: "token_refused", misses: 1 });
  });

  it("no_token: the relay holds no push token for the device", async () => {
    const harness = await enrolled();
    harness.db.prepare("UPDATE devices SET push_token = '' WHERE id = 'dev_a'").run();
    harness.db.prepare("DELETE FROM device_tokens WHERE device_id = 'dev_a'").run();
    expect(await harness.api.check("dev_a")).toMatchObject({ enabled: true, state: "no_token", reason: null });
  });

  it("off with reason disabled: not enrolled", async () => {
    const harness = setup();
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    expect(await harness.api.check("dev_a")).toEqual({ enabled: false, state: "off", reason: "disabled", misses: 0, last_sent_at: null, last_received_at: null, next_due_at: null, notice_after: null });
  });

  it("off with reason pack: the account no longer holds the pack", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    removePack(harness.db, "acc_1");
    expect(await harness.api.check("dev_a")).toEqual({ enabled: true, state: "off", reason: "pack", misses: 0, last_sent_at: T0, last_received_at: T0, next_due_at: null, notice_after: null });
  });
});

describe("misses", () => {
  it("is how many closed rounds in a row were missed or refused, and skipped rounds change nothing", async () => {
    const harness = await enrolled();
    const misses = async () => (await harness.api.check("dev_a")).misses;
    await missRound(harness, T0);
    expect(await misses()).toBe(1);
    // A skipped round between two misses neither adds to the run nor ends it.
    removePack(harness.db, "acc_1");
    await harness.scanAt(N1);
    grantPack(harness.db, "acc_1");
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, state: "missed_once" });
    harness.sender.reply = () => ({ outcome: "refused", status: 410 });
    await harness.scanAt(N1 + WEEK);
    expect(await misses()).toBe(2);
    // A received round ends the run.
    harness.sender.reply = () => ({ outcome: "accepted", status: 200 });
    await harness.scanAt(N1 + 2 * WEEK);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    expect(await misses()).toBe(0);
  });
});

describe("notice_after", () => {
  it("is the second at which the device will have missed two rounds in a row if no check arrives from now on", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    // A round is open and nothing is missed yet: this round, then the next.
    expect((await harness.api.check("dev_a")).notice_after).toBe(N1 + DAY);
    const receipt = await (await harness.api.receipt("dev_a", lastCheckId(harness.sender))).json() as { notice_after: number; next_due_at: number };
    // Just answered: the next two rounds would have to close unanswered.
    expect(receipt.notice_after).toBe(N1 + WEEK + DAY);
    expect(receipt.notice_after - receipt.next_due_at).toBe(8 * DAY);

    // Let exactly those two rounds go by, and the second closes on that second.
    await missRound(harness, N1);
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, notice_after: N1 + WEEK + DAY });
    await harness.scanAt(N1 + WEEK);
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 1, notice_after: N1 + WEEK + DAY });
    await harness.scanAt(N1 + WEEK + DAY);
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 2, state: "missed_repeatedly", notice_after: N1 + WEEK + DAY });
    // It stays on the second the run reached two.
    await missRound(harness, N1 + 2 * WEEK);
    expect(await harness.api.check("dev_a")).toMatchObject({ misses: 3, notice_after: N1 + WEEK + DAY });
  });
});

describe("when a device is released", () => {
  it("its check state and its rounds go with it, and a round open at that moment counts toward nothing", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    await harness.scanAt(N1);
    const openId = lastCheckId(harness.sender);
    const countersBefore = JSON.stringify(harness.counters.read().totals);
    const response = await harness.api.call("DELETE", "/relay/v1/devices/dev_a", "dv_a");
    expect(response.status).toBe(204);
    for (const table of ["device_checks", "check_rounds", "check_attempts"]) expect(harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(JSON.stringify(harness.counters.read().totals)).toBe(countersBefore);
    // Nothing more is sent, and the old receipt has nowhere to land.
    await harness.scanAt(N1 + 6 * HOUR);
    await harness.scanAt(N1 + DAY);
    expect(harness.sender.sent).toHaveLength(4);
    expect((await harness.api.receipt("dev_a", openId)).status).toBe(401);
  });

  it("a push that was on its way when the device was released is recorded nowhere", async () => {
    const harness = await enrolled();
    harness.sender.reply = async () => {
      await harness.api.call("DELETE", "/relay/v1/devices/dev_a", "dv_a");
      return { outcome: "accepted", status: 200 };
    };
    await harness.scanAt(T0);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_rounds").get()).toEqual({ n: 0 });
    expect(harness.counters.read().totals.checks_sent).toBe(0);
  });

  it("a device that registers again under a new device_id has no check state and no misses, and enrols again", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    await harness.api.call("DELETE", "/relay/v1/devices/dev_a", "dv_a");
    addDevice(harness.db, "dev_b", "acc_1");
    expect(await harness.api.check("dev_b")).toEqual({ enabled: false, state: "off", reason: "disabled", misses: 0, last_sent_at: null, last_received_at: null, next_due_at: null, notice_after: null });
    expect(await harness.api.rounds("dev_b")).toEqual([]);
    await harness.scanAt(T0 + 2 * WEEK);
    expect(harness.sender.sent.every((sent) => sent.target.pushToken === "push-dev_a")).toBe(true);
    await harness.api.enable("dev_b");
    expect(await harness.api.check("dev_b")).toMatchObject({ enabled: true, state: "waiting", misses: 0 });
  });

  it("deleting the account removes the check state and rounds of every device on it", async () => {
    const harness = await enrolled();
    addAccount(harness.db, "acc_2");
    addDevice(harness.db, "dev_z", "acc_2");
    await harness.api.enable("dev_z");
    await harness.scanAt(T0);
    deleteAccount(harness.db, "acc_1");
    expect(harness.db.prepare("SELECT device_id FROM device_checks").all()).toEqual([{ device_id: "dev_z" }]);
    expect(harness.db.prepare("SELECT DISTINCT device_id FROM check_rounds").all()).toEqual([{ device_id: "dev_z" }]);
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM check_attempts").get()).toEqual({ n: 1 });
  });
});

describe("when a device registers a new push token", () => {
  const patch = (harness: Harness, pushToken: string) =>
    harness.api.call("PATCH", "/relay/v1/devices/dev_a", "dv_a", { push_token: pushToken, app_version: "1.0.1" });

  it("while misses is above 0 it becomes due at once and its next round opens within 24 hours", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    expect((await harness.api.check("dev_a")).next_due_at).toBe(N1);
    harness.clock.value = T0 + DAY + HOUR;
    expect((await patch(harness, "push-new")).status).toBe(200);
    expect((await harness.api.check("dev_a")).next_due_at).toBe(T0 + DAY + HOUR);
    await harness.scanAt(T0 + DAY + HOUR + 60);
    expect(harness.sender.sent).toHaveLength(4);
    expect(harness.sender.sent.at(-1)).toMatchObject({ target: { pushToken: "push-new" }, push: { attempt: 1 } });
    expect((await harness.api.rounds("dev_a"))[0]).toMatchObject({ opened_at: T0 + DAY + HOUR + 60, result: null });
  });

  it("with no misses nothing moves", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    harness.clock.value = T0 + HOUR;
    await patch(harness, "push-new");
    expect((await harness.api.check("dev_a")).next_due_at).toBe(N1);
    await harness.scanAt(T0 + 2 * HOUR);
    expect(harness.sender.sent).toHaveLength(1);
  });

  it("the same token sent again is not a new one", async () => {
    const harness = await enrolled();
    await missRound(harness, T0);
    harness.clock.value = T0 + DAY + HOUR;
    await patch(harness, "push-dev_a");
    expect((await harness.api.check("dev_a")).next_due_at).toBe(N1);
  });
});

describe("the list of rounds", () => {
  it("returns the device's rounds newest first, 20 by default, and stops at 200", async () => {
    const harness = await enrolled();
    const insert = harness.db.prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at, closed_at, attempts, result) VALUES (?, 'dev_a', ?, ?, ?, ?, 1, 'received')");
    for (let n = 0; n < 230; n += 1) insert.run(`rnd_${n}`, `hash_${n}`, T0 - n * WEEK, T0 - n * WEEK + DAY, T0 - n * WEEK + 5);
    const byDefault = await harness.api.rounds("dev_a");
    expect(byDefault.map((round) => round.id)).toEqual(Array.from({ length: 20 }, (_, n) => `rnd_${n}`));
    expect(await harness.api.rounds("dev_a", "?limit=3")).toHaveLength(3);
    expect(await harness.api.rounds("dev_a", "?limit=200")).toHaveLength(200);
    expect(await harness.api.rounds("dev_a", "?limit=5000")).toHaveLength(200);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const response = await harness.api.call("GET", `/relay/v1/devices/dev_a/checks?limit=${bad}`, "dv_a");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
    }
  });

  it("the relay keeps a round for 90 days, whatever the tier", async () => {
    for (const tier of ["free", "relay", "hosted"] as const) {
      const harness = setup();
      addAccount(harness.db, "acc_1", { tier });
      addDevice(harness.db, "dev_a", "acc_1");
      await harness.api.enable("dev_a");
      const insert = harness.db.prepare("INSERT INTO check_rounds (id, device_id, nonce_hash, opened_at, closes_at, closed_at, attempts, result) VALUES (?, 'dev_a', ?, ?, ?, ?, 1, ?)");
      insert.run("rnd_old", "h1", T0 - 90 * DAY - 1, T0 - 89 * DAY - 1, T0 - 90 * DAY, "missed");
      insert.run("rnd_edge", "h2", T0 - 90 * DAY, T0 - 89 * DAY, T0 - 90 * DAY + 5, "received");
      insert.run("rnd_new", "h3", T0 - DAY, T0, T0 - DAY + 5, "received");
      // A round with no result is open, and an open round is never deleted.
      insert.run("rnd_open", "h4", T0 - 200 * DAY, T0 - 199 * DAY, null, null);
      expect(pruneCheckRounds(harness.db, harness.clock, "selfhosted")).toBe(0);
      expect(pruneCheckRounds(harness.db, harness.clock, "relay")).toBe(1);
      expect((harness.db.prepare("SELECT id FROM check_rounds ORDER BY id").all() as { id: string }[]).map((row) => row.id)).toEqual(["rnd_edge", "rnd_new", "rnd_open"]);
      // Pruning rounds leaves the device's count of misses alone.
      expect(harness.db.prepare("SELECT COUNT(*) AS n FROM device_checks").get()).toEqual({ n: 1 });
    }
  });

  it("answers whether or not the account holds the pack today", async () => {
    const harness = await enrolled();
    await harness.scanAt(T0);
    await harness.api.receipt("dev_a", lastCheckId(harness.sender));
    removePack(harness.db, "acc_1");
    const response = await harness.api.call("GET", "/relay/v1/devices/dev_a/checks", "dv_a");
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(1);
  });
});

describe("where the check routes are served", () => {
  it("not on a self-hosted server", async () => {
    const harness = setup({ config: { mode: "selfhosted" } });
    addAccount(harness.db, "acc_1");
    addDevice(harness.db, "dev_a", "acc_1");
    expect((await harness.api.call("GET", "/relay/v1/devices/dev_a/check", "dv_a")).status).toBe(404);
    expect((await harness.api.call("PUT", "/relay/v1/devices/dev_a/check", "dv_a", { enabled: true })).status).toBe(404);
    expect((await harness.api.call("GET", "/relay/v1/devices/dev_a/checks", "dv_a")).status).toBe(404);
  });

  it("a body that does not say enabled true or false answers 400", async () => {
    const harness = await enrolled();
    for (const body of ["not json", {}, { enabled: "yes" }, { enabled: 1 }, "null"]) {
      const response = await harness.api.call("PUT", "/relay/v1/devices/dev_a/check", "dv_a", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request" });
    }
  });

  it("the pack can come from the relay's own configuration", async () => {
    const harness = setup({ config: { packIncludes: { hosted: ["pro"] } } });
    addAccount(harness.db, "acc_1", { pack: false, tier: "hosted" });
    addDevice(harness.db, "dev_a", "acc_1");
    expect((await harness.api.enable("dev_a")).status).toBe(200);
    await harness.scanAt(T0);
    expect(harness.sender.sent).toHaveLength(1);
  });
});
