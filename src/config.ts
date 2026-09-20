import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { parseApplePrivateKey, type AppleSigningKey } from "./auth/apple-client-secret.js";
import type { RevenueCatApiConfig } from "./tier/reconcile.js";

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  environment: "sandbox" | "production";
}

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUrl: string;
}

export interface RevenueCatConfig {
  sharedSecret: string;
  entitlements: Record<string, "free" | "relay" | "hosted">;
}

// api.md §3.7. Sign in with Apple and Google, nothing else: no password, no
// magic link, no email on any tier. `secret` is what better-auth signs sessions
// with. A provider needs both halves of its credential or it is not a provider,
// and with no provider at all the /api/auth surface is not mounted.
// Apple sign-in is credentialed one of two ways, and never both at once.
// `secret` is a client-secret JWT the operator signed and pasted in; it is used
// as given and nobody replaces it when it expires. `key` is the three values
// Apple actually hands out, and the server mints the JWT from them and re-mints
// it before it expires (auth/apple-client-secret.ts).
export type AppleCredential =
  | { kind: "secret"; clientSecret: string }
  | { kind: "key"; signingKey: AppleSigningKey };

export interface AppleAuthConfig {
  clientId: string;
  credential: AppleCredential;
  appBundleIdentifier?: string;
}

export interface AuthConfig {
  secret: string;
  apple?: AppleAuthConfig;
  google?: { clientId: string[]; clientSecret: string };
}

export interface Config {
  mode?: "selfhosted" | "relay" | "hosted";
  baseUrl: string;
  relayUrl: string;
  relayUrlExplicit?: boolean;
  relayContent: "none" | "full";
  listen: string;
  port: number;
  dataDir: string;
  behindProxy: boolean;
  allowNoopPush?: boolean;
  statsKey?: string;
  relayRegistrationSecret?: string;
  apns?: ApnsConfig;
  fcm?: FcmConfig;
  revenueCat?: RevenueCatConfig;
  // The read-only secret API key the reconcile sweep uses, with the project it
  // reads. Unset means the sweep never starts (tier/reconcile.ts).
  revenueCatApi?: RevenueCatApiConfig;
  auth?: AuthConfig;
}

const providerSchema = z.object({
  "team-id": z.string().min(1).optional(),
  "key-id": z.string().min(1).optional(),
  "private-key": z.string().min(1).optional(),
  "bundle-id": z.string().min(1).optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
}).optional();

const fcmSchema = z.object({
  "project-id": z.string().min(1).optional(),
  "client-email": z.string().min(1).optional(),
  "private-key": z.string().min(1).optional(),
  "token-url": z.string().min(1).optional(),
}).optional();

const fileSchema = z.object({
  mode: z.string().optional(),
  "base-url": z.string().optional(),
  "relay-url": z.string().optional(),
  "relay-content": z.string().optional(),
  listen: z.string().optional(),
  "data-dir": z.string().optional(),
  "behind-proxy": z.boolean().optional(),
  apns: providerSchema,
  fcm: fcmSchema,
  revenuecat: z.object({ "shared-secret": z.string().min(1).optional(), entitlements: z.record(z.string(), z.enum(["free", "relay", "hosted"])).optional() }).optional(),
});

type FileConfig = z.infer<typeof fileSchema>;

function configError(field: string): Error {
  return new Error(`invalid configuration: ${field}`);
}

function readConfiguration(env: NodeJS.ProcessEnv, readFile: ((path: string) => string) | undefined): FileConfig {
  let parsed: unknown;
  try {
    parsed = parse((readFile ?? ((path) => readFileSync(path, "utf8")))(env.CONFIG_PATH ?? "critalarm.yml"));
  } catch (error: unknown) {
    if (readFile === undefined && env.CONFIG_PATH === undefined && error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw configError("file");
  }
  const result = fileSchema.safeParse(parsed ?? {});
  if (!result.success) throw configError("file");
  return result.data;
}

function stringValue(env: NodeJS.ProcessEnv, name: string, value: string | undefined): string | undefined {
  return env[name] ?? value;
}

function urlValue(field: string, value: string | undefined): string {
  if (value === undefined) throw configError(field);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return value;
  } catch {
    throw configError(field);
  }
}

function portValue(value: string): number {
  if (!/^\d+$/.test(value)) throw configError("port");
  const port = Number(value);
  if (port < 1 || port > 65_535) throw configError("port");
  return port;
}

