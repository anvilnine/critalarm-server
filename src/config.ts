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
}

export interface Config {
  baseUrl: string;
  relayUrl: string;
  relayContent: "none";
  listen: string;
  port: number;
  dataDir: string;
  behindProxy: boolean;
  allowNoopPush?: boolean;
  apns?: ApnsConfig;
  fcm?: FcmConfig;
  revenueCat?: RevenueCatConfig;
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
  "base-url": z.string().optional(),
  "relay-url": z.string().optional(),
  "relay-content": z.string().optional(),
  listen: z.string().optional(),
  "data-dir": z.string().optional(),
  "behind-proxy": z.boolean().optional(),
  apns: providerSchema,
  fcm: fcmSchema,
  revenuecat: z.object({ "shared-secret": z.string().min(1).optional() }).optional(),
});

type FileConfig = z.infer<typeof fileSchema>;

function configError(field: string): Error {
  return new Error(`invalid configuration: ${field}`);
}

function readConfiguration(env: NodeJS.ProcessEnv, readFile: ((path: string) => string) | undefined): FileConfig {
  if (env.CONFIG_PATH === undefined && readFile === undefined) return {};
  let parsed: unknown;
  try {
    parsed = parse((readFile ?? ((path) => readFileSync(path, "utf8")))(env.CONFIG_PATH ?? "critalarm.yml"));
  } catch {
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

function apnsConfig(env: NodeJS.ProcessEnv, file: FileConfig): ApnsConfig | undefined {
  const values = {
    teamId: stringValue(env, "APNS_TEAM_ID", file.apns?.["team-id"]),
    keyId: stringValue(env, "APNS_KEY_ID", file.apns?.["key-id"]),
    privateKey: stringValue(env, "APNS_PRIVATE_KEY", file.apns?.["private-key"]),
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
    privateKey: stringValue(env, "FCM_PRIVATE_KEY", file.fcm?.["private-key"]),
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

export function loadConfig(env: NodeJS.ProcessEnv, readFile?: (path: string) => string): Config {
  const file = readConfiguration(env, readFile);
  const listen = stringValue(env, "LISTEN", file.listen) ?? ":8080";
  if (!/^:\d+$/.test(listen)) throw configError("listen");
  const port = portValue(env.PORT ?? listen.slice(1));
  const relayContent = stringValue(env, "RELAY_CONTENT", file["relay-content"]) ?? "none";
  if (relayContent !== "none") throw configError("relay-content");
  const apns = apnsConfig(env, file);
  const fcm = fcmConfig(env, file);
  const revenueCatSecret = stringValue(env, "REVENUECAT_SHARED_SECRET", file.revenuecat?.["shared-secret"]);
  const allowNoopPush = env.NODE_ENV !== "production" && env.ALLOW_NOOP_PUSH === "true";
  if (apns === undefined && fcm === undefined && !allowNoopPush) throw configError("push provider");
  if (env.NODE_ENV === "production" && revenueCatSecret === undefined) throw configError("RevenueCat shared secret");
  return {
    baseUrl: urlValue("base-url", stringValue(env, "BASE_URL", file["base-url"])),
    relayUrl: urlValue("relay-url", stringValue(env, "RELAY_URL", file["relay-url"]) ?? "https://relay.critalarm.app"),
    relayContent: "none",
    listen,
    port,
    dataDir: stringValue(env, "DATA_DIR", file["data-dir"]) ?? "/data",
    behindProxy: env.BEHIND_PROXY === undefined ? file["behind-proxy"] ?? false : env.BEHIND_PROXY === "true",
    allowNoopPush,
    ...(apns === undefined ? {} : { apns }),
    ...(fcm === undefined ? {} : { fcm }),
    ...(revenueCatSecret === undefined ? {} : { revenueCat: { sharedSecret: revenueCatSecret } }),
  };
}
