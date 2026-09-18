import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { openDatabase } from "../../store/database.js";
import { migrate } from "../../store/migrations.js";
import { createApp } from "../../index.js";
import { appleProvider, authIsConfigured, createAuthHandler } from "../better-auth.js";
import {
  APPLE_AUDIENCE,
  APPLE_MAX_LIFETIME_S,
  CLIENT_SECRET_LIFETIME_S,
  CLIENT_SECRET_REFRESH_S,
  appleClientSecretMinter,
} from "../apple-client-secret.js";

// Every key here is generated in the process. Nothing is pasted in: this repo
// is public and a `.p8` shaped fixture is a credential whether or not it is a
// real one.
function ecKeyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function rsaPrivateKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const KEY = ecKeyPair();
const CLIENT_ID = "app.critalarm.signin";
const TEAM_ID = "ABCDE12345";
const KEY_ID = "FGHIJ67890";
const NOW = 1_760_000_000;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BASE_URL: "https://alerts.example.com",
    RELAY_URL: "https://relay.critalarm.app",
    DATA_DIR: "/tmp",
    ALLOW_NOOP_PUSH: "true",
    AUTH_SECRET: "a".repeat(32),
    ...extra,
  };
}

function signingEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return env({
    AUTH_APPLE_CLIENT_ID: CLIENT_ID,
    AUTH_APPLE_TEAM_ID: TEAM_ID,
    AUTH_APPLE_KEY_ID: KEY_ID,
    AUTH_APPLE_PRIVATE_KEY: KEY.privateKey,
    ...extra,
  });
}

interface Decoded {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signatureVerifies: boolean;
}

// A JWT-shaped string proves nothing, so this checks the signature against the
// public half of the generated key and hands back the parts to assert one by
// one. ES256 signatures are raw r||s, which is what `ieee-p1363` means.
function decode(jwt: string, publicKey: string): Decoded {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as Record<string, unknown>,
    signatureVerifies: verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    ),
  };
}

function minted(now: number = NOW): string {
  return appleClientSecretMinter(CLIENT_ID, { teamId: TEAM_ID, keyId: KEY_ID, privateKey: KEY.privateKey }, { now: () => now })();
}

afterEach(() => vi.restoreAllMocks());

