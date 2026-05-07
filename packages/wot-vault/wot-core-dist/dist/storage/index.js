var m = Object.defineProperty;
var d = (c, t, s) => t in c ? m(c, t, { enumerable: !0, configurable: !0, writable: !0, value: s }) : c[t] = s;
var n = (c, t, s) => d(c, typeof t != "symbol" ? t + "" : t, s);
import { g as h, r as g } from "../TraceLog-CuKPT7Eo.js";
import { T as C, t as k, a as L } from "../TraceLog-CuKPT7Eo.js";
class M {
  constructor(t = "wot-compact-store") {
    n(this, "dbName");
    n(this, "db", null);
    this.dbName = t;
  }
  async open() {
    return new Promise((t, s) => {
      const e = indexedDB.open(this.dbName, 1);
      e.onupgradeneeded = () => {
        const o = e.result;
        o.objectStoreNames.contains("snapshots") || o.createObjectStore("snapshots");
      }, e.onsuccess = () => {
        this.db = e.result, t();
      }, e.onerror = () => {
        s(e.error);
      };
    });
  }
  async save(t, s) {
    const e = this.getDb();
    return new Promise((o, r) => {
      const l = e.transaction("snapshots", "readwrite").objectStore("snapshots").put(s, t);
      l.onsuccess = () => o(), l.onerror = () => r(l.error);
    });
  }
  async load(t) {
    const s = this.getDb();
    return new Promise((e, o) => {
      const a = s.transaction("snapshots", "readonly").objectStore("snapshots").get(t);
      a.onsuccess = () => e(a.result ?? null), a.onerror = () => o(a.error);
    });
  }
  async delete(t) {
    const s = this.getDb();
    return new Promise((e, o) => {
      const a = s.transaction("snapshots", "readwrite").objectStore("snapshots").delete(t);
      a.onsuccess = () => e(), a.onerror = () => o(a.error);
    });
  }
  async list() {
    const t = this.getDb();
    return new Promise((s, e) => {
      const r = t.transaction("snapshots", "readonly").objectStore("snapshots"), i = [], a = r.openCursor();
      a.onsuccess = () => {
        const l = a.result;
        l ? (i.push(l.key), l.continue()) : s(i);
      }, a.onerror = () => e(a.error);
    });
  }
  close() {
    this.db && (this.db.close(), this.db = null);
  }
  getDb() {
    if (!this.db) throw new Error("CompactStorageManager not opened. Call open() first.");
    return this.db;
  }
}
function u(c) {
  return c < 1024 ? `${c}B` : `${(c / 1024).toFixed(1)}KB`;
}
function S(c) {
  return Object.entries(c).map(([t, s]) => `${t}=${s}`).join(" ");
}
class f {
  constructor(t) {
    n(this, "impl");
    n(this, "lastLoad", null);
    n(this, "compactStoreSaves", { lastAt: null, lastTimeMs: 0, lastSizeBytes: 0, totalSaves: 0, errors: 0 });
    n(this, "vaultSaves", { lastAt: null, lastTimeMs: 0, lastSizeBytes: 0, totalSaves: 0, errors: 0 });
    n(this, "migration", null);
    n(this, "errors", []);
    n(this, "blockedUiSamples", []);
    // Space metrics
    n(this, "spaceMetrics", /* @__PURE__ */ new Map());
    // Legacy-specific
    n(this, "_idbChunkCount", null);
    n(this, "_healthCheckResult", null);
    n(this, "_findDurationMs", null);
    n(this, "_flushDurationMs", null);
    // Sync info (set externally)
    n(this, "_relayConnected", !1);
    n(this, "_relayUrl", null);
    n(this, "_relayPeers", 0);
    n(this, "_relayLastMessage", null);
    // Doc info (set externally)
    n(this, "_docSizeBytes", 0);
    n(this, "_docContacts", 0);
    n(this, "_docAttestations", 0);
    n(this, "_docSpaces", 0);
    this.impl = t;
  }
  logLoad(t, s, e, o = {}) {
    const r = {
      source: t,
      timeMs: s,
      sizeBytes: e,
      details: o,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.lastLoad = r;
    const i = Object.keys(o).length > 0 ? ` ${S(o)}` : "";
    console.log(`[persistence] ✓ load impl=${this.impl} source=${t} time=${s}ms size=${u(e)}${i}`);
    const a = { "compact-store": "compact-store", indexeddb: "compact-store", vault: "vault", "wot-profiles": "profiles", migration: "compact-store", new: "personal-doc" };
    h().log({
      store: a[t] ?? "personal-doc",
      operation: "read",
      label: `load from ${t}`,
      durationMs: s,
      sizeBytes: e,
      success: !0,
      meta: { impl: this.impl, ...o }
    });
  }
  logSave(t, s, e, o) {
    const r = t === "compact-store" ? this.compactStoreSaves : this.vaultSaves;
    r.lastAt = (/* @__PURE__ */ new Date()).toISOString(), r.lastTimeMs = s, r.lastSizeBytes = e, r.totalSaves++, o !== void 0 && (this.blockedUiSamples.push(o), this.blockedUiSamples.length > 100 && this.blockedUiSamples.shift());
    const i = o !== void 0 ? ` save-blocked-ui=${o}ms` : "";
    console.log(`[persistence] ✓ save impl=${this.impl} target=${t} time=${s}ms size=${u(e)}${i}`), h().log({
      store: t,
      operation: "write",
      label: `save to ${t}`,
      durationMs: s,
      sizeBytes: e,
      success: !0,
      meta: { impl: this.impl, blockedUiMs: o }
    });
  }
  logError(t, s) {
    const e = s instanceof Error ? s.message : String(s), o = {
      operation: t,
      error: e,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (this.errors.push(o), this.errors.length > 50 && this.errors.shift(), t.startsWith("save:")) {
      const l = t.split(":")[1];
      l === "compact-store" && this.compactStoreSaves.errors++, l === "vault" && this.vaultSaves.errors++;
    }
    console.error(`[persistence] ✗ ${t} impl=${this.impl} error="${e}"`);
    const r = t.split(":"), i = r[0] === "save" ? "write" : r[0] === "load" ? "read" : "error", a = r[1] ?? "personal-doc";
    h().log({
      store: a,
      operation: i,
      label: t,
      durationMs: 0,
      success: !1,
      error: e,
      meta: { impl: this.impl }
    });
  }
  logMigration(t, s) {
    this.migration = {
      fromChunks: t,
      toSizeBytes: s,
      at: (/* @__PURE__ */ new Date()).toISOString()
    }, console.log(`[persistence] ⚡ migration impl=${this.impl} chunks=${t} → snapshot=${u(s)}`);
  }
  // --- Legacy-specific setters ---
  setIdbChunkCount(t) {
    this._idbChunkCount = t;
  }
  setHealthCheckResult(t) {
    this._healthCheckResult = t;
  }
  setFindDuration(t) {
    this._findDurationMs = t;
  }
  setFlushDuration(t) {
    this._flushDurationMs = t;
  }
  // --- Sync info setters ---
  setRelayStatus(t, s, e) {
    this._relayConnected = t, this._relayUrl = s, this._relayPeers = e, this._relayLastMessage = (/* @__PURE__ */ new Date()).toISOString();
  }
  // --- Doc info setters ---
  setDocStats(t, s, e, o) {
    this._docSizeBytes = t, this._docContacts = s, this._docAttestations = e, this._docSpaces = o;
  }
  // --- Space metrics ---
  logSpaceLoad(t, s, e, o, r, i) {
    const a = this.spaceMetrics.get(t);
    this.spaceMetrics.set(t, {
      spaceId: t,
      name: s,
      loadSource: e,
      loadTimeMs: o,
      docSizeBytes: r,
      compactStoreSaves: (a == null ? void 0 : a.compactStoreSaves) ?? 0,
      vaultSaves: (a == null ? void 0 : a.vaultSaves) ?? 0,
      lastSaveMs: (a == null ? void 0 : a.lastSaveMs) ?? null,
      members: i
    }), console.log(`[persistence] ✓ space-load id=${t.slice(0, 8)}… name="${s}" source=${e} time=${o}ms size=${u(r)} members=${i}`);
  }
  logSpaceSave(t, s, e, o) {
    const r = this.spaceMetrics.get(t);
    r && (r.docSizeBytes = o, r.lastSaveMs = e, s === "compact-store" ? r.compactStoreSaves++ : r.vaultSaves++);
  }
  removeSpace(t) {
    this.spaceMetrics.delete(t);
  }
  // --- Implementation tag ---
  setImpl(t) {
    this.impl = t;
  }
  // --- Debug API ---
  getSnapshot() {
    const t = this.blockedUiSamples, s = t.length > 0 ? Math.round(t.reduce((r, i) => r + i, 0) / t.length) : 0, e = t.length > 0 ? Math.max(...t) : 0, o = t.length > 0 ? t[t.length - 1] : 0;
    return {
      impl: this.impl,
      persistence: {
        lastLoad: this.lastLoad,
        saves: {
          compactStore: { ...this.compactStoreSaves },
          vault: { ...this.vaultSaves }
        },
        migration: this.migration,
        errors: [...this.errors]
      },
      spaces: Array.from(this.spaceMetrics.values()).map((r) => ({ ...r })),
      sync: {
        relay: {
          connected: this._relayConnected,
          url: this._relayUrl,
          peers: this._relayPeers,
          lastMessage: this._relayLastMessage
        }
      },
      automerge: {
        saveBlockedUiMs: { last: o, avg: s, max: e },
        docSizeBytes: this._docSizeBytes,
        docStats: {
          contacts: this._docContacts,
          attestations: this._docAttestations,
          spaces: this._docSpaces
        }
      },
      legacy: {
        idbChunkCount: this._idbChunkCount,
        healthCheckResult: this._healthCheckResult,
        findDurationMs: this._findDurationMs,
        flushDurationMs: this._flushDurationMs
      }
    };
  }
}
let p = null;
function v() {
  return p || (p = new f("legacy")), p;
}
function y(c) {
  if (typeof window < "u") {
    window.wotDebug = () => c.getSnapshot();
    const t = h();
    t.init(), g(t);
  }
}
class _ {
  constructor(t) {
    this.inner = t;
  }
  async open() {
    const t = h(), s = performance.now();
    try {
      await this.inner.open(), t.log({
        store: "compact-store",
        operation: "connect",
        label: "open IndexedDB",
        durationMs: Math.round(performance.now() - s),
        success: !0
      });
    } catch (e) {
      throw t.log({
        store: "compact-store",
        operation: "connect",
        label: "open IndexedDB",
        durationMs: Math.round(performance.now() - s),
        success: !1,
        error: e instanceof Error ? e.message : String(e)
      }), e;
    }
  }
  async save(t, s) {
    const e = h(), o = performance.now();
    try {
      await this.inner.save(t, s), e.log({
        store: "compact-store",
        operation: "write",
        label: `save ${t.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - o),
        sizeBytes: s.byteLength,
        success: !0,
        meta: { docId: t }
      });
    } catch (r) {
      throw e.log({
        store: "compact-store",
        operation: "write",
        label: `save ${t.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - o),
        sizeBytes: s.byteLength,
        success: !1,
        error: r instanceof Error ? r.message : String(r),
        meta: { docId: t }
      }), r;
    }
  }
  async load(t) {
    const s = h(), e = performance.now();
    try {
      const o = await this.inner.load(t);
      return s.log({
        store: "compact-store",
        operation: "read",
        label: `load ${t.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - e),
        sizeBytes: o == null ? void 0 : o.byteLength,
        success: !0,
        meta: { docId: t, found: o !== null }
      }), o;
    } catch (o) {
      throw s.log({
        store: "compact-store",
        operation: "read",
        label: `load ${t.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - e),
        success: !1,
        error: o instanceof Error ? o.message : String(o),
        meta: { docId: t }
      }), o;
    }
  }
  async delete(t) {
    const s = h(), e = performance.now();
    try {
      await this.inner.delete(t), s.log({
        store: "compact-store",
        operation: "delete",
        label: `delete ${t.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - e),
        success: !0,
        meta: { docId: t }
      });
    } catch (o) {
      throw s.log({
        store: "compact-store",
        operation: "delete",
        label: `delete ${t.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - e),
        success: !1,
        error: o instanceof Error ? o.message : String(o),
        meta: { docId: t }
      }), o;
    }
  }
  async list() {
    const t = h(), s = performance.now();
    try {
      const e = await this.inner.list();
      return t.log({
        store: "compact-store",
        operation: "read",
        label: "list all docs",
        durationMs: Math.round(performance.now() - s),
        success: !0,
        meta: { count: e.length }
      }), e;
    } catch (e) {
      throw t.log({
        store: "compact-store",
        operation: "read",
        label: "list all docs",
        durationMs: Math.round(performance.now() - s),
        success: !1,
        error: e instanceof Error ? e.message : String(e)
      }), e;
    }
  }
  close() {
    this.inner.close(), h().log({
      store: "compact-store",
      operation: "disconnect",
      label: "close IndexedDB",
      durationMs: 0,
      success: !0
    });
  }
}
export {
  M as CompactStorageManager,
  f as PersistenceMetrics,
  C as TraceLog,
  _ as TracedCompactStorageManager,
  v as getMetrics,
  h as getTraceLog,
  y as registerDebugApi,
  g as registerTraceApi,
  k as traceAsync,
  L as tracedFetch
};
