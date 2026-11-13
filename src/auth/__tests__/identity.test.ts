import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { sessionIdentityResolver } from "../identity.js";

// api.md §3.7. The resolver reads better-auth's `session` table. Removing a way
// to sign in needs a session made in the last 300 seconds, so the resolver also
// says when the session was made. `createdAt` has the same `date` affinity as
// `expiresAt`, so it comes back in the same two shapes.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const NOW = 1_760_000_000;

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (\'usr_1\', \'u\', \'u@example.com\', 0, 0, 0)').run();
  return db;
}

function session(db: ReturnType<typeof openDatabase>, token: string, createdAt: string | number) {
  db.prepare('INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, 0, \'usr_1\')')
    .run(`ses_${token}`, "2099-01-01T00:00:00.000Z", token, createdAt);
}

describe("session age", () => {
  it("reads when the session was made from an ISO string", () => {
    const db = setup();
    session(db, "iso", new Date((NOW - 42) * 1000).toISOString());
    expect(sessionIdentityResolver(db, { now: () => NOW }).resolveSession!("iso")).toEqual({ userId: "usr_1", createdAt: NOW - 42 });
  });

  it("reads when the session was made from epoch milliseconds and epoch seconds", () => {
    const db = setup();
    session(db, "ms", (NOW - 7) * 1000);
    session(db, "s", NOW - 9);
    const resolver = sessionIdentityResolver(db, { now: () => NOW });
    expect(resolver.resolveSession!("ms")).toEqual({ userId: "usr_1", createdAt: NOW - 7 });
    expect(resolver.resolveSession!("s")).toEqual({ userId: "usr_1", createdAt: NOW - 9 });
  });

  it("still resolves a session whose creation time cannot be read, with no age", () => {
    const db = setup();
    session(db, "junk", "not a date");
    expect(sessionIdentityResolver(db, { now: () => NOW }).resolveSession!("junk")).toEqual({ userId: "usr_1", createdAt: null });
  });

  it("keeps resolve answering the user id alone, as every older caller reads it", () => {
    const db = setup();
    session(db, "iso", new Date((NOW - 42) * 1000).toISOString());
    expect(sessionIdentityResolver(db, { now: () => NOW }).resolve("iso")).toEqual({ userId: "usr_1" });
  });
});
