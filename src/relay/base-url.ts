// api.md §4.1. The rules a base_url must meet before the relay calls it. The
// port is 443 (the default) or 8443. The
// whole string is matched, so the URL parser never gets to normalise a host or
// a path into something the server did not send.

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa"];
const BASE_URL = /^https:\/\/([A-Za-z0-9.-]+)(?::(443|8443))?((?:\/[A-Za-z0-9._~-]+)*)$/;

export interface ParsedBaseUrl { host: string; port: number; path: string; }

export function parseBaseUrl(baseUrl: string): ParsedBaseUrl | undefined {
  if (baseUrl.length > 200) return undefined;
  const match = BASE_URL.exec(baseUrl);
  if (match === null) return undefined;
  const host = (match[1] ?? "").toLowerCase();
  const port = match[2] === undefined ? 443 : Number(match[2]);
  // A path segment of "." or ".." would let a URL parser rewrite the path the
  // relay calls. The stored and hashed string stays what the server sent.
  const path = match[3] ?? "";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  const labels = host.split(".");
  if (labels.length < 2) return undefined;
  if (labels.some((label) => label === "" || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return undefined;
  // An IP literal in any dotted form. A numeric last label never names a real
  // top-level domain.
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return undefined;
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined;
  return { host, port, path };
}
