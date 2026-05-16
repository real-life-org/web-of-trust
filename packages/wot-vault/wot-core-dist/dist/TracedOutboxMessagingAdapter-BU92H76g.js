var N = Object.defineProperty;
var U = (c, e, t) => e in c ? N(c, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : c[e] = t;
var i = (c, e, t) => U(c, typeof e != "symbol" ? e + "" : e, t);
import { a as p, b as f, t as d, c as $, f as j, j as _, m as S, l as B, k as V } from "./capabilities-BZPrEd2A.js";
import { g as W } from "./encryption-CQ_TXPVX.js";
import { openDB as P } from "idb";
import { c as D } from "./identity-vault-handle-YmMvnXp9.js";
import { W as K } from "./web-crypto-CV8VvS6t.js";
import { e as G, d as H } from "./broker-error-B2k9KKx_.js";
import { P as E } from "./ProfileService-BL052r24.js";
import { g as y } from "./TraceLog-CuKPT7Eo.js";
import { g as I } from "./SpaceMetadataStorage-Diby-YzW.js";
class q {
  constructor(e) {
    i(this, "_brand", "MasterKeyHandle");
    this.key = e;
  }
}
class F {
  constructor(e) {
    i(this, "_brand", "EncryptionKeyPair");
    this.keyPair = e;
  }
}
function L(c) {
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
  ]), t = new Uint8Array(e.length + c.length);
  return t.set(e), t.set(c, e.length), t;
}
class le {
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
    const [t, s] = await Promise.all([
      crypto.subtle.exportKey("raw", e.publicKey),
      crypto.subtle.exportKey("pkcs8", e.privateKey)
    ]);
    return {
      publicKey: p(new Uint8Array(t)),
      privateKey: p(new Uint8Array(s))
    };
  }
  async importKeyPair(e) {
    const t = f(e.publicKey), s = f(e.privateKey), [r, n] = await Promise.all([
      crypto.subtle.importKey(
        "raw",
        d(t),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ),
      crypto.subtle.importKey(
        "pkcs8",
        d(s),
        { name: "Ed25519" },
        !0,
        ["sign"]
      )
    ]);
    return { publicKey: r, privateKey: n };
  }
  async exportPublicKey(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return p(new Uint8Array(t));
  }
  async importPublicKey(e) {
    const t = f(e);
    return crypto.subtle.importKey(
      "raw",
      d(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  async createDid(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return $(new Uint8Array(t));
  }
  async didToPublicKey(e) {
    const t = j(e);
    return crypto.subtle.importKey(
      "raw",
      d(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  async sign(e, t) {
    const s = await crypto.subtle.sign(
      { name: "Ed25519" },
      t,
      d(e)
    );
    return new Uint8Array(s);
  }
  async verify(e, t, s) {
    return crypto.subtle.verify(
      { name: "Ed25519" },
      s,
      d(t),
      d(e)
    );
  }
  async signString(e, t) {
    const s = new TextEncoder(), r = await this.sign(s.encode(e), t);
    return p(r);
  }
  async verifyString(e, t, s) {
    const r = new TextEncoder();
    return this.verify(r.encode(e), f(t), s);
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
    const s = crypto.getRandomValues(new Uint8Array(12)), r = await crypto.subtle.importKey(
      "raw",
      d(t),
      { name: "AES-GCM" },
      !1,
      ["encrypt"]
    ), n = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: s },
      r,
      d(e)
    );
    return { ciphertext: new Uint8Array(n), nonce: s };
  }
  async decryptSymmetric(e, t, s) {
    const r = await crypto.subtle.importKey(
      "raw",
      d(s),
      { name: "AES-GCM" },
      !1,
      ["decrypt"]
    ), n = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: t },
      r,
      d(e)
    );
    return new Uint8Array(n);
  }
  generateNonce() {
    const e = new Uint8Array(32);
    return crypto.getRandomValues(e), p(e);
  }
  async hashData(e) {
    const t = await crypto.subtle.digest("SHA-256", d(e));
    return new Uint8Array(t);
  }
  // --- Deterministic Key Derivation ---
  async importMasterKey(e) {
    const t = await crypto.subtle.importKey(
      "raw",
      d(e),
      { name: "HKDF" },
      !1,
      ["deriveKey", "deriveBits"]
    );
    return new q(t);
  }
  async deriveBits(e, t, s) {
    const r = e, n = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode(t)
      },
      r.key,
      s
    );
    return new Uint8Array(n);
  }
  async deriveKeyPairFromSeed(e) {
    const t = await W(e), s = {
      kty: "OKP",
      crv: "Ed25519",
      x: p(new Uint8Array(t.buffer)),
      d: p(new Uint8Array(e.buffer)),
      ext: !1,
      key_ops: ["sign"]
    }, r = {
      kty: "OKP",
      crv: "Ed25519",
      x: p(new Uint8Array(t.buffer)),
      ext: !0,
      key_ops: ["verify"]
    }, [n, a] = await Promise.all([
      crypto.subtle.importKey("jwk", s, "Ed25519", !1, ["sign"]),
      crypto.subtle.importKey("jwk", r, "Ed25519", !0, ["verify"])
    ]);
    return { publicKey: a, privateKey: n };
  }
  // --- Asymmetric Encryption (ECIES) ---
  async deriveEncryptionKeyPair(e) {
    const t = L(e), s = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !1,
      ["deriveBits"]
    ), r = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !0,
      ["deriveBits"]
    ), n = await crypto.subtle.exportKey("jwk", r), a = await crypto.subtle.importKey(
      "jwk",
      { kty: n.kty, crv: n.crv, x: n.x },
      { name: "X25519" },
      !0,
      []
    );
    return new F({ privateKey: s, publicKey: a });
  }
  async deriveEciesKey(e, t) {
    const s = await crypto.subtle.importKey(
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
      s,
      { name: "AES-GCM", length: 256 },
      !1,
      [t]
    );
  }
  async exportEncryptionPublicKey(e) {
    const t = e, s = await crypto.subtle.exportKey("raw", t.keyPair.publicKey);
    return new Uint8Array(s);
  }
  async encryptAsymmetric(e, t) {
    const s = await crypto.subtle.generateKey(
      { name: "X25519" },
      !0,
      ["deriveBits"]
    ), r = await crypto.subtle.importKey(
      "raw",
      d(t),
      { name: "X25519" },
      !0,
      []
    ), n = await crypto.subtle.deriveBits(
      { name: "X25519", public: r },
      s.privateKey,
      256
    ), a = await this.deriveEciesKey(n, "encrypt"), o = crypto.getRandomValues(new Uint8Array(12)), h = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: o },
      a,
      d(e)
    ), m = new Uint8Array(
      await crypto.subtle.exportKey("raw", s.publicKey)
    );
    return {
      ciphertext: new Uint8Array(h),
      nonce: o,
      ephemeralPublicKey: m
    };
  }
  async decryptAsymmetric(e, t) {
    const s = t;
    if (!e.ephemeralPublicKey)
      throw new Error("Missing ephemeral public key");
    const r = await crypto.subtle.importKey(
      "raw",
      d(e.ephemeralPublicKey),
      { name: "X25519" },
      !0,
      []
    ), n = await crypto.subtle.deriveBits(
      { name: "X25519", public: r },
      s.keyPair.privateKey,
      256
    ), a = await this.deriveEciesKey(n, "decrypt"), o = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: e.nonce },
      a,
      d(e.ciphertext)
    );
    return new Uint8Array(o);
  }
  // --- Utilities ---
  randomBytes(e) {
    return crypto.getRandomValues(new Uint8Array(e));
  }
}
const J = "web-of-trust", z = 2;
class ue {
  constructor() {
    i(this, "db", null);
  }
  async init() {
    this.db = await P(J, z, {
      upgrade(e) {
        e.objectStoreNames.contains("identity") || e.createObjectStore("identity", { keyPath: "did" }), e.objectStoreNames.contains("contacts") || e.createObjectStore("contacts", { keyPath: "did" }).createIndex("by-status", "status"), e.objectStoreNames.contains("verifications") || e.createObjectStore("verifications", { keyPath: "id" }).createIndex("by-from", "from"), e.objectStoreNames.contains("attestations") || e.createObjectStore("attestations", { keyPath: "id" }).createIndex("by-from", "from"), e.objectStoreNames.contains("attestationMetadata") || e.createObjectStore("attestationMetadata", { keyPath: "attestationId" });
      }
    });
  }
  ensureDb() {
    if (!this.db)
      throw new Error("Database not initialized. Call init() first.");
    return this.db;
  }
  // Identity methods
  async createIdentity(e, t) {
    const s = this.ensureDb(), r = (/* @__PURE__ */ new Date()).toISOString(), n = {
      did: e,
      profile: t,
      createdAt: r,
      updatedAt: r
    };
    return await s.put("identity", n), n;
  }
  async getIdentity() {
    return (await this.ensureDb().getAll("identity"))[0] || null;
  }
  async updateIdentity(e) {
    const t = this.ensureDb();
    e.updatedAt = (/* @__PURE__ */ new Date()).toISOString(), await t.put("identity", e);
  }
  // Contact methods
  async addContact(e) {
    await this.ensureDb().put("contacts", e);
  }
  async getContacts() {
    return this.ensureDb().getAll("contacts");
  }
  async getContact(e) {
    return await this.ensureDb().get("contacts", e) || null;
  }
  async updateContact(e) {
    const t = this.ensureDb();
    e.updatedAt = (/* @__PURE__ */ new Date()).toISOString(), await t.put("contacts", e);
  }
  async removeContact(e) {
    await this.ensureDb().delete("contacts", e);
  }
  // Verification methods (Empfänger-Prinzip)
  async saveVerification(e) {
    const t = this.ensureDb(), s = await t.getAll("verifications");
    for (const r of s)
      r.from === e.from && r.to === e.to && r.id !== e.id && await t.delete("verifications", r.id);
    await t.put("verifications", e);
  }
  async getReceivedVerifications() {
    const e = this.ensureDb(), t = await this.getIdentity();
    return t ? (await e.getAll("verifications")).filter((r) => r.to === t.did) : [];
  }
  async getAllVerifications() {
    return this.ensureDb().getAll("verifications");
  }
  async getVerification(e) {
    return await this.ensureDb().get("verifications", e) || null;
  }
  // Attestation methods (Empfänger-Prinzip)
  async saveAttestation(e) {
    const t = this.ensureDb();
    await t.put("attestations", e), await t.get("attestationMetadata", e.id) || await t.put("attestationMetadata", {
      attestationId: e.id,
      accepted: !1
    });
  }
  async getReceivedAttestations() {
    return this.ensureDb().getAll("attestations");
  }
  async getAttestation(e) {
    return await this.ensureDb().get("attestations", e) || null;
  }
  // Attestation Metadata methods
  async getAttestationMetadata(e) {
    return await this.ensureDb().get("attestationMetadata", e) || null;
  }
  async setAttestationAccepted(e, t) {
    const s = this.ensureDb(), r = {
      attestationId: e,
      accepted: t,
      ...t ? { acceptedAt: (/* @__PURE__ */ new Date()).toISOString() } : {}
    };
    await s.put("attestationMetadata", r);
  }
  // Lifecycle
  async clear() {
    const e = this.ensureDb();
    await Promise.all([
      e.clear("identity"),
      e.clear("contacts"),
      e.clear("verifications"),
      e.clear("attestations"),
      e.clear("attestationMetadata")
    ]);
  }
}
const l = class l {
  constructor() {
    // 30 minutes
    i(this, "db", null);
  }
  /**
   * Initialize IndexedDB
   */
  async init() {
    return new Promise((e, t) => {
      const s = indexedDB.open(l.DB_NAME, 2);
      s.onerror = () => t(s.error), s.onsuccess = () => {
        this.db = s.result, e();
      }, s.onupgradeneeded = (r) => {
        const n = r.target.result;
        n.objectStoreNames.contains(l.STORE_NAME) || n.createObjectStore(l.STORE_NAME), n.objectStoreNames.contains(l.SESSION_STORE_NAME) || n.createObjectStore(l.SESSION_STORE_NAME);
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
    const s = crypto.getRandomValues(new Uint8Array(16)), r = await this.deriveEncryptionKey(t, s), n = crypto.getRandomValues(new Uint8Array(12)), a = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: n },
      r,
      e
    ), o = {
      ciphertext: p(new Uint8Array(a)),
      salt: p(s),
      iv: p(n)
    };
    return new Promise((h, m) => {
      const g = this.db.transaction([l.STORE_NAME], "readwrite").objectStore(l.STORE_NAME).put(o, "master-seed");
      g.onerror = () => m(g.error), g.onsuccess = () => h();
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
      const s = f(t.salt), r = await this.deriveEncryptionKey(e, s), n = f(t.iv), a = f(t.ciphertext), o = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: n },
        r,
        a
      );
      return await this.storeSessionKey(r), new Uint8Array(o);
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
      const s = f(t.iv), r = f(t.ciphertext), n = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: s },
        e.key,
        r
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
      const n = this.db.transaction([l.STORE_NAME], "readwrite").objectStore(l.STORE_NAME).delete("master-seed");
      n.onerror = () => t(n.error), n.onsuccess = () => e();
    });
  }
  /**
   * Clear the cached session key
   */
  async clearSessionKey() {
    return this.db || await this.init(), new Promise((e, t) => {
      const n = this.db.transaction([l.SESSION_STORE_NAME], "readwrite").objectStore(l.SESSION_STORE_NAME).delete("session-key");
      n.onerror = () => t(n.error), n.onsuccess = () => e();
    });
  }
  // Private methods
  async storeSessionKey(e, t = l.DEFAULT_SESSION_TTL) {
    const s = {
      key: e,
      expiresAt: Date.now() + t
    };
    return new Promise((r, n) => {
      const h = this.db.transaction([l.SESSION_STORE_NAME], "readwrite").objectStore(l.SESSION_STORE_NAME).put(s, "session-key");
      h.onerror = () => n(h.error), h.onsuccess = () => r();
    });
  }
  async getSessionEntry() {
    return new Promise((e, t) => {
      const n = this.db.transaction([l.SESSION_STORE_NAME], "readonly").objectStore(l.SESSION_STORE_NAME).get("session-key");
      n.onerror = () => t(n.error), n.onsuccess = () => e(n.result || null);
    });
  }
  async getEncryptedSeed() {
    return new Promise((e, t) => {
      const n = this.db.transaction([l.STORE_NAME], "readonly").objectStore(l.STORE_NAME).get("master-seed");
      n.onerror = () => t(n.error), n.onsuccess = () => e(n.result || null);
    });
  }
  async deriveEncryptionKey(e, t) {
    const s = await crypto.subtle.importKey(
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
        iterations: l.PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      s,
      { name: "AES-GCM", length: 256 },
      !1,
      // non-extractable
      ["encrypt", "decrypt"]
    );
  }
};
i(l, "DB_NAME", "wot-identity"), i(l, "STORE_NAME", "seeds"), i(l, "SESSION_STORE_NAME", "session"), i(l, "PBKDF2_ITERATIONS", 1e5), i(l, "DEFAULT_SESSION_TTL", 1800 * 1e3);
let M = l;
const O = "wot.identity.seed", k = 1, x = "bip39-64-byte", v = "Stored identity uses an unsupported legacy seed format. Create a new ID to continue.";
class he {
  constructor(e = {}) {
    i(this, "storage");
    i(this, "crypto");
    if (e && typeof e.storeSeed == "function")
      this.storage = e, this.crypto = new K();
    else {
      const t = e;
      this.storage = t.storage ?? new M(), this.crypto = t.crypto ?? new K();
    }
  }
  saveSeed(e, t) {
    return this.storage.storeSeed(this.encodeSeed(e), t);
  }
  async unlockWithPassphrase(e) {
    const t = await this.storage.loadSeed(e);
    if (!t) return null;
    const s = this.decodeSeed(t);
    return D(s, this.crypto);
  }
  async unlockWithSession() {
    const e = await this.storage.loadSeedWithSessionKey();
    if (!e) return null;
    const t = this.decodeSeed(e);
    return D(t, this.crypto);
  }
  deleteSeed() {
    return this.storage.deleteSeed();
  }
  hasSeed() {
    return this.storage.hasSeed();
  }
  hasActiveSession() {
    return this.storage.hasActiveSession();
  }
  clearSessionKey() {
    return this.storage.clearSessionKey();
  }
  encodeSeed(e) {
    const t = {
      type: O,
      version: k,
      seedFormat: x,
      seed: G(e)
    };
    return new TextEncoder().encode(JSON.stringify(t));
  }
  decodeSeed(e) {
    let t;
    try {
      t = JSON.parse(new TextDecoder().decode(e));
    } catch {
      throw new Error(v);
    }
    if (!X(t)) throw new Error(v);
    try {
      return H(t.seed);
    } catch {
      throw new Error(v);
    }
  }
}
function X(c) {
  if (!c || typeof c != "object") return !1;
  const e = c;
  return e.type === O && e.version === k && e.seedFormat === x && typeof e.seed == "string";
}
const u = class u {
  constructor() {
    i(this, "myDid", null);
    i(this, "state", "disconnected");
    i(this, "messageCallbacks", /* @__PURE__ */ new Set());
    i(this, "receiptCallbacks", /* @__PURE__ */ new Set());
    i(this, "stateCallbacks", /* @__PURE__ */ new Set());
  }
  onStateChange(e) {
    return this.stateCallbacks.add(e), () => {
      this.stateCallbacks.delete(e);
    };
  }
  notifyStateChange(e) {
    this.state = e;
    for (const t of this.stateCallbacks)
      t(e);
  }
  async connect(e) {
    this.myDid = e, this.notifyStateChange("connected");
    let t = u.registry.get(e);
    t || (t = /* @__PURE__ */ new Set(), u.registry.set(e, t)), t.add(this);
    const s = u.offlineQueue.get(e);
    if (s && s.length > 0) {
      u.offlineQueue.delete(e);
      for (const r of s)
        await this.deliverToSelf(r);
    }
  }
  async disconnect() {
    if (this.myDid) {
      const e = u.registry.get(this.myDid);
      e && (e.delete(this), e.size === 0 && u.registry.delete(this.myDid));
    }
    this.myDid = null, this.notifyStateChange("disconnected");
  }
  getState() {
    return this.state;
  }
  async send(e) {
    if (this.state !== "connected" || !this.myDid)
      throw new Error("MessagingAdapter: must call connect() before send()");
    const t = (/* @__PURE__ */ new Date()).toISOString(), s = u.registry.get(e.toDid);
    if (s && s.size > 0) {
      for (const a of s)
        await a.deliverToSelf(e);
      const n = {
        messageId: e.id,
        status: "delivered",
        timestamp: t
      };
      for (const a of this.receiptCallbacks)
        a(n);
    }
    const r = u.offlineQueue.get(e.toDid) ?? [];
    return r.push(e), u.offlineQueue.set(e.toDid, r), {
      messageId: e.id,
      status: "accepted",
      timestamp: t
    };
  }
  onMessage(e) {
    return this.messageCallbacks.add(e), () => {
      this.messageCallbacks.delete(e);
    };
  }
  onReceipt(e) {
    return this.receiptCallbacks.add(e), () => {
      this.receiptCallbacks.delete(e);
    };
  }
  async registerTransport(e, t) {
    u.transportMap.set(e, t);
  }
  async resolveTransport(e) {
    return u.transportMap.get(e) ?? null;
  }
  /** Reset all shared state. Call in afterEach() for test isolation. */
  static resetAll() {
    for (const e of u.registry.values())
      for (const t of e)
        t.myDid = null, t.state = "disconnected";
    u.registry.clear(), u.offlineQueue.clear(), u.transportMap.clear();
  }
  async deliverToSelf(e) {
    for (const t of this.messageCallbacks)
      try {
        await t(e);
      } catch (s) {
        console.error("Message callback error:", s);
      }
  }
};
// Shared state across all instances (same process)
i(u, "registry", /* @__PURE__ */ new Map()), i(u, "offlineQueue", /* @__PURE__ */ new Map()), i(u, "transportMap", /* @__PURE__ */ new Map());
let C = u;
class de {
  constructor(e, t) {
    i(this, "ws", null);
    i(this, "state", "disconnected");
    i(this, "messageCallbacks", /* @__PURE__ */ new Set());
    i(this, "receiptCallbacks", /* @__PURE__ */ new Set());
    i(this, "stateCallbacks", /* @__PURE__ */ new Set());
    i(this, "transportMap", /* @__PURE__ */ new Map());
    i(this, "pendingReceipts", /* @__PURE__ */ new Map());
    /** Buffer for messages that arrive before any onMessage handler is registered */
    i(this, "earlyMessageBuffer", []);
    i(this, "heartbeatInterval", null);
    i(this, "heartbeatTimeout", null);
    i(this, "HEARTBEAT_INTERVAL_MS", 15e3);
    i(this, "HEARTBEAT_TIMEOUT_MS", 5e3);
    i(this, "SEND_TIMEOUT_MS");
    i(this, "signChallenge");
    i(this, "connectedDid", null);
    i(this, "peerCount", 0);
    this.relayUrl = e, this.SEND_TIMEOUT_MS = (t == null ? void 0 : t.sendTimeoutMs) ?? 1e4, this.signChallenge = (t == null ? void 0 : t.signChallenge) ?? null;
  }
  setState(e) {
    this.state = e;
    for (const t of this.stateCallbacks)
      t(e);
  }
  onStateChange(e) {
    return this.stateCallbacks.add(e), () => {
      this.stateCallbacks.delete(e);
    };
  }
  async connect(e) {
    if (!(this.state === "connected" && this.connectedDid === e))
      return this.state === "connected" && await this.disconnect(), this.setState("connecting"), new Promise((t, s) => {
        this.ws = new WebSocket(this.relayUrl), this.ws.onopen = () => {
          var r;
          if (((r = this.ws) == null ? void 0 : r.readyState) === WebSocket.OPEN)
            this.ws.send(JSON.stringify({ type: "register", did: e }));
          else {
            const n = this.ws, a = () => {
              n.readyState === WebSocket.OPEN ? n.send(JSON.stringify({ type: "register", did: e })) : n.readyState === WebSocket.CONNECTING ? setTimeout(a, 10) : s(new Error("WebSocket closed before registration"));
            };
            setTimeout(a, 10);
          }
        }, this.ws.onmessage = (r) => {
          let n;
          try {
            n = JSON.parse(typeof r.data == "string" ? r.data : r.data.toString());
          } catch {
            console.warn("[WebSocket] Received malformed JSON, ignoring");
            return;
          }
          switch (n.type) {
            case "challenge":
              this.signChallenge ? this.signChallenge(n.nonce).then((a) => {
                var o;
                (o = this.ws) == null || o.send(JSON.stringify({
                  type: "challenge-response",
                  did: e,
                  nonce: n.nonce,
                  signature: a
                }));
              }).catch((a) => {
                this.setState("error"), s(new Error(`Challenge signing failed: ${a instanceof Error ? a.message : String(a)}`));
              }) : (this.setState("error"), s(new Error("Relay requires challenge-response auth but no signChallenge function provided")));
              break;
            case "registered":
              this.connectedDid = e, this.peerCount = typeof n.peers == "number" ? n.peers : 0, this.setState("connected"), this.startHeartbeat(), t();
              break;
            case "message":
              this.handleIncomingMessage(n.envelope);
              break;
            case "receipt": {
              const a = n.receipt, o = this.pendingReceipts.get(a.messageId);
              o && (this.pendingReceipts.delete(a.messageId), o(a));
              for (const h of this.receiptCallbacks)
                h(a);
              break;
            }
            case "pong":
              this.handlePong();
              break;
            case "error":
              this.state === "connecting" && (this.setState("error"), s(new Error(`Relay error: ${n.message}`)));
              break;
          }
        }, this.ws.onerror = () => {
          this.state === "connecting" && (this.setState("error"), s(new Error(`WebSocket connection failed to ${this.relayUrl}`)));
        }, this.ws.onclose = () => {
          this.setState("disconnected");
        };
      });
  }
  async disconnect() {
    this.stopHeartbeat(), this.connectedDid = null, this.earlyMessageBuffer.length = 0, this.pendingReceipts.clear(), this.ws && (this.ws.close(), this.ws = null), this.setState("disconnected");
  }
  getState() {
    return this.state;
  }
  getPeerCount() {
    return this.peerCount;
  }
  startHeartbeat() {
    this.stopHeartbeat(), this.heartbeatInterval = setInterval(() => {
      if (this.state !== "connected" || !this.ws) {
        this.stopHeartbeat();
        return;
      }
      this.ws.readyState === WebSocket.OPEN && (this.ws.send(JSON.stringify({ type: "ping" })), this.heartbeatTimeout = setTimeout(() => {
        this.stopHeartbeat(), this.ws && (this.ws.close(), this.ws = null), this.setState("disconnected");
      }, this.HEARTBEAT_TIMEOUT_MS));
    }, this.HEARTBEAT_INTERVAL_MS);
  }
  stopHeartbeat() {
    this.heartbeatInterval && (clearInterval(this.heartbeatInterval), this.heartbeatInterval = null), this.heartbeatTimeout && (clearTimeout(this.heartbeatTimeout), this.heartbeatTimeout = null);
  }
  /**
   * Process incoming message: await all callbacks, then ACK.
   * If no handlers are registered yet, buffer the message for later delivery.
   */
  async handleIncomingMessage(e) {
    if (this.messageCallbacks.size === 0) {
      this.earlyMessageBuffer.push(e);
      return;
    }
    let t = !1;
    for (const s of this.messageCallbacks)
      try {
        await s(e), t = !0;
      } catch (r) {
        console.error("Message callback error:", r);
      }
    t && this.ws && this.ws.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "ack", messageId: e.id }));
  }
  handlePong() {
    this.heartbeatTimeout && (clearTimeout(this.heartbeatTimeout), this.heartbeatTimeout = null);
  }
  async send(e) {
    if (this.state !== "connected" || !this.ws)
      throw new Error("WebSocketMessagingAdapter: must call connect() before send()");
    return new Promise((t, s) => {
      const r = this.SEND_TIMEOUT_MS > 0 ? setTimeout(() => {
        this.pendingReceipts.delete(e.id), s(new Error(`Send timeout: no receipt from relay after ${this.SEND_TIMEOUT_MS}ms`));
      }, this.SEND_TIMEOUT_MS) : null;
      if (this.pendingReceipts.set(e.id, (n) => {
        r && clearTimeout(r), t(n);
      }), this.ws.readyState !== WebSocket.OPEN) {
        r && clearTimeout(r), this.pendingReceipts.delete(e.id), s(new Error("WebSocket not open"));
        return;
      }
      this.ws.send(JSON.stringify({ type: "send", envelope: e }));
    });
  }
  onMessage(e) {
    if (this.messageCallbacks.add(e), this.earlyMessageBuffer.length > 0) {
      const t = this.earlyMessageBuffer.splice(0);
      for (const s of t)
        this.handleIncomingMessage(s);
    }
    return () => {
      this.messageCallbacks.delete(e);
    };
  }
  onReceipt(e) {
    return this.receiptCallbacks.add(e), () => {
      this.receiptCallbacks.delete(e);
    };
  }
  async registerTransport(e, t) {
    this.transportMap.set(e, t);
  }
  async resolveTransport(e) {
    return this.transportMap.get(e) ?? null;
  }
}
class ye {
  constructor(e) {
    i(this, "TIMEOUT_MS", 3e3);
    this.baseUrl = e;
  }
  fetchWithTimeout(e, t) {
    const s = new AbortController(), r = setTimeout(() => s.abort(), this.TIMEOUT_MS);
    return fetch(e, { ...t, signal: s.signal }).finally(() => clearTimeout(r));
  }
  async publishProfile(e, t) {
    const s = y(), r = performance.now();
    try {
      const n = await E.signProfile(e, t), a = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}`,
        { method: "PUT", body: n, headers: { "Content-Type": "application/jws" } }
      );
      if (!a.ok) throw new Error(`Profile upload failed: ${a.status}`);
      s.log({ store: "profiles", operation: "write", label: `publishProfile ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e.did, name: e.name } });
    } catch (n) {
      throw s.log({ store: "profiles", operation: "write", label: `publishProfile ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: n instanceof Error ? n.message : String(n), meta: { did: e.did } }), n;
    }
  }
  async publishVerifications(e, t) {
    var n;
    const s = y(), r = performance.now();
    try {
      const a = await t.signJws(e), o = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}/v`,
        { method: "PUT", body: a, headers: { "Content-Type": "text/plain" } }
      );
      if (!o.ok) throw new Error(`Verifications upload failed: ${o.status}`);
      s.log({ store: "profiles", operation: "write", label: `publishVerifications ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e.did, count: ((n = e.verifications) == null ? void 0 : n.length) ?? 0 } });
    } catch (a) {
      throw s.log({ store: "profiles", operation: "write", label: `publishVerifications ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: a instanceof Error ? a.message : String(a), meta: { did: e.did } }), a;
    }
  }
  async publishAttestations(e, t) {
    var n;
    const s = y(), r = performance.now();
    try {
      const a = await t.signJws(e), o = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}/a`,
        { method: "PUT", body: a, headers: { "Content-Type": "text/plain" } }
      );
      if (!o.ok) throw new Error(`Attestations upload failed: ${o.status}`);
      s.log({ store: "profiles", operation: "write", label: `publishAttestations ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e.did, count: ((n = e.attestations) == null ? void 0 : n.length) ?? 0 } });
    } catch (a) {
      throw s.log({ store: "profiles", operation: "write", label: `publishAttestations ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: a instanceof Error ? a.message : String(a), meta: { did: e.did } }), a;
    }
  }
  async resolveProfile(e) {
    const t = y(), s = performance.now();
    try {
      const r = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}`);
      if (r.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, found: !1 } }), { profile: null, fromCache: !1 };
      if (!r.ok) throw new Error(`Profile fetch failed: ${r.status}`);
      const n = await r.text(), a = await E.verifyProfile(n), o = a.valid && a.profile ? a.profile : null;
      return t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, found: !!o, name: o == null ? void 0 : o.name } }), { profile: o, didDocument: a.didDocument ?? null, version: a.version, fromCache: !1 };
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { did: e } }), r;
    }
  }
  async resolveVerifications(e) {
    const t = y(), s = performance.now();
    try {
      const r = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/v`);
      if (r.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: 0 } }), [];
      if (!r.ok) throw new Error(`Verifications fetch failed: ${r.status}`);
      const n = await r.text(), a = await E.verifySignedPayload(n);
      if (!a.valid || !a.payload) return [];
      const h = a.payload.verifications ?? [];
      return t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: h.length } }), h;
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { did: e } }), r;
    }
  }
  async resolveAttestations(e) {
    const t = y(), s = performance.now();
    try {
      const r = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/a`);
      if (r.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: 0 } }), [];
      if (!r.ok) throw new Error(`Attestations fetch failed: ${r.status}`);
      const n = await r.text(), a = await E.verifySignedPayload(n);
      if (!a.valid || !a.payload) return [];
      const h = a.payload.attestations ?? [];
      return t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: h.length } }), h;
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { did: e } }), r;
    }
  }
  async resolveSummaries(e) {
    const t = y(), s = performance.now();
    try {
      const r = e.map((o) => encodeURIComponent(o)).join(","), n = await this.fetchWithTimeout(`${this.baseUrl}/s?dids=${r}`);
      if (!n.ok) throw new Error(`Summary fetch failed: ${n.status}`);
      const a = await n.json();
      return t.log({ store: "profiles", operation: "read", label: `resolveSummaries (${e.length} DIDs)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { count: e.length, results: a.length } }), a;
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveSummaries (${e.length} DIDs)`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { count: e.length } }), r;
    }
  }
}
class pe {
  constructor(e, t, s) {
    i(this, "_lastError", null);
    i(this, "_errorListeners", []);
    this.inner = e, this.publishState = t, this.graphCache = s;
  }
  /** Last publish error message (null if last attempt succeeded) */
  get lastError() {
    return this._lastError;
  }
  /** Subscribe to error state changes */
  onErrorChange(e) {
    return this._errorListeners.push(e), () => {
      this._errorListeners = this._errorListeners.filter((t) => t !== e);
    };
  }
  setError(e) {
    this._lastError = e instanceof Error ? e.message : String(e), console.warn("[Discovery] Publish failed:", this._lastError), this._errorListeners.forEach((t) => t(this._lastError));
  }
  clearError() {
    this._lastError !== null && (this._lastError = null, this._errorListeners.forEach((e) => e(null)));
  }
  async publishProfile(e, t) {
    await this.publishState.markDirty(e.did, "profile");
    try {
      await this.inner.publishProfile(e, t), await this.publishState.clearDirty(e.did, "profile"), this.clearError();
    } catch (s) {
      this.setError(s);
    }
  }
  async publishVerifications(e, t) {
    await this.publishState.markDirty(e.did, "verifications");
    try {
      await this.inner.publishVerifications(e, t), await this.publishState.clearDirty(e.did, "verifications"), this.clearError();
    } catch (s) {
      this.setError(s);
    }
  }
  async publishAttestations(e, t) {
    await this.publishState.markDirty(e.did, "attestations");
    try {
      await this.inner.publishAttestations(e, t), await this.publishState.clearDirty(e.did, "attestations"), this.clearError();
    } catch (s) {
      this.setError(s);
    }
  }
  async resolveProfile(e) {
    try {
      return await this.inner.resolveProfile(e);
    } catch {
      const t = await this.graphCache.getEntry(e);
      return t != null && t.name ? {
        profile: {
          did: t.did,
          name: t.name,
          ...t.bio ? { bio: t.bio } : {},
          ...t.avatar ? { avatar: t.avatar } : {},
          updatedAt: t.fetchedAt
        },
        didDocument: null,
        fromCache: !0
      } : { profile: null, fromCache: !0 };
    }
  }
  async resolveVerifications(e) {
    try {
      return await this.inner.resolveVerifications(e);
    } catch {
      return await this.graphCache.getCachedVerifications(e);
    }
  }
  async resolveAttestations(e) {
    try {
      return await this.inner.resolveAttestations(e);
    } catch {
      return await this.graphCache.getCachedAttestations(e);
    }
  }
  async resolveSummaries(e) {
    if (!this.inner.resolveSummaries)
      throw new Error("Inner adapter does not support resolveSummaries");
    return this.inner.resolveSummaries(e);
  }
  /**
   * Retry all pending publish operations.
   *
   * Called by the app when connectivity is restored (online event,
   * visibility change, or on mount).
   *
   * @param did - The local user's DID
   * @param identity - The unlocked identity session (needed for JWS signing)
   * @param getPublishData - Callback that reads current local data at retry time
   *                         (not stale data from the original publish attempt)
   */
  async syncPending(e, t, s) {
    const r = await this.publishState.getDirtyFields(e);
    if (r.size === 0) return;
    const n = await s();
    if (r.has("profile") && n.profile)
      try {
        await this.inner.publishProfile(n.profile, t), await this.publishState.clearDirty(e, "profile"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
    if (r.has("verifications") && n.verifications)
      try {
        await this.inner.publishVerifications(n.verifications, t), await this.publishState.clearDirty(e, "verifications"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
    if (r.has("attestations") && n.attestations)
      try {
        await this.inner.publishAttestations(n.attestations, t), await this.publishState.clearDirty(e, "attestations"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
  }
}
class fe {
  constructor() {
    i(this, "dirty", /* @__PURE__ */ new Map());
  }
  async markDirty(e, t) {
    const s = this.dirty.get(e) ?? /* @__PURE__ */ new Set();
    s.add(t), this.dirty.set(e, s);
  }
  async clearDirty(e, t) {
    const s = this.dirty.get(e);
    s && (s.delete(t), s.size === 0 && this.dirty.delete(e));
  }
  async getDirtyFields(e) {
    return new Set(this.dirty.get(e) ?? []);
  }
}
class ge {
  constructor() {
    i(this, "profiles", /* @__PURE__ */ new Map());
    i(this, "verifications", /* @__PURE__ */ new Map());
    i(this, "attestations", /* @__PURE__ */ new Map());
    i(this, "fetchedAt", /* @__PURE__ */ new Map());
    i(this, "summaryCounts", /* @__PURE__ */ new Map());
  }
  async cacheEntry(e, t, s, r) {
    t && this.profiles.set(e, t), this.verifications.set(e, s), this.attestations.set(e, r), this.fetchedAt.set(e, (/* @__PURE__ */ new Date()).toISOString()), this.summaryCounts.delete(e);
  }
  async getEntry(e) {
    const t = this.fetchedAt.get(e);
    if (!t) return null;
    const s = this.profiles.get(e), r = this.verifications.get(e) ?? [], n = this.attestations.get(e) ?? [], a = this.summaryCounts.get(e);
    return {
      did: e,
      name: s == null ? void 0 : s.name,
      bio: s == null ? void 0 : s.bio,
      avatar: s == null ? void 0 : s.avatar,
      verificationCount: (a == null ? void 0 : a.verificationCount) ?? r.length,
      attestationCount: (a == null ? void 0 : a.attestationCount) ?? n.length,
      verifierDids: r.map((o) => o.from),
      fetchedAt: t
    };
  }
  async getEntries(e) {
    const t = /* @__PURE__ */ new Map();
    for (const s of e) {
      const r = await this.getEntry(s);
      r && t.set(s, r);
    }
    return t;
  }
  async getCachedVerifications(e) {
    return this.verifications.get(e) ?? [];
  }
  async getCachedAttestations(e) {
    return this.attestations.get(e) ?? [];
  }
  async resolveName(e) {
    var t;
    return ((t = this.profiles.get(e)) == null ? void 0 : t.name) ?? null;
  }
  async resolveNames(e) {
    var s;
    const t = /* @__PURE__ */ new Map();
    for (const r of e) {
      const n = (s = this.profiles.get(r)) == null ? void 0 : s.name;
      n && t.set(r, n);
    }
    return t;
  }
  async findMutualContacts(e, t) {
    const s = this.verifications.get(e) ?? [], r = new Set(s.map((n) => n.from));
    return t.filter((n) => r.has(n));
  }
  async search(e) {
    var r, n;
    const t = e.toLowerCase(), s = [];
    for (const [a] of this.fetchedAt) {
      const o = this.profiles.get(a), h = (r = o == null ? void 0 : o.name) == null ? void 0 : r.toLowerCase().includes(t), m = (n = o == null ? void 0 : o.bio) == null ? void 0 : n.toLowerCase().includes(t), T = (this.attestations.get(a) ?? []).some((g) => g.claim.toLowerCase().includes(t));
      if (h || m || T) {
        const g = await this.getEntry(a);
        g && s.push(g);
      }
    }
    return s;
  }
  async updateSummary(e, t, s, r) {
    if (t !== null) {
      const n = this.profiles.get(e);
      this.profiles.set(e, {
        did: e,
        name: t,
        ...n != null && n.bio ? { bio: n.bio } : {},
        ...n != null && n.avatar ? { avatar: n.avatar } : {},
        updatedAt: (n == null ? void 0 : n.updatedAt) ?? (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    this.summaryCounts.set(e, { verificationCount: s, attestationCount: r }), this.fetchedAt.has(e) || this.fetchedAt.set(e, (/* @__PURE__ */ new Date()).toISOString());
  }
  async evict(e) {
    this.profiles.delete(e), this.verifications.delete(e), this.attestations.delete(e), this.fetchedAt.delete(e), this.summaryCounts.delete(e);
  }
  async clear() {
    this.profiles.clear(), this.verifications.clear(), this.attestations.clear(), this.fetchedAt.clear(), this.summaryCounts.clear();
  }
}
class we {
  constructor(e, t, s) {
    i(this, "flushing", !1);
    i(this, "skipTypes");
    i(this, "sendTimeoutMs");
    i(this, "reconnectIntervalMs");
    i(this, "maxRetries");
    i(this, "isOnline");
    i(this, "reconnectTimer", null);
    i(this, "myDid", null);
    i(this, "unsubscribeStateChange", null);
    this.inner = e, this.outbox = t, this.skipTypes = new Set((s == null ? void 0 : s.skipTypes) ?? ["profile-update"]), this.sendTimeoutMs = (s == null ? void 0 : s.sendTimeoutMs) ?? 15e3, this.reconnectIntervalMs = (s == null ? void 0 : s.reconnectIntervalMs) ?? 1e4, this.maxRetries = (s == null ? void 0 : s.maxRetries) ?? 50, this.isOnline = (s == null ? void 0 : s.isOnline) ?? (() => !0);
  }
  // --- Connection lifecycle: delegate to inner ---
  async connect(e) {
    this.myDid = e, await this.inner.connect(e), this.flushOutbox(), this._startAutoReconnect();
  }
  async disconnect() {
    return this._stopAutoReconnect(), this.inner.disconnect();
  }
  getState() {
    return this.inner.getState();
  }
  // --- Send with outbox ---
  async send(e) {
    if (this.skipTypes.has(e.type))
      return this.inner.send(e);
    if (this.inner.getState() !== "connected")
      return await this.outbox.enqueue(e), {
        messageId: e.id,
        status: "accepted",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        reason: "queued-in-outbox"
      };
    try {
      return await this.sendWithTimeout(e);
    } catch {
      return await this.outbox.enqueue(e), {
        messageId: e.id,
        status: "accepted",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        reason: "queued-in-outbox"
      };
    }
  }
  // --- Receiving: delegate to inner ---
  onMessage(e) {
    return this.inner.onMessage(e);
  }
  onReceipt(e) {
    return this.inner.onReceipt(e);
  }
  // --- Transport: delegate to inner ---
  async registerTransport(e, t) {
    return this.inner.registerTransport(e, t);
  }
  async resolveTransport(e) {
    return this.inner.resolveTransport(e);
  }
  // --- State change: delegate to inner (WebSocketMessagingAdapter-specific) ---
  onStateChange(e) {
    return "onStateChange" in this.inner && typeof this.inner.onStateChange == "function" ? this.inner.onStateChange(e) : () => {
    };
  }
  // --- Outbox flush ---
  /**
   * Retry all pending outbox messages.
   * Called automatically on connect(). Can also be called manually.
   * FIFO order. Individual failures don't abort the flush.
   */
  async flushOutbox() {
    if (!this.flushing) {
      this.flushing = !0;
      try {
        const e = await this.outbox.getPending();
        for (const t of e) {
          if (this.inner.getState() !== "connected") break;
          if (t.retryCount >= this.maxRetries) {
            console.warn("[Outbox] Dropping message after", t.retryCount, "retries:", t.envelope.type, t.envelope.id), await this.outbox.dequeue(t.envelope.id);
            continue;
          }
          try {
            await this.sendWithTimeout(t.envelope), await this.outbox.dequeue(t.envelope.id);
          } catch {
            await this.outbox.incrementRetry(t.envelope.id);
          }
        }
      } finally {
        this.flushing = !1;
      }
    }
  }
  /** Expose outbox store for UI (pending count badge). */
  getOutboxStore() {
    return this.outbox;
  }
  // --- Private ---
  _startAutoReconnect() {
    this.reconnectIntervalMs <= 0 || (this._stopAutoReconnect(), this.unsubscribeStateChange = this.onStateChange((e) => {
      e === "connected" && this.flushOutbox();
    }), this.reconnectTimer = setInterval(() => {
      if (!this.myDid || !this.isOnline()) return;
      const e = this.inner.getState();
      (e === "disconnected" || e === "error") && this.inner.connect(this.myDid).catch(() => {
      });
    }, this.reconnectIntervalMs));
  }
  _stopAutoReconnect() {
    this.reconnectTimer && (clearInterval(this.reconnectTimer), this.reconnectTimer = null), this.unsubscribeStateChange && (this.unsubscribeStateChange(), this.unsubscribeStateChange = null);
  }
  sendWithTimeout(e) {
    return this.sendTimeoutMs <= 0 ? this.inner.send(e) : new Promise((t, s) => {
      const r = setTimeout(() => {
        s(new Error(`Send timeout after ${this.sendTimeoutMs}ms`));
      }, this.sendTimeoutMs);
      this.inner.send(e).then(
        (n) => {
          clearTimeout(r), t(n);
        },
        (n) => {
          clearTimeout(r), s(n);
        }
      );
    });
  }
}
class be {
  constructor() {
    i(this, "entries", /* @__PURE__ */ new Map());
  }
  async enqueue(e) {
    this.entries.has(e.id) || this.entries.set(e.id, {
      envelope: e,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      retryCount: 0
    });
  }
  async dequeue(e) {
    this.entries.delete(e);
  }
  async getPending() {
    return [...this.entries.values()].sort((e, t) => e.createdAt.localeCompare(t.createdAt));
  }
  async has(e) {
    return this.entries.has(e);
  }
  async incrementRetry(e) {
    const t = this.entries.get(e);
    t && t.retryCount++;
  }
  async count() {
    return this.entries.size;
  }
}
class me {
  constructor() {
    i(this, "spaces", /* @__PURE__ */ new Map());
    i(this, "groupKeys", /* @__PURE__ */ new Map());
  }
  async saveSpaceMetadata(e) {
    this.spaces.set(e.info.id, e);
  }
  async loadSpaceMetadata(e) {
    return this.spaces.get(e) ?? null;
  }
  async loadAllSpaceMetadata() {
    return Array.from(this.spaces.values());
  }
  async deleteSpaceMetadata(e) {
    this.spaces.delete(e);
  }
  async saveGroupKey(e) {
    const t = this.groupKeys.get(e.spaceId) ?? [], s = t.findIndex((r) => r.generation === e.generation);
    s >= 0 ? t[s] = e : t.push(e), this.groupKeys.set(e.spaceId, t);
  }
  async loadGroupKeys(e) {
    return this.groupKeys.get(e) ?? [];
  }
  async deleteGroupKeys(e) {
    this.groupKeys.delete(e);
  }
  async clearAll() {
    this.spaces.clear(), this.groupKeys.clear();
  }
}
class Se {
  constructor() {
    i(this, "data", /* @__PURE__ */ new Map());
  }
  async open() {
  }
  async save(e, t) {
    this.data.set(e, t);
  }
  async load(e) {
    return this.data.get(e) ?? null;
  }
  async delete(e) {
    this.data.delete(e);
  }
  async list() {
    return Array.from(this.data.keys());
  }
  close() {
  }
  /** Test helper: check if a snapshot exists */
  has(e) {
    return this.data.has(e);
  }
  /** Test helper: get snapshot size */
  size(e) {
    var t;
    return ((t = this.data.get(e)) == null ? void 0 : t.length) ?? 0;
  }
}
const Q = "wot-space-metadata", Y = 1, w = "spaces", b = "groupKeys";
class Ee {
  constructor(e = Q) {
    i(this, "dbPromise");
    this.dbPromise = P(e, Y, {
      upgrade(t) {
        t.objectStoreNames.contains(w) || t.createObjectStore(w, { keyPath: "info.id" }), t.objectStoreNames.contains(b) || t.createObjectStore(b, { keyPath: "id" }).createIndex("bySpaceId", "spaceId");
      }
    });
  }
  async saveSpaceMetadata(e) {
    const t = await this.dbPromise, s = {
      info: e.info,
      documentId: e.documentId,
      documentUrl: e.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(e.memberEncryptionKeys).map(
          ([r, n]) => [r, Array.from(n)]
        )
      )
    };
    await t.put(w, s);
  }
  async loadSpaceMetadata(e) {
    const s = await (await this.dbPromise).get(w, e);
    return s ? this.deserialize(s) : null;
  }
  async loadAllSpaceMetadata() {
    return (await (await this.dbPromise).getAll(w)).map((s) => this.deserialize(s));
  }
  async deleteSpaceMetadata(e) {
    await (await this.dbPromise).delete(w, e);
  }
  async saveGroupKey(e) {
    const t = await this.dbPromise, s = {
      id: I(e.spaceId, e.generation),
      spaceId: e.spaceId,
      generation: e.generation,
      key: Array.from(e.key)
    };
    await t.put(b, s);
  }
  async loadGroupKeys(e) {
    return (await (await this.dbPromise).getAllFromIndex(b, "bySpaceId", e)).map((r) => ({
      spaceId: r.spaceId,
      generation: r.generation,
      key: new Uint8Array(r.key)
    }));
  }
  async deleteGroupKeys(e) {
    const t = await this.dbPromise, s = await t.getAllKeysFromIndex(b, "bySpaceId", e), r = t.transaction(b, "readwrite");
    for (const n of s)
      await r.store.delete(n);
    await r.done;
  }
  async clearAll() {
    const t = (await this.dbPromise).transaction([w, b], "readwrite");
    await t.objectStore(w).clear(), await t.objectStore(b).clear(), await t.done;
  }
  deserialize(e) {
    return {
      info: e.info,
      documentId: e.documentId,
      documentUrl: e.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(e.memberEncryptionKeys).map(
          ([t, s]) => [t, new Uint8Array(s)]
        )
      )
    };
  }
}
class ve {
  constructor(e, t) {
    i(this, "myDid");
    i(this, "sign");
    /** Capabilities granted TO this user (received from others) */
    i(this, "received", []);
    /** Capabilities granted BY this user (issued to others) */
    i(this, "granted", []);
    /** Revoked capability IDs */
    i(this, "revoked", /* @__PURE__ */ new Set());
    this.myDid = e, this.sign = t;
  }
  async grant(e, t, s, r) {
    const n = await _(
      {
        issuer: this.myDid,
        audience: t,
        resource: e,
        permissions: s,
        expiration: r
      },
      this.sign
    );
    return this.granted.push(n), n;
  }
  async delegate(e, t, s, r) {
    const n = S(e);
    if (!n) throw new Error("Invalid parent capability");
    const a = r ?? n.expiration, o = await B(
      e,
      { audience: t, permissions: s, expiration: a },
      this.sign
    );
    return this.granted.push(o), o;
  }
  async verify(e) {
    const t = await V(e);
    if (!t.valid) return t;
    if (this.revoked.has(t.capability.id))
      return { valid: !1, error: `Capability ${t.capability.id} has been revoked` };
    for (const s of t.chain)
      if (this.revoked.has(s.id))
        return { valid: !1, error: `Ancestor capability ${s.id} has been revoked` };
    return t;
  }
  async canAccess(e, t, s) {
    const r = [...this.received, ...this.granted];
    for (const n of r) {
      const a = S(n);
      if (!a || a.audience !== e || a.resource !== t || !a.permissions.includes(s)) continue;
      if ((await this.verify(n)).valid) return !0;
    }
    return !1;
  }
  async revoke(e) {
    this.revoked.add(e);
  }
  async isRevoked(e) {
    return this.revoked.has(e);
  }
  async store(e) {
    this.received.push(e);
  }
  async getMyCapabilities(e) {
    return e ? this.received.filter((t) => {
      const s = S(t);
      return s && s.resource === e;
    }) : [...this.received];
  }
  async getGrantedCapabilities(e) {
    return e ? this.granted.filter((t) => {
      const s = S(t);
      return s && s.resource === e;
    }) : [...this.granted];
  }
}
class Ae {
  constructor(e) {
    i(this, "getPersonalDoc");
    i(this, "changePersonalDoc");
    i(this, "onPersonalDocChange");
    this.getPersonalDoc = e.getPersonalDoc, this.changePersonalDoc = e.changePersonalDoc, this.onPersonalDocChange = e.onPersonalDocChange;
  }
  async enqueue(e) {
    await this.has(e.id) || this.changePersonalDoc((s) => {
      s.outbox[e.id] = {
        envelopeJson: JSON.stringify(e),
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        retryCount: 0
      };
    });
  }
  async dequeue(e) {
    this.changePersonalDoc((t) => {
      delete t.outbox[e];
    });
  }
  async getPending() {
    const e = this.getPersonalDoc();
    return Object.entries(e.outbox).map(([t, s]) => ({
      envelope: JSON.parse(s.envelopeJson),
      createdAt: s.createdAt,
      retryCount: s.retryCount
    })).sort((t, s) => t.createdAt.localeCompare(s.createdAt));
  }
  async has(e) {
    const t = this.getPersonalDoc();
    return e in t.outbox;
  }
  async incrementRetry(e) {
    this.changePersonalDoc((t) => {
      t.outbox[e] && (t.outbox[e].retryCount += 1);
    });
  }
  async count() {
    const e = this.getPersonalDoc();
    return Object.keys(e.outbox).length;
  }
  watchPendingCount() {
    const e = this, t = () => {
      const r = e.getPersonalDoc();
      return Object.keys(r.outbox).length;
    };
    let s = t();
    return {
      subscribe: (r) => e.onPersonalDocChange(() => {
        const n = t();
        n !== s && (s = n, r(s));
      }),
      getValue: () => s
    };
  }
}
class Me {
  constructor(e) {
    i(this, "getPersonalDoc");
    i(this, "changePersonalDoc");
    this.getPersonalDoc = e.getPersonalDoc, this.changePersonalDoc = e.changePersonalDoc;
  }
  async saveSpaceMetadata(e) {
    this.changePersonalDoc((t) => {
      const s = {
        id: e.info.id,
        type: e.info.type,
        name: e.info.name ?? null,
        description: e.info.description ?? null,
        members: [...e.info.members],
        createdAt: e.info.createdAt
      };
      e.info.appTag != null && (s.appTag = e.info.appTag), t.spaces[e.info.id] = {
        info: s,
        documentId: e.documentId,
        documentUrl: e.documentUrl,
        memberEncryptionKeys: Object.fromEntries(
          Object.entries(e.memberEncryptionKeys).map(
            ([r, n]) => [r, Array.from(n)]
          )
        )
      };
    });
  }
  async loadSpaceMetadata(e) {
    const s = this.getPersonalDoc().spaces[e];
    return s ? this.deserialize(s) : null;
  }
  async loadAllSpaceMetadata() {
    const e = this.getPersonalDoc();
    return Object.values(e.spaces).map((t) => this.deserialize(t));
  }
  async deleteSpaceMetadata(e) {
    this.changePersonalDoc((t) => {
      delete t.spaces[e];
    });
  }
  async saveGroupKey(e) {
    const t = I(e.spaceId, e.generation);
    this.changePersonalDoc((s) => {
      s.groupKeys[t] = {
        spaceId: e.spaceId,
        generation: e.generation,
        key: Array.from(e.key)
      };
    });
  }
  async loadGroupKeys(e) {
    const t = this.getPersonalDoc();
    return Object.values(t.groupKeys).filter((s) => s.spaceId === e).map((s) => ({
      spaceId: s.spaceId,
      generation: s.generation,
      key: new Uint8Array(s.key)
    }));
  }
  async deleteGroupKeys(e) {
    this.changePersonalDoc((t) => {
      for (const [s, r] of Object.entries(t.groupKeys))
        r.spaceId === e && delete t.groupKeys[s];
    });
  }
  async clearAll() {
    this.changePersonalDoc((e) => {
      for (const t of Object.keys(e.spaces))
        delete e.spaces[t];
      for (const t of Object.keys(e.groupKeys))
        delete e.groupKeys[t];
    });
  }
  deserialize(e) {
    return {
      info: {
        id: e.info.id,
        type: e.info.type,
        ...e.info.name != null ? { name: e.info.name } : {},
        ...e.info.description != null ? { description: e.info.description } : {},
        ...e.info.appTag != null ? { appTag: e.info.appTag } : {},
        members: [...e.info.members],
        createdAt: e.info.createdAt
      },
      documentId: e.documentId,
      documentUrl: e.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(e.memberEncryptionKeys).map(
          ([t, s]) => [t, new Uint8Array(s)]
        )
      )
    };
  }
}
function A(c) {
  var e;
  return {
    id: c.id,
    v: c.v,
    type: c.type,
    fromDid: c.fromDid,
    toDid: c.toDid,
    createdAt: c.createdAt,
    encoding: c.encoding,
    ref: c.ref,
    payloadSize: (e = c.payload) == null ? void 0 : e.length
  };
}
class Te {
  constructor(e) {
    this.inner = e;
  }
  async connect(e) {
    const t = y(), s = performance.now();
    try {
      await this.inner.connect(e), t.log({
        store: "relay",
        operation: "connect",
        label: `relay connect ${e.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - s),
        success: !0,
        meta: { did: e }
      });
    } catch (r) {
      throw t.log({
        store: "relay",
        operation: "connect",
        label: `relay connect ${e.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - s),
        success: !1,
        error: r instanceof Error ? r.message : String(r),
        meta: { did: e }
      }), r;
    }
  }
  async disconnect() {
    const e = y();
    await this.inner.disconnect(), e.log({
      store: "relay",
      operation: "disconnect",
      label: "relay disconnect",
      durationMs: 0,
      success: !0
    });
  }
  getState() {
    return this.inner.getState();
  }
  onStateChange(e) {
    return this.inner.onStateChange((t) => {
      const s = {
        connected: "connect",
        disconnected: "disconnect",
        connecting: "connect",
        error: "error"
      };
      y().log({
        store: "relay",
        operation: s[t],
        label: `relay ${t}`,
        durationMs: 0,
        success: t !== "error",
        meta: { state: t }
      }), e(t);
    });
  }
  async send(e) {
    const t = y(), s = performance.now();
    try {
      const r = await this.inner.send(e);
      return t.log({
        store: r.reason === "queued-in-outbox" ? "outbox" : "relay",
        operation: "send",
        label: `send ${e.type} → ${e.toDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - s),
        success: !0,
        meta: {
          ...A(e),
          status: r.status,
          reason: r.reason
        }
      }), r;
    } catch (r) {
      throw t.log({
        store: "relay",
        operation: "send",
        label: `send ${e.type} → ${e.toDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - s),
        success: !1,
        error: r instanceof Error ? r.message : String(r),
        meta: A(e)
      }), r;
    }
  }
  onMessage(e) {
    return this.inner.onMessage((t) => (y().log({
      store: "relay",
      operation: "receive",
      label: `receive ${t.type} ← ${t.fromDid.slice(0, 24)}…`,
      durationMs: 0,
      success: !0,
      meta: A(t)
    }), e(t)));
  }
  onReceipt(e) {
    return this.inner.onReceipt(e);
  }
  async registerTransport(e, t) {
    return this.inner.registerTransport(e, t);
  }
  async resolveTransport(e) {
    return this.inner.resolveTransport(e);
  }
  // --- Outbox-specific methods (delegate to inner) ---
  async flushOutbox() {
    const e = y(), t = performance.now(), s = this.inner.getOutboxStore(), r = await s.count();
    try {
      await this.inner.flushOutbox();
      const n = await s.count();
      e.log({
        store: "outbox",
        operation: "flush",
        label: `flush outbox ${r} → ${n}`,
        durationMs: Math.round(performance.now() - t),
        success: !0,
        meta: { pendingBefore: r, pendingAfter: n, delivered: r - n }
      });
    } catch (n) {
      throw e.log({
        store: "outbox",
        operation: "flush",
        label: "flush outbox failed",
        durationMs: Math.round(performance.now() - t),
        success: !1,
        error: n instanceof Error ? n.message : String(n),
        meta: { pendingBefore: r }
      }), n;
    }
  }
  getOutboxStore() {
    return this.inner.getOutboxStore();
  }
}
export {
  ye as H,
  C as I,
  ue as L,
  pe as O,
  Ae as P,
  he as S,
  Te as T,
  le as W,
  de as a,
  fe as b,
  ge as c,
  we as d,
  be as e,
  me as f,
  Se as g,
  Ee as h,
  ve as i,
  Me as j
};
