/**
 * Short, safe label for why a database call failed.
 *
 * Included in the 503 body because the alternative is reading container logs,
 * and the three realistic causes need very different fixes:
 *
 *   28P01  password authentication failed  -> the password in DATABASE_URL is
 *          wrong, most often because it was pasted raw instead of
 *          percent-encoded, so a special character truncated the string
 *   ENOTFOUND / EAI_AGAIN  -> the host in DATABASE_URL is wrong or DNS is broken
 *   ETIMEDOUT / ECONNREFUSED  -> the host cannot be reached on that port,
 *          usually egress filtering rather than anything in the config
 *   3D000  database does not exist
 *
 * These carry no credential material: no host, no user, no password, no query.
 * A caller learns only which class of misconfiguration is present, which is
 * information an operator needs and an attacker cannot use.
 */
export function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return "";
  // Bound the length so an unexpected driver cannot turn this into a channel
  // for arbitrary text.
  return ` (${code.slice(0, 16)})`;
}
