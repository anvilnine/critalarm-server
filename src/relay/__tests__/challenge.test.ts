import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { createSecureContext } from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfSignedCertificate } from "./selfsigned.js";
import { createChallengeConfirmer, createPublicResolver } from "../challenge.js";

const challenge = "c".repeat(40);
const RELAY = "relay.critalarm.app";

describe("the challenge confirmer", () => {
  it("makes no request when a name resolves to a private address", async () => {
    const resolve = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    expect(await createChallengeConfirmer(resolve)("https://alerts.example.com", challenge, [RELAY])).toBe(false);
    expect(resolve).toHaveBeenCalledWith("alerts.example.com");
  });

  it("refuses when any one of several answers is not public", async () => {
    const resolve = async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
    expect(await createChallengeConfirmer(resolve)("https://alerts.example.com", challenge, [RELAY])).toBe(false);
  });

  it("refuses when the name does not resolve", async () => {
    const resolve = async (): Promise<{ address: string; family: number }[]> => { throw new Error("ENOTFOUND"); };
    expect(await createChallengeConfirmer(resolve)("https://alerts.example.com", challenge, [RELAY])).toBe(false);
  });

  it("refuses a base_url that breaks the rules without resolving it", async () => {
    const resolve = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    expect(await createChallengeConfirmer(resolve)("http://alerts.example.com", challenge, [RELAY])).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("the public resolver", () => {
  const fail = (code: string) => async (): Promise<string[]> => { throw Object.assign(new Error(code), { code }); };

  it("returns the A and the AAAA answers together", async () => {
    const resolver = createPublicResolver({ resolve4: async () => ["93.184.216.34"], resolve6: async () => ["2606:2800:220:1::1"] });
    expect(await resolver("alerts.example.com")).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }]);
  });

  it("uses the one family that answers", async () => {
    expect(await createPublicResolver({ resolve4: async () => ["93.184.216.34"], resolve6: fail("ENODATA") })("a.example.com")).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(await createPublicResolver({ resolve4: fail("ENODATA"), resolve6: async () => ["2606:2800:220:1::1"] })("a.example.com")).toEqual([{ address: "2606:2800:220:1::1", family: 6 }]);
  });

  it("fails a host with no A and no AAAA record", async () => {
    await expect(createPublicResolver({ resolve4: fail("ENODATA"), resolve6: fail("ENODATA") })("a.example.com")).rejects.toThrow();
    await expect(createPublicResolver({ resolve4: async () => [], resolve6: async () => [] })("a.example.com")).rejects.toThrow();
  });

  it("makes the confirmer refuse a host with one private answer in either family, and make no request", async () => {
    for (const client of [
      { resolve4: async () => ["93.184.216.34"], resolve6: async () => ["fd00::1"] },
      { resolve4: async () => ["10.0.0.5"], resolve6: async () => ["2606:2800:220:1::1"] },
    ]) {
      expect(await createChallengeConfirmer(createPublicResolver(client))("https://alerts.example.com", challenge, [RELAY])).toBe(false);
    }
  });
});

// The real HTTPS path against a local server on 127.0.0.1. The resolver sends
// a public-looking name there, the address check and the trust anchor are
// injected, and no packet leaves the machine.
describe("the challenge confirmer over HTTPS", () => {
  const HOST = "alerts.example.com";
  const { cert, key } = selfSignedCertificate(HOST);
  let respond: (req: IncomingMessage, res: ServerResponse) => void = () => {};
  const seen: { host?: string | undefined; sni?: string | undefined; path?: string | undefined; hits: number } = { hits: 0 };
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer({ cert, key, SNICallback: (name, done) => { seen.sni = name; done(null, createSecureContext({ cert, key })); } }, (req, res) => {
      seen.hits += 1; seen.host = req.headers.host; seen.path = req.url;
      respond(req, res);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  beforeEach(() => { seen.hits = 0; seen.host = undefined; seen.sni = undefined; seen.path = undefined; });

  const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
  const confirmer = (timeoutMs = 2000) => createChallengeConfirmer(resolve, { isPublic: () => true, ca: cert, timeoutMs, port });
  // The base_url names the default port. The test server listens elsewhere, so
  // the confirmer is told which port to connect to.
  const url = () => `https://${HOST}/crit`;
  const json = (body: unknown) => (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  it("confirms a 200 with the same challenge, connecting to the vetted address with the right Host and SNI", async () => {
    respond = json({ challenge, relay: RELAY });
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(true);
    expect(seen.path).toBe(`/crit/v1/relay-challenge/${challenge}`);
    expect(seen.host).toBe(`${HOST}:${port}`);
    expect(seen.sni).toBe(HOST);
  });

  it("fails on a redirect and does not follow it", async () => {
    respond = (_req, res) => { res.writeHead(302, { location: "https://alerts.example.com/elsewhere" }); res.end(); };
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
    expect(seen.hits).toBe(1);
  });

  it("fails on a body over 1024 bytes", async () => {
    respond = json({ challenge, relay: RELAY, padding: "x".repeat(2000) });
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
  });

  it("fails when the answer carries another challenge value", async () => {
    respond = json({ challenge: "d".repeat(40), relay: RELAY });
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
  });

  it("fails when the answer names another relay, or none", async () => {
    respond = json({ challenge, relay: "other-relay.example.com" });
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
    respond = json({ challenge });
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
    respond = json({ challenge, relay: 7 });
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
  });

  it("accepts any host of the list and fails an empty list without a request", async () => {
    respond = json({ challenge, relay: "second.example.com" });
    expect(await confirmer()(url(), challenge, [RELAY, "second.example.com"])).toBe(true);
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
    seen.hits = 0;
    expect(await confirmer()(url(), challenge, [])).toBe(false);
    expect(seen.hits).toBe(0);
  });

  it("compares the relay value with the host it is given, port included", async () => {
    respond = json({ challenge, relay: "relay.example.com:8443" });
    expect(await confirmer()(url(), challenge, ["relay.example.com:8443"])).toBe(true);
    expect(await confirmer()(url(), challenge, ["relay.example.com"])).toBe(false);
  });

  it("fails on a status other than 200", async () => {
    respond = (_req, res) => { res.writeHead(404); res.end(JSON.stringify({ error: "not found" })); };
    expect(await confirmer()(url(), challenge, [RELAY])).toBe(false);
  });

  it("fails when the server answers too slowly", async () => {
    respond = () => {};
    const started = Date.now();
    expect(await confirmer(200)(url(), challenge, [RELAY])).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  // The idle timeout equals the deadline here and the peer sends a byte well
  // inside it, forever. Only the total deadline can end this call.
  it("closes the socket at the deadline when the peer drips bytes forever", async () => {
    const closed = new Promise<number>((done) => {
      const startedAt = Date.now();
      respond = (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        const drip = setInterval(() => { res.write(" "); }, 50);
        req.socket.on("close", () => { clearInterval(drip); done(Date.now() - startedAt); });
      };
    });
    const started = Date.now();
    expect(await confirmer(400)(url(), challenge, [RELAY])).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
    // The server side saw the socket close, and soon after the deadline.
    expect(await closed).toBeLessThan(1500);
  });

  it("closes the socket at the deadline when the peer never answers at all", async () => {
    const closed = new Promise<void>((done) => {
      respond = (req) => { req.socket.on("close", () => done()); };
    });
    expect(await confirmer(300)(url(), challenge, [RELAY])).toBe(false);
    await closed;
  });

  it("fails when the certificate is not trusted", async () => {
    respond = json({ challenge, relay: RELAY });
    expect(await createChallengeConfirmer(resolve, { isPublic: () => true, timeoutMs: 2000, port })(url(), challenge, [RELAY])).toBe(false);
  });

  it("refuses the loopback address in its default configuration", async () => {
    respond = json({ challenge, relay: RELAY });
    expect(await createChallengeConfirmer(resolve, { ca: cert, port })(url(), challenge, [RELAY])).toBe(false);
    expect(seen.hits).toBe(0);
  });
});
