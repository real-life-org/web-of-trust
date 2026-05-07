var g = Object.defineProperty;
var w = (c, e, t) => e in c ? g(c, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : c[e] = t;
var i = (c, e, t) => w(c, typeof e != "symbol" ? e + "" : e, t);
import { P as H } from "../ProfileService-C_OznEb2.js";
import { c as b } from "../capabilities-BBiuFuYA.js";
import { createResourceRef as m } from "../types/index.js";
import { g as f } from "../TraceLog-CuKPT7Eo.js";
import { k as v } from "../jws-8PD3qxx2.js";
import { j as R } from "../jws-8PD3qxx2.js";
const y = /* @__PURE__ */ new Map();
function S(c, e) {
  let t = "";
  for (let s = 0; s < c.length; s++) t += c[s].toString(16).padStart(2, "0");
  return `${t}:${e}`;
}
async function d(c, e) {
  const t = S(c, e);
  let s = y.get(t);
  return s || (s = await crypto.subtle.importKey(
    "raw",
    c,
    { name: "AES-GCM" },
    !1,
    [e]
  ), y.set(t, s)), s;
}
class D {
  /**
   * Encrypt a CRDT change with a group key.
   */
  static async encryptChange(e, t, s, r, a) {
    const n = await d(t, "encrypt"), h = crypto.getRandomValues(new Uint8Array(12)), o = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: h },
      n,
      e
    );
    return {
      ciphertext: new Uint8Array(o),
      nonce: h,
      spaceId: s,
      generation: r,
      fromDid: a
    };
  }
  /**
   * Decrypt a CRDT change with a group key.
   */
  static async decryptChange(e, t) {
    const s = await d(t, "decrypt"), r = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: e.nonce },
      s,
      e.ciphertext
    );
    return new Uint8Array(r);
  }
}
class E {
  constructor() {
    i(this, "spaces", /* @__PURE__ */ new Map());
  }
  /**
   * Create a new group key for a space (generation 0).
   * Returns the generated key.
   */
  async createKey(e) {
    const t = crypto.getRandomValues(new Uint8Array(32));
    return this.spaces.set(e, { keys: [t] }), t;
  }
  /**
   * Rotate the group key for a space.
   * Increments generation, old keys remain accessible.
   */
  async rotateKey(e) {
    const t = this.spaces.get(e);
    if (!t)
      throw new Error(`No key exists for space: ${e}`);
    const s = crypto.getRandomValues(new Uint8Array(32));
    return t.keys.push(s), s;
  }
  /**
   * Get the current (latest) key for a space.
   * Returns null if space is unknown.
   */
  getCurrentKey(e) {
    const t = this.spaces.get(e);
    return t ? t.keys[t.keys.length - 1] : null;
  }
  /**
   * Get the current generation number for a space.
   * Returns -1 if space is unknown.
   */
  getCurrentGeneration(e) {
    const t = this.spaces.get(e);
    return t ? t.keys.length - 1 : -1;
  }
  /**
   * Get a key by generation (for decrypting old messages).
   * Returns null if space or generation is unknown.
   */
  getKeyByGeneration(e, t) {
    const s = this.spaces.get(e);
    return !s || t < 0 || t >= s.keys.length ? null : s.keys[t];
  }
  /**
   * Import a key for a space at a specific generation.
   * Used when receiving a group key from an invite.
   */
  importKey(e, t, s) {
    let r = this.spaces.get(e);
    for (r || (r = { keys: [] }, this.spaces.set(e, r)); r.keys.length <= s; )
      r.keys.push(new Uint8Array(0));
    r.keys[s] = t;
  }
  /**
   * Apply a key-rotation message only if it is exactly the next generation.
   */
  importRotationKey(e, t, s) {
    const r = this.getCurrentGeneration(e);
    return s <= r ? "stale" : s > r + 1 ? "future" : (this.importKey(e, t, s), "applied");
  }
}
class P {
  constructor(e, t, s) {
    i(this, "staleDurationMs");
    i(this, "concurrency");
    i(this, "refreshing", /* @__PURE__ */ new Set());
    this.discovery = e, this.store = t, this.staleDurationMs = (s == null ? void 0 : s.staleDurationMs) ?? 3600 * 1e3, this.concurrency = (s == null ? void 0 : s.concurrency) ?? 3;
  }
  /**
   * Ensure a DID's data is cached. Returns cached data immediately.
   * If stale or missing, fetches in background.
   */
  async ensureCached(e) {
    const t = await this.store.getEntry(e);
    return (!t || this.isStale(t)) && this.refreshInBackground(e), t;
  }
  /**
   * Force-refresh a DID's graph data from the network.
   * Returns the fresh data, or existing cached data if fetch fails.
   */
  async refresh(e) {
    try {
      const [t, s, r] = await Promise.all([
        this.discovery.resolveProfile(e),
        this.discovery.resolveVerifications(e),
        this.discovery.resolveAttestations(e)
      ]);
      return await this.store.cacheEntry(e, t.profile, s, r), this.store.getEntry(e);
    } catch {
      return this.store.getEntry(e);
    }
  }
  /**
   * Refresh graph data for all given contact DIDs.
   * Used on app start to populate cache for contacts.
   * Respects concurrency limit. Only refreshes stale/missing entries.
   */
  async refreshContacts(e) {
    const t = await this.store.getEntries(e), s = e.filter((r) => {
      const a = t.get(r);
      return !a || this.isStale(a);
    });
    if (s.length !== 0)
      for (let r = 0; r < s.length; r += this.concurrency) {
        const a = s.slice(r, r + this.concurrency);
        await Promise.allSettled(a.map((n) => this.refresh(n)));
      }
  }
  /**
   * Lightweight batch refresh: fetches only name + counts for all DIDs
   * in a single HTTP request via resolveSummaries().
   *
   * Falls back to full refreshContacts() if the DiscoveryAdapter
   * doesn't support resolveSummaries().
   */
  async refreshContactSummaries(e) {
    if (e.length !== 0) {
      if (!this.discovery.resolveSummaries)
        return this.refreshContacts(e);
      try {
        const t = await this.discovery.resolveSummaries(e);
        for (const s of t)
          await this.store.updateSummary(s.did, s.name, s.verificationCount, s.attestationCount);
      } catch {
      }
    }
  }
  /** Resolve DID to display name from cache. */
  async resolveName(e) {
    return this.store.resolveName(e);
  }
  /** Batch resolve DIDs to names from cache. */
  async resolveNames(e) {
    return this.store.resolveNames(e);
  }
  /** Find which of myContactDids have also verified the target DID. */
  async findMutualContacts(e, t) {
    return this.store.findMutualContacts(e, t);
  }
  isStale(e) {
    return Date.now() - new Date(e.fetchedAt).getTime() > this.staleDurationMs;
  }
  async refreshInBackground(e) {
    if (!this.refreshing.has(e)) {
      this.refreshing.add(e);
      try {
        await this.refresh(e);
      } finally {
        this.refreshing.delete(e);
      }
    }
  }
}
class x {
  constructor() {
    i(this, "deliveryStatus", /* @__PURE__ */ new Map());
    i(this, "statusSubscribers", /* @__PURE__ */ new Set());
    i(this, "receiptUnsubscribe", null);
    i(this, "messageUnsubscribe", null);
    i(this, "persistFn", null);
  }
  /**
   * Set a persistence callback for delivery status (called on every status change).
   * Apps use this to persist status to their storage layer (e.g. Automerge, IndexedDB).
   */
  setPersistFn(e) {
    this.persistFn = e;
  }
  /**
   * Restore delivery statuses from persistent storage (call on app startup).
   */
  restore(e) {
    const t = ["sending", "queued", "delivered", "acknowledged", "failed"];
    for (const [s, r] of e)
      t.includes(r) && this.deliveryStatus.set(s, r);
    this.notifySubscribers();
  }
  // --- Status access ---
  getStatus(e) {
    return this.deliveryStatus.get(e);
  }
  watchStatus() {
    return {
      getValue: () => this.deliveryStatus,
      subscribe: (e) => (this.statusSubscribers.add(e), () => {
        this.statusSubscribers.delete(e);
      })
    };
  }
  /**
   * Set status for an attestation. Called by the app layer after send attempts.
   */
  setStatus(e, t) {
    var s;
    this.deliveryStatus = new Map(this.deliveryStatus), this.deliveryStatus.set(e, t), this.notifySubscribers(), (s = this.persistFn) == null || s.call(this, e, t).catch(() => {
    });
  }
  // --- Listeners ---
  /**
   * Listen for relay delivery receipts and attestation-ack messages.
   * Call once after messaging is connected.
   */
  listenForReceipts(e) {
    var t, s;
    (t = this.receiptUnsubscribe) == null || t.call(this), (s = this.messageUnsubscribe) == null || s.call(this), this.receiptUnsubscribe = e.onReceipt((r) => {
      this.deliveryStatus.has(r.messageId) && (r.status === "delivered" ? this.setStatus(r.messageId, "delivered") : r.status === "failed" && this.setStatus(r.messageId, "failed"));
    }), this.messageUnsubscribe = e.onMessage((r) => {
      if (r.type === "attestation-ack")
        try {
          const { attestationId: a } = JSON.parse(r.payload);
          a && this.deliveryStatus.has(a) && this.setStatus(a, "acknowledged");
        } catch {
        }
    });
  }
  /**
   * Stop listening for receipts. Call on disconnect/cleanup.
   */
  stopListening() {
    var e, t;
    (e = this.receiptUnsubscribe) == null || e.call(this), (t = this.messageUnsubscribe) == null || t.call(this), this.receiptUnsubscribe = null, this.messageUnsubscribe = null;
  }
  /**
   * Bootstrap delivery status from outbox (on app startup).
   * Marks pending attestation envelopes as 'queued'.
   * Marks stale 'sending' statuses (not in outbox) as 'failed'.
   */
  async initFromOutbox(e) {
    const t = await e.getPending(), s = /* @__PURE__ */ new Set();
    for (const r of t)
      r.envelope.type === "attestation" && (s.add(r.envelope.id), this.setStatus(r.envelope.id, "queued"));
    for (const [r, a] of this.deliveryStatus)
      a === "sending" && !s.has(r) && this.setStatus(r, "failed");
  }
  // --- Private ---
  notifySubscribers() {
    for (const e of this.statusSubscribers)
      e(this.deliveryStatus);
  }
}
class A {
  constructor(e, t) {
    i(this, "vaultUrl");
    i(this, "identity");
    i(this, "capabilityCache", /* @__PURE__ */ new Map());
    i(this, "bearerToken", null);
    this.vaultUrl = e.replace(/\/$/, ""), this.identity = t;
  }
  /**
   * Push an encrypted change to the vault.
   * @returns The assigned sequence number.
   */
  async pushChange(e, t) {
    const s = f(), r = performance.now();
    try {
      const a = await this.authHeaders(e, ["read", "write"]), n = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}/changes`, {
        method: "POST",
        headers: a,
        body: t
      });
      if (!n.ok) {
        const o = await n.text().catch(() => "");
        throw new Error(`Vault pushChange failed: ${n.status} ${o}`);
      }
      const h = await n.json();
      return s.log({ store: "vault", operation: "write", label: `pushChange ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), sizeBytes: t.byteLength, success: !0, meta: { docId: e, seq: h.seq } }), h.seq;
    } catch (a) {
      throw s.log({ store: "vault", operation: "write", label: `pushChange ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), sizeBytes: t.byteLength, success: !1, error: a instanceof Error ? a.message : String(a), meta: { docId: e } }), a;
    }
  }
  /**
   * Get all changes (and optional snapshot) for a document.
   */
  async getChanges(e, t = 0) {
    var a;
    const s = f(), r = performance.now();
    try {
      const n = await this.authHeaders(e, ["read"]), h = `${this.vaultUrl}/docs/${encodeURIComponent(e)}/changes${t > 0 ? `?since=${t}` : ""}`, o = await fetch(h, { headers: n });
      if (o.status === 404)
        return s.log({ store: "vault", operation: "read", label: `getChanges ${e.slice(0, 12)}… (not found)`, durationMs: Math.round(performance.now() - r), success: !0, meta: { docId: e, since: t, changes: 0 } }), { docId: e, snapshot: null, changes: [] };
      if (!o.ok) {
        const l = await o.text().catch(() => "");
        throw new Error(`Vault getChanges failed: ${o.status} ${l}`);
      }
      const u = await o.json();
      return s.log({ store: "vault", operation: "read", label: `getChanges ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { docId: e, since: t, changes: ((a = u.changes) == null ? void 0 : a.length) ?? 0, hasSnapshot: !!u.snapshot } }), u;
    } catch (n) {
      throw s.log({ store: "vault", operation: "read", label: `getChanges ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: n instanceof Error ? n.message : String(n), meta: { docId: e, since: t } }), n;
    }
  }
  /**
   * Store a compacted snapshot (replaces changes up to upToSeq).
   */
  async putSnapshot(e, t, s, r) {
    const a = f(), n = performance.now(), h = 1 + s.length + t.length;
    try {
      const o = await this.authHeaders(e, ["read", "write"]);
      o["Content-Type"] = "application/json";
      const u = new Uint8Array(h);
      u[0] = s.length, u.set(s, 1), u.set(t, 1 + s.length);
      const l = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}/snapshot`, {
        method: "PUT",
        headers: o,
        body: JSON.stringify({
          data: v(u),
          upToSeq: r
        })
      });
      if (!l.ok) {
        const p = await l.text().catch(() => "");
        throw new Error(`Vault putSnapshot failed: ${l.status} ${p}`);
      }
      a.log({ store: "vault", operation: "write", label: `putSnapshot ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - n), sizeBytes: h, success: !0, meta: { docId: e, upToSeq: r } });
    } catch (o) {
      throw a.log({ store: "vault", operation: "write", label: `putSnapshot ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - n), sizeBytes: h, success: !1, error: o instanceof Error ? o.message : String(o), meta: { docId: e, upToSeq: r } }), o;
    }
  }
  /**
   * Get document info (seq, change count).
   */
  async getDocInfo(e) {
    const t = f(), s = performance.now();
    try {
      const r = await this.authHeaders(e, ["read"]), a = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}/info`, { headers: r });
      if (a.status === 404)
        return t.log({ store: "vault", operation: "read", label: `getDocInfo ${e.slice(0, 12)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { docId: e } }), null;
      if (!a.ok) {
        const h = await a.text().catch(() => "");
        throw new Error(`Vault getDocInfo failed: ${a.status} ${h}`);
      }
      const n = await a.json();
      return t.log({ store: "vault", operation: "read", label: `getDocInfo ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { docId: e, ...n } }), n;
    } catch (r) {
      throw t.log({ store: "vault", operation: "read", label: `getDocInfo ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { docId: e } }), r;
    }
  }
  /**
   * Delete a document from the vault.
   */
  async deleteDoc(e) {
    const t = f(), s = performance.now();
    try {
      const r = await this.authHeaders(e, ["read", "write", "delete"]), a = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}`, {
        method: "DELETE",
        headers: r
      });
      if (!a.ok && a.status !== 404) {
        const n = await a.text().catch(() => "");
        throw new Error(`Vault deleteDoc failed: ${a.status} ${n}`);
      }
      t.log({ store: "vault", operation: "delete", label: `deleteDoc ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { docId: e } });
    } catch (r) {
      throw t.log({ store: "vault", operation: "delete", label: `deleteDoc ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { docId: e } }), r;
    }
  }
  // --- Auth ---
  async authHeaders(e, t) {
    const s = await this.getOrCreateBearerToken(), r = await this.getOrCreateCapability(e, t);
    return {
      Authorization: `Bearer ${s}`,
      "X-Capability": r
    };
  }
  async getOrCreateBearerToken() {
    if (this.bearerToken && this.bearerToken.expiresAt > Date.now())
      return this.bearerToken.jws;
    const e = await this.identity.signJws({
      did: this.identity.getDid(),
      iat: Math.floor(Date.now() / 1e3)
    });
    return this.bearerToken = { jws: e, expiresAt: Date.now() + 240 * 1e3 }, e;
  }
  async getOrCreateCapability(e, t) {
    const s = `${e}:${t.sort().join(",")}`, r = this.capabilityCache.get(s);
    if (r && r.expiresAt > Date.now())
      return r.jws;
    const a = new Date(Date.now() + 3600 * 1e3).toISOString(), n = await b(
      {
        issuer: this.identity.getDid(),
        audience: this.identity.getDid(),
        resource: m("space", e),
        permissions: t,
        expiration: a
      },
      (h) => this.identity.signJws(h)
    );
    if (this.capabilityCache.size > 50) {
      const h = Date.now();
      for (const [o, u] of this.capabilityCache)
        u.expiresAt <= h && this.capabilityCache.delete(o);
    }
    return this.capabilityCache.set(s, {
      jws: n,
      expiresAt: Date.now() + 3300 * 1e3
    }), n;
  }
}
class T {
  constructor(e) {
    i(this, "pushFn");
    i(this, "getHeadsFn");
    i(this, "debounceMs");
    i(this, "lastPushedHeads", null);
    i(this, "debounceTimer", null);
    i(this, "pushing", !1);
    i(this, "pendingAfterPush", !1);
    i(this, "destroyed", !1);
    i(this, "onVisibilityChange", null);
    i(this, "onBeforeUnload", null);
    this.pushFn = e.pushFn, this.getHeadsFn = e.getHeadsFn, this.debounceMs = e.debounceMs ?? 5e3, typeof document < "u" && (this.onVisibilityChange = () => {
      document.visibilityState === "hidden" && this.flush();
    }, document.addEventListener("visibilitychange", this.onVisibilityChange)), typeof window < "u" && (this.onBeforeUnload = () => {
      this.flush();
    }, window.addEventListener("beforeunload", this.onBeforeUnload));
  }
  /** Set initial heads (e.g. after loading from vault — vault already has this state). */
  setLastPushedHeads(e) {
    this.lastPushedHeads = e;
  }
  /** Explicit user action — push immediately (deduplicated). */
  pushImmediate() {
    this.destroyed || (this.clearDebounce(), this.schedulePush());
  }
  /** Streaming / remote sync — push after debounce delay. */
  pushDebounced() {
    this.destroyed || (this.clearDebounce(), this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null, this.schedulePush();
    }, this.debounceMs));
  }
  /** Flush any pending debounced push immediately (lifecycle events). */
  flush() {
    this.destroyed || this.debounceTimer && (this.clearDebounce(), this.schedulePush());
  }
  /** Clean up timers and lifecycle handlers. */
  destroy() {
    this.destroyed = !0, this.clearDebounce(), this.onVisibilityChange && typeof document < "u" && (document.removeEventListener("visibilitychange", this.onVisibilityChange), this.onVisibilityChange = null), this.onBeforeUnload && typeof window < "u" && (window.removeEventListener("beforeunload", this.onBeforeUnload), this.onBeforeUnload = null);
  }
  // --- Private ---
  clearDebounce() {
    this.debounceTimer && (clearTimeout(this.debounceTimer), this.debounceTimer = null);
  }
  schedulePush() {
    if (this.pushing) {
      this.pendingAfterPush = !0;
      return;
    }
    const e = this.getHeadsFn();
    e !== null && e === this.lastPushedHeads || (this.pushing = !0, this.pushFn().then(() => {
      this.lastPushedHeads = this.getHeadsFn();
    }).catch(() => {
    }).finally(() => {
      this.pushing = !1, this.pendingAfterPush && !this.destroyed && (this.pendingAfterPush = !1, this.schedulePush());
    }));
  }
}
export {
  x as AttestationDeliveryService,
  D as EncryptedSyncService,
  P as GraphCacheService,
  E as GroupKeyService,
  H as ProfileService,
  A as VaultClient,
  T as VaultPushScheduler,
  R as base64ToUint8
};
