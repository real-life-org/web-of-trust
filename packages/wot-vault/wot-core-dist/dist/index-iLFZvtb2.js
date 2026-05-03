function r(i) {
  return i.buffer.slice(i.byteOffset, i.byteOffset + i.byteLength);
}
function o(i) {
  const e = new Uint8Array([
    48,
    46,
    2,
    1,
    0,
    48,
    5,
    6,
    3,
    43,
    101,
    110,
    4,
    34,
    4,
    32
  ]), t = new Uint8Array(e.length + i.length);
  return t.set(e), t.set(i, e.length), t;
}
class s {
  async verifyEd25519(e, t, a) {
    const n = await crypto.subtle.importKey("raw", r(a), { name: "Ed25519" }, !1, ["verify"]);
    return crypto.subtle.verify("Ed25519", n, r(t), r(e));
  }
  async sha256(e) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", r(e)));
  }
  async hkdfSha256(e, t, a) {
    const n = await crypto.subtle.importKey("raw", r(e), "HKDF", !1, ["deriveBits"]), c = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(t)
      },
      n,
      a * 8
    );
    return new Uint8Array(c);
  }
  async x25519PublicFromSeed(e) {
    const t = await crypto.subtle.importKey("pkcs8", r(o(e)), { name: "X25519" }, !0, ["deriveBits"]), a = await crypto.subtle.exportKey("jwk", t);
    if (!a.x) throw new Error("X25519 public key export failed");
    const n = atob(a.x.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(n, (c) => c.charCodeAt(0));
  }
  async x25519SharedSecret(e, t) {
    const a = await crypto.subtle.importKey(
      "pkcs8",
      r(o(e)),
      { name: "X25519" },
      !1,
      ["deriveBits"]
    ), n = await crypto.subtle.importKey("raw", r(t), { name: "X25519" }, !1, []), c = await crypto.subtle.deriveBits({ name: "X25519", public: n }, a, 256);
    return new Uint8Array(c);
  }
  async aes256GcmEncrypt(e, t, a) {
    const n = await crypto.subtle.importKey("raw", r(e), { name: "AES-GCM" }, !1, ["encrypt"]), c = await crypto.subtle.encrypt({ name: "AES-GCM", iv: r(t), tagLength: 128 }, n, r(a));
    return new Uint8Array(c);
  }
  async aes256GcmDecrypt(e, t, a) {
    const n = await crypto.subtle.importKey("raw", r(e), { name: "AES-GCM" }, !1, ["decrypt"]), c = await crypto.subtle.decrypt({ name: "AES-GCM", iv: r(t), tagLength: 128 }, n, r(a));
    return new Uint8Array(c);
  }
}
const y = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  WebCryptoProtocolCryptoAdapter: s
}, Symbol.toStringTag, { value: "Module" }));
export {
  s as W,
  y as i
};
