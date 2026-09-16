import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

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
export interface AuthConfig {
  secret: string;
  apple?: { clientId: string; clientSecret: string; appBundleIdentifier?: string };
  google?: { clientId: string; clientSecret: string };
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

// api.md §3.7. Secrets only, so this reads the environment and never the YAML
// file. A provider is either whole or absent: half a credential is a typo, not a
// configuration, and it fails startup loudly rather than mounting a sign-in
// surface that answers 500 on the callback.
//
// Absent AUTH_SECRET means no sign-in at all, whatever the provider variables
// say, because better-auth cannot sign a session without it.
function authConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const pair = (name: string): { clientId: string; clientSecret: string } | undefined => {
    const clientId = env[`${name}_CLIENT_ID`];
    const clientSecret = env[`${name}_CLIENT_SECRET`];
    if ((clientId ?? "") === "" && (clientSecret ?? "") === "") return undefined;
    if ((clientId ?? "") === "" || (clientSecret ?? "") === "") throw configError(`${name} sign-in credentials`);
    return { clientId: clientId as string, clientSecret: clientSecret as string };
  };
  const apple = pair("APPLE");
  const google = pair("GOOGLE");
  if (apple === undefined && google === undefined) return undefined;
  const secret = env.AUTH_SECRET;
  if (secret === undefined || secret === "") throw configError("AUTH_SECRET");
  const bundle = env.APPLE_APP_BUNDLE_IDENTIFIER;
  return {
    secret,
    ...(apple === undefined ? {} : { apple: { ...apple, ...(bundle === undefined || bundle === "" ? {} : { appBundleIdentifier: bundle }) } }),
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
  const authSettings = authConfig(env);
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
    ...(revenueCatSecret === undefined ? {} : { revenueCat: { sharedSecret: revenueCatSecret, entitlements: file.revenuecat?.entitlements ?? {} } }),
    ...(authSettings === undefined ? {} : { auth: authSettings }),
  };
}