describe("the Apple client secret", () => {
  it("is what the three values Apple hands out configure, with no client secret set", () => {
    const config = loadConfig(signingEnv());
    expect(config.auth?.apple).toEqual({
      clientId: CLIENT_ID,
      credential: { kind: "key", signingKey: { teamId: TEAM_ID, keyId: KEY_ID, privateKey: KEY.privateKey } },
    });
    expect(authIsConfigured(config.auth)).toBe(true);
  });

  it("carries the header Apple asks for, and verifies against the public half of the key", () => {
    const { header, signatureVerifies } = decode(minted(), KEY.publicKey);
    expect(header).toEqual({ alg: "ES256", kid: KEY_ID });
    expect(signatureVerifies).toBe(true);
  });

  it("does not verify against an unrelated key", () => {
    expect(decode(minted(), ecKeyPair().publicKey).signatureVerifies).toBe(false);
  });

  it("carries every claim Apple asks for, and nothing else", () => {
    const { claims } = decode(minted(), KEY.publicKey);
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "sub"]);
    expect(claims.iss).toBe(TEAM_ID);
    expect(claims.aud).toBe(APPLE_AUDIENCE);
    expect(claims.sub).toBe(CLIENT_ID);
    expect(claims.iat).toBe(NOW);
    expect(claims.exp).toBe(NOW + CLIENT_SECRET_LIFETIME_S);
  });

  it("expires inside Apple's 15,777,000 second ceiling", () => {
    const { claims } = decode(minted(), KEY.publicKey);
    expect(APPLE_MAX_LIFETIME_S).toBe(15_777_000);
    expect(CLIENT_SECRET_LIFETIME_S).toBeLessThan(APPLE_MAX_LIFETIME_S);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThan(APPLE_MAX_LIFETIME_S);
  });

  it("is minted once and handed out again until it is nearly expired", () => {
    let now = NOW;
    const secret = appleClientSecretMinter(CLIENT_ID, { teamId: TEAM_ID, keyId: KEY_ID, privateKey: KEY.privateKey }, { now: () => now });
    const first = secret();
    now = NOW + CLIENT_SECRET_LIFETIME_S - CLIENT_SECRET_REFRESH_S - 1;
    expect(secret()).toBe(first);
  });

  // The fake clock is what makes this provable. Waiting for the real one would
  // take a month.
  it("is re-minted a day before it expires, not after", () => {
    let now = NOW;
    const secret = appleClientSecretMinter(CLIENT_ID, { teamId: TEAM_ID, keyId: KEY_ID, privateKey: KEY.privateKey }, { now: () => now });
    const first = secret();
    now = NOW + CLIENT_SECRET_LIFETIME_S - CLIENT_SECRET_REFRESH_S;
    const second = secret();
    expect(second).not.toBe(first);
    const { claims, signatureVerifies } = decode(second, KEY.publicKey);
    expect(signatureVerifies).toBe(true);
    expect(claims.iat).toBe(now);
    expect(claims.exp).toBe(now + CLIENT_SECRET_LIFETIME_S);
    // Still live at the moment it was handed out, which is the whole point.
    expect(claims.exp as number).toBeGreaterThan(now);
  });

  it("is minted fresh by a process that starts after the last one expired", () => {
    const restarted = NOW + CLIENT_SECRET_LIFETIME_S * 3;
    const { claims } = decode(minted(restarted), KEY.publicKey);
    expect(claims.iat).toBe(restarted);
    expect(claims.exp).toBe(restarted + CLIENT_SECRET_LIFETIME_S);
  });

  it("is read from a file as well as from the environment", () => {
    const config = loadConfig(
      env({ AUTH_APPLE_CLIENT_ID: CLIENT_ID, AUTH_APPLE_TEAM_ID: TEAM_ID, AUTH_APPLE_KEY_ID: KEY_ID, AUTH_APPLE_PRIVATE_KEY_FILE: "/etc/critalarm/apple.p8" }),
      (path) => (path === "/etc/critalarm/apple.p8" ? KEY.privateKey : ""),
    );
    expect(config.auth?.apple?.credential).toEqual({ kind: "key", signingKey: { teamId: TEAM_ID, keyId: KEY_ID, privateKey: KEY.privateKey } });
  });

  it("unescapes a key pasted into a single-line environment variable", () => {
    const config = loadConfig(signingEnv({ AUTH_APPLE_PRIVATE_KEY: KEY.privateKey.replace(/\n/g, "\\n") }));
    expect(config.auth?.apple?.credential).toEqual({ kind: "key", signingKey: { teamId: TEAM_ID, keyId: KEY_ID, privateKey: KEY.privateKey } });
  });
});

// better-auth takes a `clientSecret` string, so the only thing standing between
// a minted secret and a frozen one is that the property it reads is a getter
// and that better-auth reads it per request. Both halves are checked here.
describe("what better-auth is handed", () => {
  it("re-reads the secret on every read, so a clock jump changes it", () => {
    let now = NOW;
    const apple = loadConfig(signingEnv()).auth?.apple;
    if (apple === undefined) throw new Error("the signing key did not configure Apple sign-in");
    const provider = appleProvider(apple, { now: () => now });
    const first = provider.clientSecret;
    expect(provider.clientSecret).toBe(first);
    now = NOW + CLIENT_SECRET_LIFETIME_S;
    expect(provider.clientSecret).not.toBe(first);
    expect(decode(provider.clientSecret, KEY.publicKey).claims.iat).toBe(now);
  });

  it("is read at request time, not once at boot", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const authClock = { now: vi.fn(() => NOW) };
    const config = loadConfig(signingEnv({ MODE: "relay" }));
    const authHandler = createAuthHandler(config, db, authClock);
    expect(authHandler).toBeInstanceOf(Function);
    const app = createApp({
      config,
      db,
      clock: { now: () => NOW },
      ids: { message: () => "m", incident: () => "i", timer: () => "t" },
      dispatch: async () => {},
      ...(authHandler === undefined ? {} : { authHandler }),
    });
    // Building the handler must not have minted anything: the minter is lazy,
    // so the clock has not been asked the time yet.
    expect(authClock.now).not.toHaveBeenCalled();
    // Apple's authorization URL is built locally and nothing is sent to Apple,
    // but better-auth refuses to build it without a client secret, so reaching
    // a 200 is the proof that it read one.
    const response = await app.request("https://alerts.example.com/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "apple", callbackURL: "https://alerts.example.com/done" }),
    });
    expect(response.status).toBe(200);
    expect(authClock.now).toHaveBeenCalled();
    db.close();
  });
});

