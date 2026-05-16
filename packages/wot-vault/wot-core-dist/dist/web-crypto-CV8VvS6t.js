function r(i) {
  return i.buffer.slice(i.byteOffset, i.byteOffset + i.byteLength);
}
function s(i) {
  const t = new Uint8Array([
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
  ]), e = new Uint8Array(t.length + i.length);
  return e.set(t), e.set(i, t.length), e;
}
class y {
  async verifyEd25519(t, e, a) {
    const n = await crypto.subtle.importKey("raw", r(a), { name: "Ed25519" }, !1, ["verify"]);
    return crypto.subtle.verify("Ed25519", n, r(e), r(t));
  }
  async sha256(t) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", r(t)));
  }
  async hkdfSha256(t, e, a) {
    const n = await crypto.subtle.importKey("raw", r(t), "HKDF", !1, ["deriveBits"]), c = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(e)
      },
      n,
      a * 8
    );
    return new Uint8Array(c);
  }
  async x25519PublicFromSeed(t) {
    const e = await crypto.subtle.importKey("pkcs8", r(s(t)), { name: "X25519" }, !0, ["deriveBits"]), a = await crypto.subtle.exportKey("jwk", e);
    if (!a.x) throw new Error("X25519 public key export failed");
    const n = atob(a.x.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(n, (c) => c.charCodeAt(0));
  }
  async x25519SharedSecret(t, e) {
    const a = await crypto.subtle.importKey(
      "pkcs8",
      r(s(t)),
      { name: "X25519" },
      !1,
      ["deriveBits"]
    ), n = await crypto.subtle.importKey("raw", r(e), { name: "X25519" }, !1, []), c = await crypto.subtle.deriveBits({ name: "X25519", public: n }, a, 256);
    return new Uint8Array(c);
  }
  async aes256GcmEncrypt(t, e, a) {
    const n = await crypto.subtle.importKey("raw", r(t), { name: "AES-GCM" }, !1, ["encrypt"]), c = await crypto.subtle.encrypt({ name: "AES-GCM", iv: r(e), tagLength: 128 }, n, r(a));
    return new Uint8Array(c);
  }
  async aes256GcmDecrypt(t, e, a) {
    const n = await crypto.subtle.importKey("raw", r(t), { name: "AES-GCM" }, !1, ["decrypt"]), c = await crypto.subtle.decrypt({ name: "AES-GCM", iv: r(e), tagLength: 128 }, n, r(a));
    return new Uint8Array(c);
  }
}
export {
  y as W
};
