import type { MiddlewareHandler } from "hono";
import { authenticateDevice, bearerFromHeader } from "../tier/auth.js";
import type { AccountContext } from "../tier/types.js";
import type Database from "better-sqlite3";
export type V1Env = { Variables: { account: AccountContext } };
export function requireDevice(db: Database.Database): MiddlewareHandler<V1Env> { return async (c,next) => { const account=authenticateDevice(db,bearerFromHeader(c.req.header("authorization"))); if(account===null)return c.json({error:"unauthorized"},401); c.set("account",account); await next(); }; }
