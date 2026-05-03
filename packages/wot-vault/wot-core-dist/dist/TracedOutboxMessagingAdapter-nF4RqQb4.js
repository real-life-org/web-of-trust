var I = Object.defineProperty;
var A = (o, e, t) => e in o ? I(o, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : o[e] = t;
var i = (o, e, t) => A(o, typeof e != "symbol" ? e + "" : e, t);
import { openDB as S } from "idb";
import { S as P } from "./WebCryptoAdapter-A_OiWZNL.js";
import { e as O, d as k } from "./did-key-CMSqoIj7.js";
import { P as g } from "./ProfileService-C_OznEb2.js";
import { g as h } from "./TraceLog-CuKPT7Eo.js";
import { g as M } from "./SpaceMetadataStorage-Diby-YzW.js";
import { c as x, e as y, d as R, v as $ } from "./capabilities-BBiuFuYA.js";
const N = "web-of-trust", U = 2;
class F {
  constructor() {
    i(this, "db", null);
  }
  async init() {
    this.db = await S(N, U, {
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
    const s = this.ensureDb(), r = (/* @__PURE__ */ new Date()).toISOString(), a = {
      did: e,
      profile: t,
      createdAt: r,
      updatedAt: r
    };
    return await s.put("identity", a), a;
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
const E = "wot.identity.seed", D = 1, v = "bip39-64-byte", m = "Stored identity uses an unsupported legacy seed format. Create a new ID to continue.";
class Q {
  constructor(e = new P()) {
    this.storage = e;
  }
  saveSeed(e, t) {
    return this.storage.storeSeed(this.encodeSeed(e), t);
  }
  async loadSeed(e) {
    const t = await this.storage.loadSeed(e);
    return t ? this.decodeSeed(t) : null;
  }
  async loadSeedWithSessionKey() {
    const e = await this.storage.loadSeedWithSessionKey();
    return e ? this.decodeSeed(e) : null;
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
      type: E,
      version: D,
      seedFormat: v,
      seed: O(e)
    };
    return new TextEncoder().encode(JSON.stringify(t));
  }
  decodeSeed(e) {
    let t;
    try {
      t = JSON.parse(new TextDecoder().decode(e));
    } catch {
      throw new Error(m);
    }
    if (!_(t)) throw new Error(m);
    try {
      return k(t.seed);
    } catch {
      throw new Error(m);
    }
  }
}
function _(o) {
  if (!o || typeof o != "object") return !1;
  const e = o;
  return e.type === E && e.version === D && e.seedFormat === v && typeof e.seed == "string";
}
const l = class l {
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
    let t = l.registry.get(e);
    t || (t = /* @__PURE__ */ new Set(), l.registry.set(e, t)), t.add(this);
    const s = l.offlineQueue.get(e);
    if (s && s.length > 0) {
      l.offlineQueue.delete(e);
      for (const r of s)
        await this.deliverToSelf(r);
    }
  }
  async disconnect() {
    if (this.myDid) {
      const e = l.registry.get(this.myDid);
      e && (e.delete(this), e.size === 0 && l.registry.delete(this.myDid));
    }
    this.myDid = null, this.notifyStateChange("disconnected");
  }
  getState() {
    return this.state;
  }
  async send(e) {
    if (this.state !== "connected" || !this.myDid)
      throw new Error("MessagingAdapter: must call connect() before send()");
    const t = (/* @__PURE__ */ new Date()).toISOString(), s = l.registry.get(e.toDid);
    if (s && s.size > 0) {
      for (const n of s)
        await n.deliverToSelf(e);
      const a = {
        messageId: e.id,
        status: "delivered",
        timestamp: t
      };
      for (const n of this.receiptCallbacks)
        n(a);
    }
    const r = l.offlineQueue.get(e.toDid) ?? [];
    return r.push(e), l.offlineQueue.set(e.toDid, r), {
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
    l.transportMap.set(e, t);
  }
  async resolveTransport(e) {
    return l.transportMap.get(e) ?? null;
  }
  /** Reset all shared state. Call in afterEach() for test isolation. */
  static resetAll() {
    for (const e of l.registry.values())
      for (const t of e)
        t.myDid = null, t.state = "disconnected";
    l.registry.clear(), l.offlineQueue.clear(), l.transportMap.clear();
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
i(l, "registry", /* @__PURE__ */ new Map()), i(l, "offlineQueue", /* @__PURE__ */ new Map()), i(l, "transportMap", /* @__PURE__ */ new Map());
let w = l;
class Y {
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
            const a = this.ws, n = () => {
              a.readyState === WebSocket.OPEN ? a.send(JSON.stringify({ type: "register", did: e })) : a.readyState === WebSocket.CONNECTING ? setTimeout(n, 10) : s(new Error("WebSocket closed before registration"));
            };
            setTimeout(n, 10);
          }
        }, this.ws.onmessage = (r) => {
          let a;
          try {
            a = JSON.parse(typeof r.data == "string" ? r.data : r.data.toString());
          } catch {
            console.warn("[WebSocket] Received malformed JSON, ignoring");
            return;
          }
          switch (a.type) {
            case "challenge":
              this.signChallenge ? this.signChallenge(a.nonce).then((n) => {
                var c;
                (c = this.ws) == null || c.send(JSON.stringify({
                  type: "challenge-response",
                  did: e,
                  nonce: a.nonce,
                  signature: n
                }));
              }).catch((n) => {
                this.setState("error"), s(new Error(`Challenge signing failed: ${n instanceof Error ? n.message : String(n)}`));
              }) : (this.setState("error"), s(new Error("Relay requires challenge-response auth but no signChallenge function provided")));
              break;
            case "registered":
              this.connectedDid = e, this.peerCount = typeof a.peers == "number" ? a.peers : 0, this.setState("connected"), this.startHeartbeat(), t();
              break;
            case "message":
              this.handleIncomingMessage(a.envelope);
              break;
            case "receipt": {
              const n = a.receipt, c = this.pendingReceipts.get(n.messageId);
              c && (this.pendingReceipts.delete(n.messageId), c(n));
              for (const u of this.receiptCallbacks)
                u(n);
              break;
            }
            case "pong":
              this.handlePong();
              break;
            case "error":
              this.state === "connecting" && (this.setState("error"), s(new Error(`Relay error: ${a.message}`)));
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
      if (this.pendingReceipts.set(e.id, (a) => {
        r && clearTimeout(r), t(a);
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
class X {
  constructor(e) {
    i(this, "TIMEOUT_MS", 3e3);
    this.baseUrl = e;
  }
  fetchWithTimeout(e, t) {
    const s = new AbortController(), r = setTimeout(() => s.abort(), this.TIMEOUT_MS);
    return fetch(e, { ...t, signal: s.signal }).finally(() => clearTimeout(r));
  }
  async publishProfile(e, t) {
    const s = h(), r = performance.now();
    try {
      const a = await g.signProfile(e, t), n = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}`,
        { method: "PUT", body: a, headers: { "Content-Type": "application/jws" } }
      );
      if (!n.ok) throw new Error(`Profile upload failed: ${n.status}`);
      s.log({ store: "profiles", operation: "write", label: `publishProfile ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e.did, name: e.name } });
    } catch (a) {
      throw s.log({ store: "profiles", operation: "write", label: `publishProfile ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: a instanceof Error ? a.message : String(a), meta: { did: e.did } }), a;
    }
  }
  async publishVerifications(e, t) {
    var a;
    const s = h(), r = performance.now();
    try {
      const n = await t.signJws(e), c = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}/v`,
        { method: "PUT", body: n, headers: { "Content-Type": "text/plain" } }
      );
      if (!c.ok) throw new Error(`Verifications upload failed: ${c.status}`);
      s.log({ store: "profiles", operation: "write", label: `publishVerifications ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e.did, count: ((a = e.verifications) == null ? void 0 : a.length) ?? 0 } });
    } catch (n) {
      throw s.log({ store: "profiles", operation: "write", label: `publishVerifications ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: n instanceof Error ? n.message : String(n), meta: { did: e.did } }), n;
    }
  }
  async publishAttestations(e, t) {
    var a;
    const s = h(), r = performance.now();
    try {
      const n = await t.signJws(e), c = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}/a`,
        { method: "PUT", body: n, headers: { "Content-Type": "text/plain" } }
      );
      if (!c.ok) throw new Error(`Attestations upload failed: ${c.status}`);
      s.log({ store: "profiles", operation: "write", label: `publishAttestations ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e.did, count: ((a = e.attestations) == null ? void 0 : a.length) ?? 0 } });
    } catch (n) {
      throw s.log({ store: "profiles", operation: "write", label: `publishAttestations ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: n instanceof Error ? n.message : String(n), meta: { did: e.did } }), n;
    }
  }
  async resolveProfile(e) {
    const t = h(), s = performance.now();
    try {
      const r = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}`);
      if (r.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, found: !1 } }), { profile: null, fromCache: !1 };
      if (!r.ok) throw new Error(`Profile fetch failed: ${r.status}`);
      const a = await r.text(), n = await g.verifyProfile(a), c = n.valid && n.profile ? n.profile : null;
      return t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, found: !!c, name: c == null ? void 0 : c.name } }), { profile: c, didDocument: n.didDocument ?? null, version: n.version, fromCache: !1 };
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { did: e } }), r;
    }
  }
  async resolveVerifications(e) {
    const t = h(), s = performance.now();
    try {
      const r = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/v`);
      if (r.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: 0 } }), [];
      if (!r.ok) throw new Error(`Verifications fetch failed: ${r.status}`);
      const a = await r.text(), n = await g.verifySignedPayload(a);
      if (!n.valid || !n.payload) return [];
      const u = n.payload.verifications ?? [];
      return t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: u.length } }), u;
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { did: e } }), r;
    }
  }
  async resolveAttestations(e) {
    const t = h(), s = performance.now();
    try {
      const r = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/a`);
      if (r.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: 0 } }), [];
      if (!r.ok) throw new Error(`Attestations fetch failed: ${r.status}`);
      const a = await r.text(), n = await g.verifySignedPayload(a);
      if (!n.valid || !n.payload) return [];
      const u = n.payload.attestations ?? [];
      return t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e, count: u.length } }), u;
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { did: e } }), r;
    }
  }
  async resolveSummaries(e) {
    const t = h(), s = performance.now();
    try {
      const r = e.map((c) => encodeURIComponent(c)).join(","), a = await this.fetchWithTimeout(`${this.baseUrl}/s?dids=${r}`);
      if (!a.ok) throw new Error(`Summary fetch failed: ${a.status}`);
      const n = await a.json();
      return t.log({ store: "profiles", operation: "read", label: `resolveSummaries (${e.length} DIDs)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { count: e.length, results: n.length } }), n;
    } catch (r) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveSummaries (${e.length} DIDs)`, durationMs: Math.round(performance.now() - s), success: !1, error: r instanceof Error ? r.message : String(r), meta: { count: e.length } }), r;
    }
  }
}
class Z {
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
    const a = await s();
    if (r.has("profile") && a.profile)
      try {
        await this.inner.publishProfile(a.profile, t), await this.publishState.clearDirty(e, "profile"), this.clearError();
      } catch (n) {
        this.setError(n);
      }
    if (r.has("verifications") && a.verifications)
      try {
        await this.inner.publishVerifications(a.verifications, t), await this.publishState.clearDirty(e, "verifications"), this.clearError();
      } catch (n) {
        this.setError(n);
      }
    if (r.has("attestations") && a.attestations)
      try {
        await this.inner.publishAttestations(a.attestations, t), await this.publishState.clearDirty(e, "attestations"), this.clearError();
      } catch (n) {
        this.setError(n);
      }
  }
}
class ee {
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
class te {
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
    const s = this.profiles.get(e), r = this.verifications.get(e) ?? [], a = this.attestations.get(e) ?? [], n = this.summaryCounts.get(e);
    return {
      did: e,
      name: s == null ? void 0 : s.name,
      bio: s == null ? void 0 : s.bio,
      avatar: s == null ? void 0 : s.avatar,
      verificationCount: (n == null ? void 0 : n.verificationCount) ?? r.length,
      attestationCount: (n == null ? void 0 : n.attestationCount) ?? a.length,
      verifierDids: r.map((c) => c.from),
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
      const a = (s = this.profiles.get(r)) == null ? void 0 : s.name;
      a && t.set(r, a);
    }
    return t;
  }
  async findMutualContacts(e, t) {
    const s = this.verifications.get(e) ?? [], r = new Set(s.map((a) => a.from));
    return t.filter((a) => r.has(a));
  }
  async search(e) {
    var r, a;
    const t = e.toLowerCase(), s = [];
    for (const [n] of this.fetchedAt) {
      const c = this.profiles.get(n), u = (r = c == null ? void 0 : c.name) == null ? void 0 : r.toLowerCase().includes(t), C = (a = c == null ? void 0 : c.bio) == null ? void 0 : a.toLowerCase().includes(t), T = (this.attestations.get(n) ?? []).some((p) => p.claim.toLowerCase().includes(t));
      if (u || C || T) {
        const p = await this.getEntry(n);
        p && s.push(p);
      }
    }
    return s;
  }
  async updateSummary(e, t, s, r) {
    if (t !== null) {
      const a = this.profiles.get(e);
      this.profiles.set(e, {
        did: e,
        name: t,
        ...a != null && a.bio ? { bio: a.bio } : {},
        ...a != null && a.avatar ? { avatar: a.avatar } : {},
        updatedAt: (a == null ? void 0 : a.updatedAt) ?? (/* @__PURE__ */ new Date()).toISOString()
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
class se {
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
        (a) => {
          clearTimeout(r), t(a);
        },
        (a) => {
          clearTimeout(r), s(a);
        }
      );
    });
  }
}
class re {
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
class ae {
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
class ne {
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
const j = "wot-space-metadata", K = 1, d = "spaces", f = "groupKeys";
class ie {
  constructor(e = j) {
    i(this, "dbPromise");
    this.dbPromise = S(e, K, {
      upgrade(t) {
        t.objectStoreNames.contains(d) || t.createObjectStore(d, { keyPath: "info.id" }), t.objectStoreNames.contains(f) || t.createObjectStore(f, { keyPath: "id" }).createIndex("bySpaceId", "spaceId");
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
          ([r, a]) => [r, Array.from(a)]
        )
      )
    };
    await t.put(d, s);
  }
  async loadSpaceMetadata(e) {
    const s = await (await this.dbPromise).get(d, e);
    return s ? this.deserialize(s) : null;
  }
  async loadAllSpaceMetadata() {
    return (await (await this.dbPromise).getAll(d)).map((s) => this.deserialize(s));
  }
  async deleteSpaceMetadata(e) {
    await (await this.dbPromise).delete(d, e);
  }
  async saveGroupKey(e) {
    const t = await this.dbPromise, s = {
      id: M(e.spaceId, e.generation),
      spaceId: e.spaceId,
      generation: e.generation,
      key: Array.from(e.key)
    };
    await t.put(f, s);
  }
  async loadGroupKeys(e) {
    return (await (await this.dbPromise).getAllFromIndex(f, "bySpaceId", e)).map((r) => ({
      spaceId: r.spaceId,
      generation: r.generation,
      key: new Uint8Array(r.key)
    }));
  }
  async deleteGroupKeys(e) {
    const t = await this.dbPromise, s = await t.getAllKeysFromIndex(f, "bySpaceId", e), r = t.transaction(f, "readwrite");
    for (const a of s)
      await r.store.delete(a);
    await r.done;
  }
  async clearAll() {
    const t = (await this.dbPromise).transaction([d, f], "readwrite");
    await t.objectStore(d).clear(), await t.objectStore(f).clear(), await t.done;
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
class oe {
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
    const a = await x(
      {
        issuer: this.myDid,
        audience: t,
        resource: e,
        permissions: s,
        expiration: r
      },
      this.sign
    );
    return this.granted.push(a), a;
  }
  async delegate(e, t, s, r) {
    const a = y(e);
    if (!a) throw new Error("Invalid parent capability");
    const n = r ?? a.expiration, c = await R(
      e,
      { audience: t, permissions: s, expiration: n },
      this.sign
    );
    return this.granted.push(c), c;
  }
  async verify(e) {
    const t = await $(e);
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
    for (const a of r) {
      const n = y(a);
      if (!n || n.audience !== e || n.resource !== t || !n.permissions.includes(s)) continue;
      if ((await this.verify(a)).valid) return !0;
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
      const s = y(t);
      return s && s.resource === e;
    }) : [...this.received];
  }
  async getGrantedCapabilities(e) {
    return e ? this.granted.filter((t) => {
      const s = y(t);
      return s && s.resource === e;
    }) : [...this.granted];
  }
}
class ce {
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
        const a = t();
        a !== s && (s = a, r(s));
      }),
      getValue: () => s
    };
  }
}
class le {
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
            ([r, a]) => [r, Array.from(a)]
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
    const t = M(e.spaceId, e.generation);
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
function b(o) {
  var e;
  return {
    id: o.id,
    v: o.v,
    type: o.type,
    fromDid: o.fromDid,
    toDid: o.toDid,
    createdAt: o.createdAt,
    encoding: o.encoding,
    ref: o.ref,
    payloadSize: (e = o.payload) == null ? void 0 : e.length
  };
}
class he {
  constructor(e) {
    this.inner = e;
  }
  async connect(e) {
    const t = h(), s = performance.now();
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
    const e = h();
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
      h().log({
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
    const t = h(), s = performance.now();
    try {
      const r = await this.inner.send(e);
      return t.log({
        store: r.reason === "queued-in-outbox" ? "outbox" : "relay",
        operation: "send",
        label: `send ${e.type} → ${e.toDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - s),
        success: !0,
        meta: {
          ...b(e),
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
        meta: b(e)
      }), r;
    }
  }
  onMessage(e) {
    return this.inner.onMessage((t) => (h().log({
      store: "relay",
      operation: "receive",
      label: `receive ${t.type} ← ${t.fromDid.slice(0, 24)}…`,
      durationMs: 0,
      success: !0,
      meta: b(t)
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
    const e = h(), t = performance.now(), s = this.inner.getOutboxStore(), r = await s.count();
    try {
      await this.inner.flushOutbox();
      const a = await s.count();
      e.log({
        store: "outbox",
        operation: "flush",
        label: `flush outbox ${r} → ${a}`,
        durationMs: Math.round(performance.now() - t),
        success: !0,
        meta: { pendingBefore: r, pendingAfter: a, delivered: r - a }
      });
    } catch (a) {
      throw e.log({
        store: "outbox",
        operation: "flush",
        label: "flush outbox failed",
        durationMs: Math.round(performance.now() - t),
        success: !1,
        error: a instanceof Error ? a.message : String(a),
        meta: { pendingBefore: r }
      }), a;
    }
  }
  getOutboxStore() {
    return this.inner.getOutboxStore();
  }
}
export {
  X as H,
  w as I,
  F as L,
  Z as O,
  ce as P,
  Q as S,
  he as T,
  Y as W,
  ee as a,
  te as b,
  se as c,
  re as d,
  ae as e,
  ne as f,
  ie as g,
  oe as h,
  le as i
};
