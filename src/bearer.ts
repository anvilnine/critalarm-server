import { createHash, timingSafeEqual } from "node:crypto";

// Compares a Bearer header against a configured secret. An empty secret and an
// empty or missing header both refuse, because comparing "" with "" used to let
// a caller with no Authorization header at all through. The sha256 digests keep
// the compare constant time whatever the two lengths are.
export function bearerSecretMatches(header: string | undefined, secret: string): boolean {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  if (secret === "" || supplied === "") return false;
  return timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(secret).digest());
}
