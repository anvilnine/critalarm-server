import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress } from "./address.js";
import { parseBaseUrl } from "./base-url.js";

// api.md §4.1. Confirms that the server at base_url made this challenge.
// Resolves to true only for a 200 whose JSON body carries the same value.
// Every other outcome is false and never an exception.
export type ChallengeConfirmer = (baseUrl: string, challenge: string) => Promise<boolean>;

const TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1024;

export interface ResolvedAddress { address: string; family: number; }
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

const resolveAll: Resolver = (host) => dnsLookup(host, { all: true });

export function createChallengeConfirmer(resolve: Resolver = resolveAll): ChallengeConfirmer {
  return async (baseUrl, challenge) => {
    const parsed = parseBaseUrl(baseUrl);
    if (parsed === undefined) return false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((done) => { timer = setTimeout(() => done(false), TIMEOUT_MS); });
    try {
      return await Promise.race([deadline, attempt(resolve, parsed.host, parsed.port, `${parsed.path}/v1/relay-challenge/${challenge}`, challenge)]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function attempt(resolve: Resolver, host: string, port: number, path: string, challenge: string): Promise<boolean> {
  const addresses = await resolve(host);
  if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) return false;
  const target = addresses[0] as ResolvedAddress;
  // The connection goes to the address vetted above. A second DNS answer cannot
  // swap the target, and the certificate is still checked against the host name.
  const pinned: LookupFunction = (_host, options, callback) => {
    if (options.all === true) callback(null, [{ address: target.address, family: target.family }]);
    else (callback as (error: null, address: string, family: number) => void)(null, target.address, target.family);
  };
  return new Promise<boolean>((done) => {
    const req = request({ host, port, path, method: "GET", lookup: pinned, servername: host, headers: { accept: "application/json" }, timeout: TIMEOUT_MS }, (res) => {
      // A redirect is a failure and is never followed.
      if (res.statusCode !== 200) { res.destroy(); req.destroy(); done(false); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { res.destroy(); req.destroy(); done(false); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          done(typeof body === "object" && body !== null && (body as { challenge?: unknown }).challenge === challenge);
        } catch { done(false); }
      });
      res.on("error", () => done(false));
    });
    req.on("timeout", () => { req.destroy(); done(false); });
    req.on("error", () => done(false));
    req.end();
  });
}

export const confirmChallenge: ChallengeConfirmer = createChallengeConfirmer();
