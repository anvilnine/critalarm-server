import { createPrivateKey, type KeyObject } from "node:crypto";
import type { Clock } from "../incident/types.js";
import { signJwt } from "../push/jwt.js";

// api.md §3.7. Apple never hands out a client secret. An operator gets three
// things from the developer portal: a `.p8` private key, a Team ID and a Key
// ID. Apple's "client secret" is an ES256 JWT signed from those three with the
// Services ID as its subject, and it expires. better-auth takes a
// `clientSecret` string and uses it as given, so nothing else mints or rotates
// it. This module does.
//
// The signing code is `push/jwt.ts`, the same one APNs uses. APNs signs ES256
// from a `.p8` too, so there is one JWT signer here rather than two.

// Apple's token endpoint, and the `aud` of the client secret.
export const APPLE_AUDIENCE = "https://appleid.apple.com";

// Apple refuses a client secret whose `exp` is more than 15,777,000 seconds
// (about six months) out. Thirty days sits well inside that ceiling and means
// a secret that somehow leaks stops working in a month rather than in half a
// year.
export const CLIENT_SECRET_LIFETIME_S = 2_592_000;

// Apple's own ceiling, kept here so a test can prove the lifetime is under it.
export const APPLE_MAX_LIFETIME_S = 15_777_000;

// Re-mint a day before expiry. A secret handed out with a second left would be
// dead by the time Apple checked it.
export const CLIENT_SECRET_REFRESH_S = 86_400;

export interface AppleSigningKey {
  teamId: string;
  keyId: string;
  privateKey: string;
}

// Parses the `.p8` so a wrong file fails startup rather than the first sign-in
// weeks later. The key is never in the message: an operator who pasted the
// wrong file does not need it read back, and this repo is public and its logs
// get shared.
export function parseApplePrivateKey(privateKey: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new Error("not a readable PKCS8 private key");
  }
  // An FCM service account key parses fine and then fails at signing time,
  // which is a bad place to find out. Apple's sign-in keys are all P-256.
  if (key.asymmetricKeyType !== "ec") throw new Error(`not an elliptic-curve key (found ${String(key.asymmetricKeyType)})`);
  return key;
}

export function mintClientSecret(clientId: string, signingKey: AppleSigningKey, key: KeyObject, now: number): string {
  return signJwt(
    { alg: "ES256", kid: signingKey.keyId },
    { iss: signingKey.teamId, aud: APPLE_AUDIENCE, sub: clientId, iat: now, exp: now + CLIENT_SECRET_LIFETIME_S },
    key,
    "ES256",
  );
}

// Mints on first use, then re-mints a day before expiry. A process that has
// been up for five months hands out a live secret, and one restarted the day
// after expiry mints a fresh one instead of coming up broken. The clock is
// injected so a test can prove the re-mint instead of waiting a month for it.
export function appleClientSecretMinter(clientId: string, signingKey: AppleSigningKey, clock: Clock): () => string {
  const key = parseApplePrivateKey(signingKey.privateKey);
  let held: { value: string; expiresAt: number } | undefined;
  return () => {
    const now = clock.now();
    if (held !== undefined && now < held.expiresAt - CLIENT_SECRET_REFRESH_S) return held.value;
    const value = mintClientSecret(clientId, signingKey, key, now);
    held = { value, expiresAt: now + CLIENT_SECRET_LIFETIME_S };
    return value;
  };
}
