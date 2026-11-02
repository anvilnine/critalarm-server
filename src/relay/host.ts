// api.md §3.8. The host part of a relay URL, lower case, with the port when the
// URL names one that is not the default. This is the value a challenge answer
// carries as `relay`, and it is what the relay's own Host header reads when the
// server calls it (fetch leaves the default port out of Host, as URL does here).
export function relayHost(relayUrl: string): string | undefined {
  try {
    const url = new URL(relayUrl);
    return url.host === "" ? undefined : url.host.toLowerCase();
  } catch {
    return undefined;
  }
}
