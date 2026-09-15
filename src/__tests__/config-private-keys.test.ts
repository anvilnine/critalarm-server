import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const REAL_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA",
  "-----END PRIVATE KEY-----",
].join("\n");

const ESCAPED_PEM = REAL_PEM.replace(/\n/g, "\\n");

function env(privateKey: string): NodeJS.ProcessEnv {
  return {
    BASE_URL: "https://alerts.example.com",
    RELAY_URL: "https://alerts.example.com",
    DATA_DIR: "/tmp",
    FCM_PROJECT_ID: "crit-alarm",
    FCM_CLIENT_EMAIL: "pusher@crit-alarm.iam.gserviceaccount.com",
    FCM_PRIVATE_KEY: privateKey,
  };
}

describe("a private key pasted out of a service account JSON", () => {
  it("has its escaped newlines turned into real ones", () => {
    // This is the whole bug. A service account JSON stores the key with
    // literal two-character \n sequences. Pasting that value in is what
    // everyone does, and Node answered "DECODER routines::unsupported".
    const config = loadConfig(env(ESCAPED_PEM));

    expect(config.fcm?.privateKey).toBe(REAL_PEM);
    expect(config.fcm?.privateKey).not.toContain("\\n");
  });

  it("leaves a key that already has real newlines alone", () => {
    const config = loadConfig(env(REAL_PEM));

    expect(config.fcm?.privateKey).toBe(REAL_PEM);
  });

  it("both forms parse to the same key", () => {
    expect(loadConfig(env(ESCAPED_PEM)).fcm?.privateKey).toBe(
      loadConfig(env(REAL_PEM)).fcm?.privateKey,
    );
  });
});