describe("a bad Apple private key", () => {
  const failsWithout = (env: NodeJS.ProcessEnv, readFile?: (path: string) => string, secret?: string) => {
    let message = "";
    expect(() => {
      try {
        loadConfig(env, readFile);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }).toThrow();
    expect(message).not.toBe("");
    if (secret !== undefined) {
      expect(message).not.toContain(secret);
      // The PEM body without its armour, in case a message stripped the lines.
      for (const line of secret.split("\n").filter((part) => part.length > 20 && !part.startsWith("-----"))) {
        expect(message).not.toContain(line);
      }
    }
    return message;
  };

  it("fails startup with a clear error and never quotes the key", () => {
    const message = failsWithout(signingEnv({ AUTH_APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----" }), undefined, "not-a-key");
    expect(message).toBe("invalid configuration: AUTH_APPLE_PRIVATE_KEY: not a readable PKCS8 private key");
  });

  it("is refused when it is the wrong kind of key, which is what pasting the FCM one looks like", () => {
    const rsa = rsaPrivateKey();
    const message = failsWithout(signingEnv({ AUTH_APPLE_PRIVATE_KEY: rsa }), undefined, rsa);
    expect(message).toBe("invalid configuration: AUTH_APPLE_PRIVATE_KEY: not an elliptic-curve key (found rsa)");
  });

  it("names the path when the file cannot be read", () => {
    const message = failsWithout(
      env({ AUTH_APPLE_CLIENT_ID: CLIENT_ID, AUTH_APPLE_TEAM_ID: TEAM_ID, AUTH_APPLE_KEY_ID: KEY_ID, AUTH_APPLE_PRIVATE_KEY_FILE: "/nope/apple.p8" }),
      (path) => { if (path === "/nope/apple.p8") throw new Error("ENOENT"); return ""; },
    );
    expect(message).toBe("invalid configuration: AUTH_APPLE_PRIVATE_KEY_FILE: cannot read /nope/apple.p8");
  });

  it("is refused when the Team ID or Key ID is missing", () => {
    expect(() => loadConfig(env({ AUTH_APPLE_CLIENT_ID: CLIENT_ID, AUTH_APPLE_PRIVATE_KEY: KEY.privateKey }))).toThrow("invalid configuration: AUTH_APPLE sign-in credentials");
    expect(() => loadConfig(env({ AUTH_APPLE_CLIENT_ID: CLIENT_ID, AUTH_APPLE_TEAM_ID: TEAM_ID, AUTH_APPLE_KEY_ID: KEY_ID }))).toThrow("invalid configuration: AUTH_APPLE sign-in credentials");
    expect(() => loadConfig(env({ AUTH_APPLE_TEAM_ID: TEAM_ID, AUTH_APPLE_KEY_ID: KEY_ID, AUTH_APPLE_PRIVATE_KEY: KEY.privateKey }))).toThrow("invalid configuration: AUTH_APPLE sign-in credentials");
  });
});

describe("an explicit AUTH_APPLE_CLIENT_SECRET", () => {
  it("is preferred over the signing key, and says once that it will not be rotated", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = loadConfig(signingEnv({ AUTH_APPLE_CLIENT_SECRET: "operator-signed-jwt" }));
    expect(config.auth?.apple?.credential).toEqual({ kind: "secret", clientSecret: "operator-signed-jwt" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("operator-signed-jwt");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY.privateKey.split("\n")[1]);
  });

  it("says nothing when it is the only Apple credential set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = loadConfig(env({ AUTH_APPLE_CLIENT_ID: CLIENT_ID, AUTH_APPLE_CLIENT_SECRET: "operator-signed-jwt" }));
    expect(config.auth?.apple?.credential).toEqual({ kind: "secret", clientSecret: "operator-signed-jwt" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("is handed to better-auth unchanged, whatever the clock says", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(createAuthHandler(loadConfig(env({ AUTH_APPLE_CLIENT_ID: CLIENT_ID, AUTH_APPLE_CLIENT_SECRET: "operator-signed-jwt" })), db, { now: () => NOW })).toBeInstanceOf(Function);
    db.close();
  });
});

describe("Google sign-in and a server with no Apple variables", () => {
  it("is unaffected by the Apple changes", () => {
    const config = loadConfig(env({ AUTH_GOOGLE_CLIENT_ID: "google-id", AUTH_GOOGLE_CLIENT_SECRET: "google-secret" }));
    expect(config.auth).toEqual({ secret: "a".repeat(32), google: { clientId: ["google-id"], clientSecret: "google-secret" } });
    expect(config.auth?.apple).toBeUndefined();
  });

  it("works alongside a minted Apple secret", () => {
    const config = loadConfig(signingEnv({ AUTH_GOOGLE_CLIENT_ID: "google-id", AUTH_GOOGLE_CLIENT_SECRET: "google-secret" }));
    expect(config.auth?.google).toEqual({ clientId: ["google-id"], clientSecret: "google-secret" });
    expect(config.auth?.apple?.credential.kind).toBe("key");
  });

  it("starts and serves everything else with no Apple variables at all", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const config = loadConfig({ BASE_URL: "https://alerts.example.com", RELAY_URL: "https://relay.critalarm.app", DATA_DIR: "/tmp", ALLOW_NOOP_PUSH: "true" });
    expect(config.auth).toBeUndefined();
    const app = createApp({
      config,
      db,
      clock: { now: () => NOW },
      ids: { message: () => "m", incident: () => "i", timer: () => "t" },
      dispatch: async () => {},
    });
    expect((await app.request("https://alerts.example.com/v1/health")).status).toBe(200);
    db.close();
  });
});

// The `.p8` and the minted JWT are both credentials. Neither may reach a log
// line, an error or a response body.
describe("nothing leaks the key or the minted secret", () => {
  it("keeps both out of every log line and out of the mounted surface's answers", async () => {
    const lines: string[] = [];
    const collect = (...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(collect);
    vi.spyOn(console, "warn").mockImplementation(collect);
    vi.spyOn(console, "error").mockImplementation(collect);

    const db = openDatabase(":memory:");
    migrate(db);
    const config = loadConfig(signingEnv({ MODE: "relay" }));
    const authHandler = createAuthHandler(config, db, { now: () => NOW });
    expect(authHandler).toBeInstanceOf(Function);
    const app = createApp({
      config,
      db,
      clock: { now: () => NOW },
      ids: { message: () => "m", incident: () => "i", timer: () => "t" },
      dispatch: async () => {},
      ...(authHandler === undefined ? {} : { authHandler }),
    });
    const body = await (await app.request("https://alerts.example.com/api/auth/get-session")).text();

    const secret = minted();
    const keyBody = KEY.privateKey.split("\n").filter((line) => line.length > 20 && !line.startsWith("-----"));
    expect(keyBody.length).toBeGreaterThan(0);
    for (const haystack of [...lines, body]) {
      expect(haystack).not.toContain(secret);
      for (const line of keyBody) expect(haystack).not.toContain(line);
    }
    db.close();
  });
});
