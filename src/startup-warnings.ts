import type { Config } from "./config.js";

// api.md §4.1, 1.26.0. relay-plain-hash stays on by default so a phone older
// than app 1.21.0 keeps getting pushes. On a self-hosted server that has a
// cost the operator should see once, at startup.
export function warnRelayPlainHash(config: Config, warn: (message: string) => void = console.warn): void {
  if (config.mode !== "selfhosted" || config.relayPlainHash === "off") return;
  warn("relay_plain_hash_on: RELAY_PLAIN_HASH is on, so anyone who guesses a topic name can subscribe to its pushes at the relay. Turn it off (RELAY_PLAIN_HASH=off) once every phone runs app 1.21.0 or later.");
}
