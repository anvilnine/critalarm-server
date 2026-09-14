import type { MiddlewareHandler } from "hono";
import { authenticateDevice, bearerFromHeader } from "../tier/auth.js";
import type { AccountContext } from "../tier/types.js";
import type Database from "better-sqlite3";
import { showAdminToken } from "../admin/credentials.js";
export type V1Env = { Variables: { account: AccountContext } };
export function authenticateManagement(db: Database.Database, authorization: string | undefined, mode: "selfhosted" | "relay" | "hosted"): AccountContext | null {
  if (mode === "selfhosted") {
    const token = /^Bearer (ad_[A-Za-z0-9_-]+)$/.exec(authorization ?? "")?.[1];
    return token !== undefined && token === showAdminToken(db)
      ? { accountId: "acc_selfhosted", deviceId: "admin" }
      : null;
  }
  return authenticateDevice(db, bearerFromHeader(authorization));
}

export function requireDevice(db: Database.Database, mode: "selfhosted" | "relay" | "hosted" = "relay"): MiddlewareHandler<V1Env> {
  return async (c, next) => {
    const account = authenticateManagement(db, c.req.header("authorization"), mode);
    if (account === null) return c.json({ error: "unauthorized" }, 401);
    c.set("account", account);
    await next();
  };
}
