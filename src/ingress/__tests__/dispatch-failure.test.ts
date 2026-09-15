import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IncidentService } from "../../incident/service.js";
import type { Clock, IdGenerator } from "../../incident/types.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createIngressRouter } from "../router.js";

class FakeClock implements Clock {
  constructor(public value = 1_000) {}
  now(): number { return this.value; }
}

class FixedIds implements IdGenerator {
  private messageNumber = 0;
  private timerNumber = 0;
  message(): string { this.messageNumber += 1; return `m_${this.messageNumber}`; }
  incident(): string { return "inc_1"; }
  timer(): string { this.timerNumber += 1; return `tm_${this.timerNumber}`; }
}

function setup(dispatch: () => Promise<void>) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO accounts (id, tier, created_at) VALUES ('acc_1', 'free', 1)").run();
  db.prepare("INSERT INTO topics (id, account_id, name, base_url, topic_hash, critical, repeat_interval_s, max_ring_s, desk_timer_s, relay_content, created_at) VALUES ('top_1', 'acc_1', 'prod', 'https://alerts.example.com', 'hash_prod', 1, 10, 60, 30, 'none', 1)").run();
  db.prepare("INSERT INTO topic_tokens (id, topic_id, hash, created_at) VALUES ('tok_1', 'top_1', ?, 1)").run(createHash("sha256").update("tk_test").digest("hex"));
  const clock = new FakeClock();
  const ids = new FixedIds();
  const app = createIngressRouter({ db, clock, ids, incidents: new IncidentService(db, clock, ids), dispatch });
  return { app, db };
}

const bearer = { Authorization: "Bearer tk_test" };

// A bad FCM_PRIVATE_KEY on the dev server made signJwt throw exactly like
// this. The publish answered a bare "Internal Server Error" and the container
// log said nothing at all, so there was no way to tell a push problem from
// anything else without reading the SQLite file.
//
// The 500 itself is correct and is covered by publish.test.ts: this is an
// alarm product, and a caller told "accepted" when nobody was paged has been
// lied to. What is tested here is that the reason is now findable.
describe("a push provider that throws", () => {
  it("says why in the log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = setup(async () => {
      throw new Error("error:1E08010C:DECODER routines::unsupported");
    });

    await app.request("/prod", {
      method: "POST",
      headers: { ...bearer, Priority: "5" },
      body: "the database is down",
    });

    expect(error).toHaveBeenCalledWith("dispatch_failed", expect.objectContaining({
      topic: "prod",
      error: "error:1E08010C:DECODER routines::unsupported",
    }));
    error.mockRestore();
  });

  it("keeps the message and the incident, so nothing is lost", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, db } = setup(async () => {
      throw new Error("push provider is misconfigured");
    });

    await app.request("/prod", {
      method: "POST",
      headers: { ...bearer, Priority: "5" },
      body: "the database is down",
    });

    const stored = db.prepare("SELECT id, incident_id FROM messages").all() as {
      id: string;
      incident_id: string | null;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.incident_id).toBe("inc_1");

    const incident = db.prepare("SELECT state FROM incidents WHERE id = 'inc_1'").get() as
      | { state: string }
      | undefined;
    expect(incident?.state).toBe("open");
    error.mockRestore();
  });
});
