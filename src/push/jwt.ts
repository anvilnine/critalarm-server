import { createPrivateKey, KeyObject, sign } from "node:crypto";
import type { PrivateKey } from "./types.js";

function encodedJson(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signJwt(
  header: Record<string, string>,
  claims: Record<string, string | number>,
  privateKey: PrivateKey,
  algorithm: "ES256" | "RS256",
): string {
  const compact = `${encodedJson(header)}.${encodedJson(claims)}`;
  const input = Buffer.from(compact);
  const signature = algorithm === "ES256"
    ? sign("sha256", input, {
      key: privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey),
      dsaEncoding: "ieee-p1363",
    })
    : sign("sha256", input, privateKey);
  return `${compact}.${signature.toString("base64url")}`;
}
