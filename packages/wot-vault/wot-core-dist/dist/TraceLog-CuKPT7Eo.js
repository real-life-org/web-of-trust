var m = Object.defineProperty;
var b = (o, t, e) => t in o ? m(o, t, { enumerable: !0, configurable: !0, writable: !0, value: e }) : o[t] = e;
var u = (o, t, e) => b(o, typeof t != "symbol" ? t + "" : t, e);
const p = "wot-trace-log", h = "traces";
class w {
  constructor() {
    u(this, "entries", []);
    u(this, "nextId", 1);
    u(this, "subscribers", /* @__PURE__ */ new Set());
    u(this, "db", null);
    u(this, "pendingWrites", []);
    u(this, "flushTimer", null);
    u(this, "initialized", !1);
  }
  async init() {
    if (!this.initialized && (this.initialized = !0, !(typeof indexedDB > "u")))
      try {
        this.db = await this.openDb();
        const t = await this.loadFromDb();
        t.length > 0 && (this.entries = t.slice(-1e3), this.nextId = Math.max(...this.entries.map((e) => e.id)) + 1), this.startFlushTimer();
      } catch (t) {
        console.warn("[TraceLog] IndexedDB init failed, running in-memory only:", t);
      }
  }
  log(t) {
    const e = {
      ...t,
      id: this.nextId++,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    return this.entries.push(e), this.entries.length > 1e3 && this.entries.shift(), this.pendingWrites.push(e), this.notifySubscribers(e), e;
  }
  getAll(t) {
    let e = [...this.entries];
    return t != null && t.store && (e = e.filter((s) => s.store === t.store)), t != null && t.operation && (e = e.filter((s) => s.operation === t.operation)), (t == null ? void 0 : t.success) !== void 0 && (e = e.filter((s) => s.success === t.success)), t != null && t.since && (e = e.filter((s) => s.timestamp >= t.since)), t != null && t.limit && (e = e.slice(-t.limit)), e;
  }
  getLatest(t = 50) {
    return this.entries.slice(-t);
  }
  getErrors(t = 20) {
    return this.entries.filter((e) => !e.success).slice(-t);
  }
  getByStore(t) {
    return this.entries.filter((e) => e.store === t);
  }
  getPerformanceSummary() {
    const t = /* @__PURE__ */ new Map();
    for (const s of this.entries) {
      if (!s.success) continue;
      const n = `${s.store}:${s.operation}`;
      let r = t.get(n);
      r || (r = [], t.set(n, r)), r.push(s.durationMs);
    }
    const e = {};
    for (const [s, n] of t) {
      const r = [...n].sort((l, f) => l - f), c = r.length, i = Math.round(r.reduce((l, f) => l + f, 0) / c), a = r[Math.floor(c * 0.95)] ?? r[c - 1], d = r[c - 1];
      e[s] = { count: c, avgMs: i, p95Ms: a, maxMs: d };
    }
    return e;
  }
  subscribe(t) {
    return this.subscribers.add(t), () => this.subscribers.delete(t);
  }
  clear() {
    if (this.entries = [], this.pendingWrites = [], this.db)
      try {
        this.db.transaction(h, "readwrite").objectStore(h).clear();
      } catch {
      }
  }
  get size() {
    return this.entries.length;
  }
  // --- Private ---
  notifySubscribers(t) {
    for (const e of this.subscribers)
      try {
        e(t);
      } catch {
      }
  }
  startFlushTimer() {
    this.flushTimer || (this.flushTimer = setTimeout(() => {
      this.flushTimer = null, this.flushToDb().finally(() => {
        this.pendingWrites.length > 0 && this.startFlushTimer();
      });
    }, 500));
  }
  async flushToDb() {
    if (!this.db || this.pendingWrites.length === 0) return;
    const t = this.pendingWrites.splice(0);
    try {
      const s = this.db.transaction(h, "readwrite").objectStore(h);
      for (const r of t)
        s.put(r);
      const n = s.count();
      n.onsuccess = () => {
        const r = n.result;
        if (r > 1e3) {
          const c = r - 1e3, i = s.openCursor();
          let a = 0;
          i.onsuccess = () => {
            const d = i.result;
            d && a < c && (d.delete(), a++, d.continue());
          };
        }
      };
    } catch (e) {
      console.warn("[TraceLog] flush to IDB failed:", e);
    }
  }
  openDb() {
    return new Promise((t, e) => {
      const s = indexedDB.open(p, 1);
      s.onupgradeneeded = () => {
        const n = s.result;
        n.objectStoreNames.contains(h) || n.createObjectStore(h, { keyPath: "id" });
      }, s.onsuccess = () => t(s.result), s.onerror = () => e(s.error);
    });
  }
  loadFromDb() {
    return new Promise((t, e) => {
      if (!this.db) return t([]);
      try {
        const r = this.db.transaction(h, "readonly").objectStore(h).getAll();
        r.onsuccess = () => t(r.result ?? []), r.onerror = () => e(r.error);
      } catch {
        t([]);
      }
    });
  }
}
let g = null;
function T() {
  return g || (g = new w()), g;
}
async function y(o, t, e, s, n) {
  const r = T(), c = performance.now();
  try {
    const i = await s(), a = Math.round(performance.now() - c), d = i instanceof Uint8Array ? i.byteLength : void 0;
    return r.log({ store: o, operation: t, label: e, durationMs: a, sizeBytes: d, success: !0, meta: n }), i;
  } catch (i) {
    const a = Math.round(performance.now() - c);
    throw r.log({
      store: o,
      operation: t,
      label: e,
      durationMs: a,
      success: !1,
      error: i instanceof Error ? i.message : String(i),
      meta: n
    }), i;
  }
}
function M(o, t, e, s, n) {
  return y(o, (s == null ? void 0 : s.method) === "GET" ? "read" : "write", t, async () => {
    const r = await fetch(e, s);
    if (!r.ok)
      throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return r;
  }, { url: e, method: (s == null ? void 0 : s.method) ?? "GET", ...n });
}
function E(o) {
  typeof window < "u" && (window.wotTrace = (t) => o.getAll(t), window.wotTracePerf = () => o.getPerformanceSummary(), window.wotTraceClear = () => o.clear());
}
export {
  w as T,
  M as a,
  T as g,
  E as r,
  y as t
};
