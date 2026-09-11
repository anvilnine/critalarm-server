import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const TOKEN_KEY = "admin_token";
const ACCOUNT_ID = "acc_selfhosted";

export function ensureSelfHostedIdentity(db: Database.Database): { token: string; firstBoot: boolean; accountId: string } {
  const existing = db.prepare("SELECT value FROM server_settings WHERE key = ?").get(TOKEN_KEY) as { value: string } | undefined;
  if (existing !== undefined) {
    ensureAccount(db);
    return { token: existing.value, firstBoot: false, accountId: ACCOUNT_ID };
  }
  const token = `ad_${randomUUID().replaceAll("-", "")}`;
  db.transaction(() => {
    ensureAccount(db);
    db.prepare("INSERT INTO server_settings (key, value) VALUES (?, ?)").run(TOKEN_KEY, token);
  })();
  return { token, firstBoot: true, accountId: ACCOUNT_ID };
}

function ensureAccount(db: Database.Database): void {
  db.prepare("INSERT OR IGNORE INTO accounts (id, tier, rc_app_user_id, created_at) VALUES (?, 'hosted', NULL, ?)").run(ACCOUNT_ID, Math.floor(Date.now() / 1000));
}

export function showAdminToken(db: Database.Database): string | undefined {
  return (db.prepare("SELECT value FROM server_settings WHERE key = ?").get(TOKEN_KEY) as { value: string } | undefined)?.value;
}

export function rotateAdminToken(db: Database.Database): string {
  const token = `ad_${randomUUID().replaceAll("-", "")}`;
  db.prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(TOKEN_KEY, token);
  return token;
}
