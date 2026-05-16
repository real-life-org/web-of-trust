import { d as u, b as p, a as m, s as w, e as h } from "./encryption-CQ_TXPVX.js";
import { e as s, d as o } from "./broker-error-B2k9KKx_.js";
const P = 64;
async function b(i, r) {
  if (i.length !== P) throw new Error("Invalid identity seed format");
  const c = new Uint8Array(i), e = await u(p(c), r), a = new Uint8Array(e.ed25519Seed), t = new Uint8Array(e.x25519Seed), d = new Uint8Array(e.ed25519PublicKey), y = new Uint8Array(e.x25519PublicKey);
  return {
    did: e.did,
    kid: e.kid,
    ed25519PublicKey: d,
    x25519PublicKey: y,
    async signEd25519(n) {
      return new Uint8Array(await w(n, a));
    },
    async decryptForMe(n) {
      if (!n.ephemeralPublicKey) throw new Error("Missing ephemeral public key");
      return m({
        crypto: r,
        recipientPrivateSeed: t,
        message: {
          epk: s(n.ephemeralPublicKey),
          nonce: s(n.nonce),
          ciphertext: s(n.ciphertext)
        }
      });
    },
    async deriveFrameworkKey(n, l = 32) {
      return r.hkdfSha256(c, n, l);
    }
  };
}
async function g(i, r, c) {
  const e = crypto.getRandomValues(new Uint8Array(32)), a = crypto.getRandomValues(new Uint8Array(12)), t = await h({
    crypto: i,
    ephemeralPrivateSeed: e,
    recipientPublicKey: c,
    nonce: a,
    plaintext: r
  });
  return {
    ciphertext: o(t.ciphertext),
    nonce: o(t.nonce),
    ephemeralPublicKey: o(t.epk)
  };
}
export {
  b as c,
  g as e
};
