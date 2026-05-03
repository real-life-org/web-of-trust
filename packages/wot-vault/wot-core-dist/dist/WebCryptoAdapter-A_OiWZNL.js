var E = Object.defineProperty;
var S = (o, e, t) => e in o ? E(o, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : o[e] = t;
var u = (o, e, t) => S(o, typeof e != "symbol" ? e + "" : e, t);
import { a as y, b as l, t as i, c as m, f as h } from "./jws-8PD3qxx2.js";
import { g as A } from "./index-D3HkpEuJ.js";
const a = class a {
  constructor() {
    // 30 minutes
    u(this, "db", null);
  }
  /**
   * Initialize IndexedDB
   */
  async init() {
    return new Promise((e, t) => {
      const r = indexedDB.open(a.DB_NAME, 2);
      r.onerror = () => t(r.error), r.onsuccess = () => {
        this.db = r.result, e();
      }, r.onupgradeneeded = (s) => {
        const n = s.target.result;
        n.objectStoreNames.contains(a.STORE_NAME) || n.createObjectStore(a.STORE_NAME), n.objectStoreNames.contains(a.SESSION_STORE_NAME) || n.createObjectStore(a.SESSION_STORE_NAME);
      };
    });
  }
  /**
   * Store encrypted seed
   *
   * @param seed - Master seed bytes; the caller owns the seed format/version.
   * @param passphrase - User's passphrase
   */
  async storeSeed(e, t) {
    this.db || await this.init();
    const r = crypto.getRandomValues(new Uint8Array(16)), s = await this.deriveEncryptionKey(t, r), n = crypto.getRandomValues(new Uint8Array(12)), c = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: n },
      s,
      e
    ), p = {
      ciphertext: y(new Uint8Array(c)),
      salt: y(r),
      iv: y(n)
    };
    return new Promise((w, d) => {
      const K = this.db.transaction([a.STORE_NAME], "readwrite").objectStore(a.STORE_NAME).put(p, "master-seed");
      K.onerror = () => d(K.error), K.onsuccess = () => w();
    });
  }
  /**
   * Load and decrypt seed using passphrase.
   * On success, caches the derived CryptoKey as session key.
   *
   * @param passphrase - User's passphrase
   * @returns Decrypted seed or null if not found
   */
  async loadSeed(e) {
    this.db || await this.init();
    const t = await this.getEncryptedSeed();
    if (!t)
      return null;
    try {
      const r = l(t.salt), s = await this.deriveEncryptionKey(e, r), n = l(t.iv), c = l(t.ciphertext), p = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: n },
        s,
        c
      );
      return await this.storeSessionKey(s), new Uint8Array(p);
    } catch {
      throw new Error("Invalid passphrase");
    }
  }
  /**
   * Load and decrypt seed using cached session key (no passphrase needed).
   * Returns null if no session key, session expired, or decryption fails.
   */
  async loadSeedWithSessionKey() {
    this.db || await this.init();
    const e = await this.getSessionEntry();
    if (!e)
      return null;
    if (Date.now() > e.expiresAt)
      return await this.clearSessionKey(), null;
    const t = await this.getEncryptedSeed();
    if (!t)
      return null;
    try {
      const r = l(t.iv), s = l(t.ciphertext), n = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: r },
        e.key,
        s
      );
      return await this.storeSessionKey(e.key), new Uint8Array(n);
    } catch {
      return await this.clearSessionKey(), null;
    }
  }
  /**
   * Check if a valid (non-expired) session key exists
   */
  async hasActiveSession() {
    this.db || await this.init();
    const e = await this.getSessionEntry();
    return e ? Date.now() > e.expiresAt ? (await this.clearSessionKey(), !1) : !0 : !1;
  }
  /**
   * Check if seed exists in storage
   */
  async hasSeed() {
    return this.db || await this.init(), await this.getEncryptedSeed() !== null;
  }
  /**
   * Delete stored seed and session key
   */
  async deleteSeed() {
    return this.db || await this.init(), await this.clearSessionKey(), new Promise((e, t) => {
      const n = this.db.transaction([a.STORE_NAME], "readwrite").objectStore(a.STORE_NAME).delete("master-seed");
      n.onerror = () => t(n.error), n.onsuccess = () => e();
    });
  }
  /**
   * Clear the cached session key
   */
  async clearSessionKey() {
    return this.db || await this.init(), new Promise((e, t) => {
      const n = this.db.transaction([a.SESSION_STORE_NAME], "readwrite").objectStore(a.SESSION_STORE_NAME).delete("session-key");
      n.onerror = () => t(n.error), n.onsuccess = () => e();
    });
  }
  // Private methods
  async storeSessionKey(e, t = a.DEFAULT_SESSION_TTL) {
    const r = {
      key: e,
      expiresAt: Date.now() + t
    };
    return new Promise((s, n) => {
      const w = this.db.transaction([a.SESSION_STORE_NAME], "readwrite").objectStore(a.SESSION_STORE_NAME).put(r, "session-key");
      w.onerror = () => n(w.error), w.onsuccess = () => s();
    });
  }
  async getSessionEntry() {
    return new Promise((e, t) => {
      const n = this.db.transaction([a.SESSION_STORE_NAME], "readonly").objectStore(a.SESSION_STORE_NAME).get("session-key");
      n.onerror = () => t(n.error), n.onsuccess = () => e(n.result || null);
    });
  }
  async getEncryptedSeed() {
    return new Promise((e, t) => {
      const n = this.db.transaction([a.STORE_NAME], "readonly").objectStore(a.STORE_NAME).get("master-seed");
      n.onerror = () => t(n.error), n.onsuccess = () => e(n.result || null);
    });
  }
  async deriveEncryptionKey(e, t) {
    const r = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(e),
      "PBKDF2",
      !1,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: t,
        iterations: a.PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      r,
      { name: "AES-GCM", length: 256 },
      !1,
      // non-extractable
      ["encrypt", "decrypt"]
    );
  }
};
u(a, "DB_NAME", "wot-identity"), u(a, "STORE_NAME", "seeds"), u(a, "SESSION_STORE_NAME", "session"), u(a, "PBKDF2_ITERATIONS", 1e5), u(a, "DEFAULT_SESSION_TTL", 1800 * 1e3);
let b = a;
class v {
  constructor(e) {
    u(this, "_brand", "MasterKeyHandle");
    this.key = e;
  }
}
class f {
  constructor(e) {
    u(this, "_brand", "EncryptionKeyPair");
    this.keyPair = e;
  }
}
function P(o) {
  const e = new Uint8Array([
    48,
    46,
    // SEQUENCE (46 bytes)
    2,
    1,
    0,
    // INTEGER version = 0
    48,
    5,
    // SEQUENCE (5 bytes)
    6,
    3,
    43,
    101,
    110,
    // OID 1.3.101.110 (X25519)
    4,
    34,
    // OCTET STRING (34 bytes)
    4,
    32
    // OCTET STRING (32 bytes)
  ]), t = new Uint8Array(e.length + o.length);
  return t.set(e), t.set(o, e.length), t;
}
class T {
  async generateKeyPair() {
    const e = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      !0,
      ["sign", "verify"]
    );
    return {
      publicKey: e.publicKey,
      privateKey: e.privateKey
    };
  }
  async exportKeyPair(e) {
    const [t, r] = await Promise.all([
      crypto.subtle.exportKey("raw", e.publicKey),
      crypto.subtle.exportKey("pkcs8", e.privateKey)
    ]);
    return {
      publicKey: y(new Uint8Array(t)),
      privateKey: y(new Uint8Array(r))
    };
  }
  async importKeyPair(e) {
    const t = l(e.publicKey), r = l(e.privateKey), [s, n] = await Promise.all([
      crypto.subtle.importKey(
        "raw",
        i(t),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ),
      crypto.subtle.importKey(
        "pkcs8",
        i(r),
        { name: "Ed25519" },
        !0,
        ["sign"]
      )
    ]);
    return { publicKey: s, privateKey: n };
  }
  async exportPublicKey(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return y(new Uint8Array(t));
  }
  async importPublicKey(e) {
    const t = l(e);
    return crypto.subtle.importKey(
      "raw",
      i(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  async createDid(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return m(new Uint8Array(t));
  }
  async didToPublicKey(e) {
    const t = h(e);
    return crypto.subtle.importKey(
      "raw",
      i(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  async sign(e, t) {
    const r = await crypto.subtle.sign(
      { name: "Ed25519" },
      t,
      i(e)
    );
    return new Uint8Array(r);
  }
  async verify(e, t, r) {
    return crypto.subtle.verify(
      { name: "Ed25519" },
      r,
      i(t),
      i(e)
    );
  }
  async signString(e, t) {
    const r = new TextEncoder(), s = await this.sign(r.encode(e), t);
    return y(s);
  }
  async verifyString(e, t, r) {
    const s = new TextEncoder();
    return this.verify(s.encode(e), l(t), r);
  }
  // Symmetric Encryption (AES-256-GCM for Group Spaces)
  async generateSymmetricKey() {
    const e = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      !0,
      ["encrypt", "decrypt"]
    ), t = await crypto.subtle.exportKey("raw", e);
    return new Uint8Array(t);
  }
  async encryptSymmetric(e, t) {
    const r = crypto.getRandomValues(new Uint8Array(12)), s = await crypto.subtle.importKey(
      "raw",
      i(t),
      { name: "AES-GCM" },
      !1,
      ["encrypt"]
    ), n = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: r },
      s,
      i(e)
    );
    return { ciphertext: new Uint8Array(n), nonce: r };
  }
  async decryptSymmetric(e, t, r) {
    const s = await crypto.subtle.importKey(
      "raw",
      i(r),
      { name: "AES-GCM" },
      !1,
      ["decrypt"]
    ), n = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: t },
      s,
      i(e)
    );
    return new Uint8Array(n);
  }
  generateNonce() {
    const e = new Uint8Array(32);
    return crypto.getRandomValues(e), y(e);
  }
  async hashData(e) {
    const t = await crypto.subtle.digest("SHA-256", i(e));
    return new Uint8Array(t);
  }
  // --- Deterministic Key Derivation ---
  async importMasterKey(e) {
    const t = await crypto.subtle.importKey(
      "raw",
      i(e),
      { name: "HKDF" },
      !1,
      ["deriveKey", "deriveBits"]
    );
    return new v(t);
  }
  async deriveBits(e, t, r) {
    const s = e, n = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode(t)
      },
      s.key,
      r
    );
    return new Uint8Array(n);
  }
  async deriveKeyPairFromSeed(e) {
    const t = await A(e), r = {
      kty: "OKP",
      crv: "Ed25519",
      x: y(new Uint8Array(t.buffer)),
      d: y(new Uint8Array(e.buffer)),
      ext: !1,
      key_ops: ["sign"]
    }, s = {
      kty: "OKP",
      crv: "Ed25519",
      x: y(new Uint8Array(t.buffer)),
      ext: !0,
      key_ops: ["verify"]
    }, [n, c] = await Promise.all([
      crypto.subtle.importKey("jwk", r, "Ed25519", !1, ["sign"]),
      crypto.subtle.importKey("jwk", s, "Ed25519", !0, ["verify"])
    ]);
    return { publicKey: c, privateKey: n };
  }
  // --- Asymmetric Encryption (ECIES) ---
  async deriveEncryptionKeyPair(e) {
    const t = P(e), r = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !1,
      ["deriveBits"]
    ), s = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !0,
      ["deriveBits"]
    ), n = await crypto.subtle.exportKey("jwk", s), c = await crypto.subtle.importKey(
      "jwk",
      { kty: n.kty, crv: n.crv, x: n.x },
      { name: "X25519" },
      !0,
      []
    );
    return new f({ privateKey: r, publicKey: c });
  }
  async deriveEciesKey(e, t) {
    const r = await crypto.subtle.importKey(
      "raw",
      e,
      { name: "HKDF" },
      !1,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode("wot-ecies-v1")
      },
      r,
      { name: "AES-GCM", length: 256 },
      !1,
      [t]
    );
  }
  async exportEncryptionPublicKey(e) {
    const t = e, r = await crypto.subtle.exportKey("raw", t.keyPair.publicKey);
    return new Uint8Array(r);
  }
  async encryptAsymmetric(e, t) {
    const r = await crypto.subtle.generateKey(
      { name: "X25519" },
      !0,
      ["deriveBits"]
    ), s = await crypto.subtle.importKey(
      "raw",
      i(t),
      { name: "X25519" },
      !0,
      []
    ), n = await crypto.subtle.deriveBits(
      { name: "X25519", public: s },
      r.privateKey,
      256
    ), c = await this.deriveEciesKey(n, "encrypt"), p = crypto.getRandomValues(new Uint8Array(12)), w = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: p },
      c,
      i(e)
    ), d = new Uint8Array(
      await crypto.subtle.exportKey("raw", r.publicKey)
    );
    return {
      ciphertext: new Uint8Array(w),
      nonce: p,
      ephemeralPublicKey: d
    };
  }
  async decryptAsymmetric(e, t) {
    const r = t;
    if (!e.ephemeralPublicKey)
      throw new Error("Missing ephemeral public key");
    const s = await crypto.subtle.importKey(
      "raw",
      i(e.ephemeralPublicKey),
      { name: "X25519" },
      !0,
      []
    ), n = await crypto.subtle.deriveBits(
      { name: "X25519", public: s },
      r.keyPair.privateKey,
      256
    ), c = await this.deriveEciesKey(n, "decrypt"), p = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: e.nonce },
      c,
      i(e.ciphertext)
    );
    return new Uint8Array(p);
  }
  // --- Utilities ---
  randomBytes(e) {
    return crypto.getRandomValues(new Uint8Array(e));
  }
}
export {
  b as S,
  T as W
};
