import { describe, expect, it } from "vitest";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { ensureSelfHostedIdentity, rotateAdminToken, showAdminToken } from "../credentials.js";

describe("admin credentials", () => {
  it("persists first token and rotates", () => {
    const db = openDatabase(":memory:"); migrate(db);
    const first = ensureSelfHostedIdentity(db);
    expect(first.firstBoot).toBe(true);
    expect(showAdminToken(db)).toBe(first.token);
    expect(ensureSelfHostedIdentity(db).firstBoot).toBe(false);
    expect(rotateAdminToken(db)).not.toBe(first.token);
    db.close();
  });
});
