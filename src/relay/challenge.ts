import { Resolver as DnsResolver } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress } from "./address.js";
import { parseBaseUrl } from "./base-url.js";

// api.md §4.1. Confirms that the server at base_url made this challenge.
// Resolves to true only for a 200 whose JSON body carries the same value.
// Every other outcome is false and never an exception.
export type ChallengeConfirmer = (baseUrl: string, challenge: string) => Promise<boolean>;

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1024;

export interface ResolvedAddress { address: string; family: number; }
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

// The two calls of a dns.promises.Resolver the relay uses. Tests pass a fake.
export interface DnsClient { resolve4(host: string): Promise<string[]>; resolve6(host: string): Promise<string[]>; }

// Asks the name servers directly with resolve4 and resolve6. dns.lookup is
// avoided on purpose: it runs on the libuv thread pool (4 threads), and a few
// hosts whose name server never answers would queue every other lookup in the
// process, the relay's own push connections included. It also reads
// /etc/hosts and the search domains, which a registration must not.
// A host with neither an A nor an AAAA record fails. When one family fails and
// the other answers, the answers that came are used.
export function createPublicResolver(client: DnsClient = new DnsResolver({ timeout: 2000, tries: 1 })): Resolver {
  return async (host) => {
    const [v4, v6] = await Promise.allSettled([client.resolve4(host), client.resolve6(host)]);
    const addresses: ResolvedAddress[] = [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (addresses.length === 0) throw new Error("no A or AAAA record");
    return addresses;
  };
}

const resolveAll: Resolver = createPublicResolver();

// Tests pass a different address check, trust anchor, timeout and port (the
// local test server cannot listen on 443 or 8443). The server
// builds its confirmer with none of them, and nothing reads them from the
// environment.
export interface ConfirmerOptions { isPublic?: (address: string) => boolean; ca?: string | Buffer; timeoutMs?: number; port?: number; }

export function createChallengeConfirmer(resolve: Resolver = resolveAll, options: ConfirmerOptions = {}): ChallengeConfirmer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isPublic = options.isPublic ?? isPublicAddress;
  return async (baseUrl, challenge) => {
    const parsed = parseBaseUrl(baseUrl);
    if (parsed === undefined) return false;
    // One deadline for DNS, connect, TLS, headers and body together. When it
    // fires the request is aborted, which destroys its socket. The idle
    // `timeout` option alone would let a peer that sends a byte every few
    // seconds hold the socket for hours.
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    const deadline = new Promise<false>((done) => { controller.signal.addEventListener("abort", () => { done(false); }, { once: true }); });
    try {
      return await Promise.race([deadline, attempt(resolve, isPublic, options.ca, timeoutMs, controller.signal, parsed.host, options.port ?? parsed.port, `${parsed.path}/v1/relay-challenge/${challenge}`, challenge)]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      // Closes the request on every other exit too, so nothing outlives the call.
      controller.abort();
    }
  };
}

async function attempt(resolve: Resolver, isPublic: (address: string) => boolean, ca: string | Buffer | undefined, timeoutMs: number, signal: AbortSignal, host: string, port: number, path: string, challenge: string): Promise<boolean> {
  const addresses = await resolve(host);
  if (signal.aborted) return false;
  if (addresses.length === 0 || !addresses.every((entry) => isPublic(entry.address))) return false;
  const target = addresses[0] as ResolvedAddress;
  // The connection goes to the address vetted above. A second DNS answer cannot
  // swap the target, and the certificate is still checked against the host name.
  const pinned: LookupFunction = (_host, options, callback) => {
    if (options.all === true) callback(null, [{ address: target.address, family: target.family }]);
    else (callback as (error: null, address: string, family: number) => void)(null, target.address, target.family);
  };
  return new Promise<boolean>((done) => {
    const req = request({ host, port, path, method: "GET", lookup: pinned, servername: host, headers: { accept: "application/json" }, timeout: timeoutMs, signal, ...(ca === undefined ? {} : { ca }) }, (res) => {
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
      res.on("aborted", () => done(false));
    });
    req.on("timeout", () => { req.destroy(); done(false); });
    req.on("error", () => done(false));
    req.end();
  });
}

export const confirmChallenge: ChallengeConfirmer = createChallengeConfirmer();