// A service account JSON stores the key with literal two-character \n
// sequences, and pasting that value straight into an env var is what everyone
// does. Node's createPrivateKey wants real newlines and answers
// "DECODER routines::unsupported" when it does not get them. Firebase's own
// SDK unescapes this, so do the same. A value that already has real newlines
// is left alone.
function pemNewlines(value: string | undefined): string | undefined {
  if (value === undefined || value.includes("\n")) return value;
  return value.replace(/\\n/g, "\n");
}

function apnsConfig(env: NodeJS.ProcessEnv, file: FileConfig): ApnsConfig | undefined {
  const values = {
    teamId: stringValue(env, "APNS_TEAM_ID", file.apns?.["team-id"]),
    keyId: stringValue(env, "APNS_KEY_ID", file.apns?.["key-id"]),
    privateKey: pemNewlines(stringValue(env, "APNS_PRIVATE_KEY", file.apns?.["private-key"])),
    bundleId: stringValue(env, "APNS_BUNDLE_ID", file.apns?.["bundle-id"]),
    environment: stringValue(env, "APNS_ENVIRONMENT", file.apns?.environment) ?? "production",
  };
  if (Object.values(values).every((value) => value === undefined || value === "production")) return undefined;
  if (values.teamId === undefined || values.keyId === undefined || values.privateKey === undefined || values.bundleId === undefined) {
    throw configError("APNs provider");
  }
  if (values.environment !== "sandbox" && values.environment !== "production") throw configError("APNs environment");
  return values as ApnsConfig;
}

function fcmConfig(env: NodeJS.ProcessEnv, file: FileConfig): FcmConfig | undefined {
  const values = {
    projectId: stringValue(env, "FCM_PROJECT_ID", file.fcm?.["project-id"]),
    clientEmail: stringValue(env, "FCM_CLIENT_EMAIL", file.fcm?.["client-email"]),
    privateKey: pemNewlines(stringValue(env, "FCM_PRIVATE_KEY", file.fcm?.["private-key"])),
    tokenUrl: stringValue(env, "FCM_TOKEN_URL", file.fcm?.["token-url"]) ?? "https://oauth2.googleapis.com/token",
  };
  if (values.projectId === undefined && values.clientEmail === undefined && values.privateKey === undefined) return undefined;
  if (values.projectId === undefined || values.clientEmail === undefined || values.privateKey === undefined) throw configError("FCM provider");
  try {
    new URL(values.tokenUrl);
  } catch {
    throw configError("FCM token URL");
  }
  return values as FcmConfig;
}

// Which RevenueCat entitlement identifier pays for which tier (the map the
// webhook in tier/revenuecat.ts looks events up in). Production has no config
// file, because the image copies none, so the map has to fit in an environment
// variable: comma separated `key=tier` pairs, for example
// `hosted=hosted,relay=relay`.
//
// A pair that does not parse stops startup instead of being dropped. A dropped
// pair means the webhook answers 200 and upgrades nobody, which is the one
// billing failure nothing reports. An empty segment is the exception: a
// trailing or doubled comma carries no meaning, and somebody types this value
// into a box by hand, so it is skipped rather than kept from booting.
function entitlementsValue(value: string | undefined): Record<string, "free" | "relay" | "hosted"> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const entitlements: Record<string, "free" | "relay" | "hosted"> = {};
  for (const pair of value.split(",")) {
    if (pair.trim() === "") continue;
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator).trim();
    const tier = pair.slice(separator + 1).trim();
    if (separator === -1 || key === "") throw configError("RevenueCat entitlements");
    if (tier !== "free" && tier !== "relay" && tier !== "hosted") throw configError("RevenueCat entitlements");
    entitlements[key] = tier;
  }
  return entitlements;
}

