import { h as l, f, t as c, v as y } from "./jws-8PD3qxx2.js";
import { r as u, x as p } from "./did-key-CMSqoIj7.js";
class D {
  static async createProfileDocument(t, r, i = Date.now()) {
    if (t.did !== r.getDid()) throw new Error("Profile DID does not match identity");
    const o = await r.getEncryptionPublicKeyBytes(), a = u(t.did, {
      keyAgreement: [
        {
          id: "#enc-0",
          type: "X25519KeyAgreementKey2020",
          controller: t.did,
          publicKeyMultibase: p(o)
        }
      ]
    });
    return {
      did: t.did,
      version: i,
      didDocument: a,
      profile: v(t),
      updatedAt: t.updatedAt
    };
  }
  /**
   * Sign a public profile as JWS using the identity's private key
   */
  static async signProfile(t, r, i = {}) {
    return r.signJws(await this.createProfileDocument(t, r, i.version));
  }
  static async verifySignedPayload(t) {
    try {
      const r = l(t);
      if (!d(r)) return { valid: !1, error: "Invalid JWS payload" };
      if (typeof r.did != "string" || !r.did.startsWith("did:key:z"))
        return { valid: !1, error: "Missing or invalid DID in payload" };
      const i = f(r.did), o = await crypto.subtle.importKey(
        "raw",
        c(i),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ), a = await y(t, o);
      return a.valid ? { valid: !0, payload: a.payload } : { valid: !1, error: a.error ?? "Signature verification failed" };
    } catch (r) {
      return { valid: !1, error: r instanceof Error ? r.message : "Verification failed" };
    }
  }
  /**
   * Verify a JWS-signed profile.
   * Extracts the DID from the payload, resolves the public key,
   * and verifies the signature.
   */
  static async verifyProfile(t) {
    try {
      const r = l(t);
      if (!r || typeof r != "object")
        return { valid: !1, error: "Invalid JWS payload" };
      const i = r;
      if (!i.did || !i.did.startsWith("did:key:z"))
        return { valid: !1, error: "Missing or invalid DID in profile" };
      if (!Number.isInteger(i.version) || i.version < 0)
        return { valid: !1, error: "Missing or invalid profile version" };
      if (!d(i.didDocument) || i.didDocument.id !== i.did)
        return { valid: !1, error: "Missing or invalid DID document" };
      if (!d(i.profile) || typeof i.profile.name != "string" || i.profile.name.length === 0)
        return { valid: !1, error: "Missing or invalid profile metadata" };
      if ("encryptionPublicKey" in i.profile)
        return { valid: !1, error: "Profile metadata must not contain encryptionPublicKey" };
      if (typeof i.updatedAt != "string")
        return { valid: !1, error: "Missing or invalid updatedAt" };
      const o = f(i.did), a = await crypto.subtle.importKey(
        "raw",
        c(o),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ), n = await y(t, a);
      if (!n.valid)
        return { valid: !1, error: n.error ?? "Signature verification failed" };
      const s = n.payload;
      return {
        valid: !0,
        profile: g(s),
        didDocument: s.didDocument,
        version: s.version
      };
    } catch (r) {
      return {
        valid: !1,
        error: r instanceof Error ? r.message : "Verification failed"
      };
    }
  }
}
function v(e) {
  var t, r, i;
  return {
    name: e.name,
    ...e.bio ? { bio: e.bio } : {},
    ...e.avatar ? { avatar: e.avatar } : {},
    ...(t = e.offers) != null && t.length ? { offers: e.offers } : {},
    ...(r = e.needs) != null && r.length ? { needs: e.needs } : {},
    ...(i = e.protocols) != null && i.length ? { protocols: e.protocols } : {}
  };
}
function g(e) {
  var t, r, i;
  return {
    did: e.did,
    name: e.profile.name,
    ...e.profile.bio ? { bio: e.profile.bio } : {},
    ...e.profile.avatar ? { avatar: e.profile.avatar } : {},
    ...(t = e.profile.offers) != null && t.length ? { offers: e.profile.offers } : {},
    ...(r = e.profile.needs) != null && r.length ? { needs: e.profile.needs } : {},
    ...(i = e.profile.protocols) != null && i.length ? { protocols: e.profile.protocols } : {},
    updatedAt: e.updatedAt
  };
}
function d(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e);
}
export {
  D as P
};
