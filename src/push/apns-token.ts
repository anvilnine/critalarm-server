import { signJwt } from "./jwt.js";
import type { PrivateKey } from "./types.js";

// The APNs provider token: an ES256 JWT that every request to Apple carries.
// Apple limits how often a provider may present a new one, so there is one of
// these per signing key and every sender that uses the key is given it. A
// sender that is given none makes its own, which is the same thing for a
// process with one sender.
//
// The token is kept for 50 minutes and then signed again by whichever sender
// asks next. Apple refuses one older than an hour.
export class ApnsProviderToken {
  private cached: { value: string; issuedAt: number } | null = null;
  // How many tokens have been signed. Read by tests.
  minted = 0;

  constructor(private readonly key: { teamId: string; keyId: string; privateKey: PrivateKey }) {}

  get(now: number): string {
    if (this.cached !== null && now - this.cached.issuedAt < 50 * 60) return this.cached.value;
    const value = signJwt({ alg: "ES256", kid: this.key.keyId }, { iss: this.key.teamId, iat: now }, this.key.privateKey, "ES256");
    this.cached = { value, issuedAt: now };
    this.minted += 1;
    return value;
  }
}