function setValue(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

// A `.p8` is multi-line, and a multi-line environment variable is where
// operators lose an afternoon, so the key can be a path instead. Same shape as
// CONFIG_PATH above, including the injected reader the tests use.
function applePrivateKey(env: NodeJS.ProcessEnv, readFile: ((path: string) => string) | undefined): string | undefined {
  const path = setValue(env.AUTH_APPLE_PRIVATE_KEY_FILE);
  if (path === undefined) return pemNewlines(setValue(env.AUTH_APPLE_PRIVATE_KEY));
  try {
    return (readFile ?? ((target) => readFileSync(target, "utf8")))(path);
  } catch {
    // The path is in the message, the key is not: the file could not be read,
    // so there is nothing to leak, and the operator needs to know which path
    // was tried.
    throw configError(`AUTH_APPLE_PRIVATE_KEY_FILE: cannot read ${path}`);
  }
}

// api.md §3.7. Either a client secret the operator signed themselves, or the
// three values Apple hands out for the server to sign with. Half a credential
// is a typo, not a configuration, and it fails startup rather than mounting a
// sign-in surface that answers 500 on the callback.
function appleAuthConfig(env: NodeJS.ProcessEnv, readFile: ((path: string) => string) | undefined): AppleAuthConfig | undefined {
  const clientId = setValue(env.AUTH_APPLE_CLIENT_ID);
  const clientSecret = setValue(env.AUTH_APPLE_CLIENT_SECRET);
  const teamId = setValue(env.AUTH_APPLE_TEAM_ID);
  const keyId = setValue(env.AUTH_APPLE_KEY_ID);
  const privateKey = applePrivateKey(env, readFile);
  if ([clientId, clientSecret, teamId, keyId, privateKey].every((value) => value === undefined)) return undefined;
  if (clientId === undefined) throw configError("AUTH_APPLE sign-in credentials");
  const bundle = setValue(env.AUTH_APPLE_APP_BUNDLE_IDENTIFIER);
  const rest = bundle === undefined ? {} : { appBundleIdentifier: bundle };
  if (clientSecret !== undefined) {
    // An explicit secret wins, so a deployment that already works keeps
    // working. Nothing rotates it, which is worth saying once at startup:
    // Apple's ceiling is about six months and sign-in is the account-recovery
    // path. Neither the secret nor the key is in the line.
    if (teamId !== undefined || keyId !== undefined || privateKey !== undefined) {
      console.warn("auth_apple_explicit_client_secret", { rotated: false, reason: "AUTH_APPLE_CLIENT_SECRET is set, so the signing key is unused" });
    }
    return { clientId, credential: { kind: "secret", clientSecret }, ...rest };
  }
  if (teamId === undefined || keyId === undefined || privateKey === undefined) throw configError("AUTH_APPLE sign-in credentials");
  try {
    parseApplePrivateKey(privateKey);
  } catch (error: unknown) {
    throw configError(`AUTH_APPLE_PRIVATE_KEY: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  return { clientId, credential: { kind: "key", signingKey: { teamId, keyId, privateKey } }, ...rest };
}

// Secrets only, so this reads the environment and never the YAML file.
//
// Absent AUTH_SECRET means no sign-in at all, whatever the provider variables
// say, because better-auth cannot sign a session without it.
function authConfig(env: NodeJS.ProcessEnv, readFile: ((path: string) => string) | undefined): AuthConfig | undefined {
  const apple = appleAuthConfig(env, readFile);
  // The first entry must be the web client ID because the OAuth code exchange uses it.
  const googleClientId = (env.AUTH_GOOGLE_CLIENT_ID ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
  const googleClientSecret = setValue(env.AUTH_GOOGLE_CLIENT_SECRET);
  let google: AuthConfig["google"];
  if (googleClientId.length > 0 && googleClientSecret !== undefined) {
    google = { clientId: googleClientId, clientSecret: googleClientSecret };
  } else if (googleClientId.length > 0 || googleClientSecret !== undefined) {
    throw configError("AUTH_GOOGLE sign-in credentials");
  }
  if (apple === undefined && google === undefined) return undefined;
  const secret = setValue(env.AUTH_SECRET);
  if (secret === undefined) throw configError("AUTH_SECRET");
  return {
    secret,
    ...(apple === undefined ? {} : { apple }),
    ...(google === undefined ? {} : { google }),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv, readFile?: (path: string) => string): Config {
  const file = readConfiguration(env, readFile);
  const listen = stringValue(env, "LISTEN", file.listen) ?? ":8080";
  if (!/^:\d+$/.test(listen)) throw configError("listen");
  const port = portValue(env.PORT ?? listen.slice(1));
  const relayContent = stringValue(env, "RELAY_CONTENT", file["relay-content"]) ?? "none";
  if (relayContent !== "none" && relayContent !== "full") throw configError("relay-content");
  const apns = apnsConfig(env, file);
  const fcm = fcmConfig(env, file);
  const revenueCatSecret = stringValue(env, "REVENUECAT_SHARED_SECRET", file.revenuecat?.["shared-secret"]);
  // REVENUECAT_ENTITLEMENTS wins over the file, the same way every other
  // value here does. Empty or unset falls back to the file, and no file
  // leaves the map empty.
  const revenueCatEntitlements = entitlementsValue(env.REVENUECAT_ENTITLEMENTS) ?? file.revenuecat?.entitlements ?? {};
  const allowNoopPush = env.NODE_ENV !== "production" && env.ALLOW_NOOP_PUSH === "true";
  if (apns === undefined && fcm === undefined && !allowNoopPush) {
    if (env.NODE_ENV !== "production") throw configError("push provider");
  }
  const relayUrlExplicit = stringValue(env, "RELAY_URL", file["relay-url"]) !== undefined;
  const hasProvider = apns !== undefined || fcm !== undefined;
  // api.md §3.4: mode is a setting, not a guess. The inference below is kept for
  // deployments that never set it, and it reads one operator wrong: someone
  // self-hosting with their own APNs key has a provider and no relay URL, so the
  // guess says "relay" and mounts accounts, caps and billing on their hardware.
  // Writing mode down stops the guess from running at all.
  const configuredMode = stringValue(env, "MODE", file.mode);
  if (configuredMode !== undefined && configuredMode !== "selfhosted" && configuredMode !== "relay" && configuredMode !== "hosted") throw configError("mode");
  const mode = (configuredMode as Config["mode"]) ?? (hasProvider ? (relayUrlExplicit ? "hosted" : "relay") : "selfhosted");
  // An empty secret is a configuration error in every mode. It is defined, so it
  // passed the production check below, and then the webhook compared "" with the
  // "" of a request that carried no Authorization header.
  if (revenueCatSecret === "") throw configError("RevenueCat shared secret");
  if (env.NODE_ENV === "production" && mode !== "selfhosted" && revenueCatSecret === undefined) throw configError("RevenueCat shared secret");
  // A hosted production deployment with a shared secret and no map takes the
  // webhook, stores the event, and upgrades nobody, forever. Nothing about it
  // looks broken from the outside, so it fails startup instead.
  if (env.NODE_ENV === "production" && mode !== "selfhosted" && Object.keys(revenueCatEntitlements).length === 0) throw configError("RevenueCat entitlements");
  // The reconcile sweep (tier/reconcile.ts). Unset key means the sweep never
  // starts, which is the whole configuration a self-hosted server needs. Set
  // it without the project or without the entitlement map and startup stops:
  // a sweep that cannot name a project reads nothing, and one with an empty
  // map corrects nobody, and both look healthy from the outside.
  const revenueCatApiKey = stringValue(env, "REVENUECAT_SECRET_API_KEY", undefined);
  const revenueCatProjectId = stringValue(env, "REVENUECAT_PROJECT_ID", undefined);
  if (revenueCatApiKey === "") throw configError("RevenueCat secret API key");
  if (revenueCatApiKey !== undefined && (revenueCatProjectId === undefined || revenueCatProjectId === "")) throw configError("RevenueCat project id");
  if (revenueCatApiKey !== undefined && Object.keys(revenueCatEntitlements).length === 0) throw configError("RevenueCat entitlements");
  const authSettings = authConfig(env, readFile);
  return {
    mode,
    baseUrl: urlValue("base-url", stringValue(env, "BASE_URL", file["base-url"])),
    relayUrl: urlValue("relay-url", stringValue(env, "RELAY_URL", file["relay-url"]) ?? "https://relay.critalarm.app"),
    relayUrlExplicit,
    relayContent: relayContent as "none" | "full",
    listen,
    port,
    dataDir: stringValue(env, "DATA_DIR", file["data-dir"]) ?? "/data",
    behindProxy: env.BEHIND_PROXY === undefined ? file["behind-proxy"] ?? false : env.BEHIND_PROXY === "true",
    allowNoopPush,
    ...(env.STATS_KEY === undefined || env.STATS_KEY === "" ? {} : { statsKey: env.STATS_KEY }),
    // The secret POST /relay/v1/servers demands. Unset means the route is not
    // mounted on a relay, and a self-hosted server registers without one.
    ...(env.RELAY_REGISTRATION_SECRET === undefined || env.RELAY_REGISTRATION_SECRET === "" ? {} : { relayRegistrationSecret: env.RELAY_REGISTRATION_SECRET }),
    ...(apns === undefined ? {} : { apns }),
    ...(fcm === undefined ? {} : { fcm }),
    ...(revenueCatSecret === undefined ? {} : { revenueCat: { sharedSecret: revenueCatSecret, entitlements: revenueCatEntitlements } }),
    ...(revenueCatApiKey === undefined || revenueCatProjectId === undefined ? {} : { revenueCatApi: { secretApiKey: revenueCatApiKey, projectId: revenueCatProjectId, entitlements: revenueCatEntitlements } }),
    ...(authSettings === undefined ? {} : { auth: authSettings }),
  };
}
