import type { MiddlewareHandler } from "hono";
import { authenticateDevice, bearerFromHeader } from "../tier/auth.js";
import type { AccountContext } from "../tier/types.js";
import type Database from "better-sqlite3";
import { showAdminToken } from "../admin/credentials.js";
export type V1Env = { Variables: { account: AccountContext } };
export function requireDevice(db: Database.Database, mode: "selfhosted" | "relay" | "hosted" = "relay"): MiddlewareHandler<V1Env> {
  return async (c, next) => {
    const bearer = bearerFromHeader(c.req.header("authorization"));
    if (mode === "selfhosted") {
      const header = c.req.header("authorization") ?? "";
      const token = /^Bearer (ad_[A-Za-z0-9_-]+)$/.exec(header)?.[1];
      if (token === undefined || token !== showAdminToken(db)) return c.json({ error: "unauthorized" }, 401);
      c.set("account", { accountId: "acc_selfhosted", deviceId: "admin" });
    } else {
      const account = authenticateDevice(db, bearer);
      if (account === null) return c.json({ error: "unauthorized" }, 401);
      c.set("account", account);
    }
    await next();
  };
}
