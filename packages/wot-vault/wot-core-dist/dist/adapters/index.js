var a = Object.defineProperty;
var i = (r, e, n) => e in r ? a(r, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : r[e] = n;
var s = (r, e, n) => i(r, typeof e != "symbol" ? e + "" : e, n);
import { P as g, H as f, i as m, g as y, c as C, I as h, e as l, b as S, f as V, h as M, L as A, O as N, d as D, P as x, j as I, S as P, T as b, W as w, a as O } from "../TracedOutboxMessagingAdapter-BU92H76g.js";
class d {
  constructor() {
    s(this, "consumedNonces", /* @__PURE__ */ new Map());
    s(this, "pendingCounterVerifications", /* @__PURE__ */ new Map());
  }
  async recordConsumedNonce(e, n) {
    this.consumedNonces.set(e.toLowerCase(), n);
  }
  async tryConsumeNonce(e, n) {
    const t = e.toLowerCase();
    return this.consumedNonces.has(t) ? !1 : (this.consumedNonces.set(t, n), !0);
  }
  async hasConsumedNonce(e) {
    return this.consumedNonces.has(e.toLowerCase());
  }
  async pruneConsumedNonces(e) {
    const n = Date.parse(e);
    for (const [t, o] of this.consumedNonces)
      Date.parse(o) < n && this.consumedNonces.delete(t);
  }
  async recordPendingCounterVerification(e) {
    this.pendingCounterVerifications.set(e.originalVerificationId, { ...e });
  }
  async getPendingCounterVerification(e) {
    const n = this.pendingCounterVerifications.get(e);
    return n === void 0 ? null : { ...n };
  }
  async getPendingCounterVerifications() {
    return Array.from(this.pendingCounterVerifications.values(), (e) => ({ ...e }));
  }
  async deletePendingCounterVerification(e) {
    this.pendingCounterVerifications.delete(e);
  }
  async consumePendingCounterVerification(e, n, t) {
    const o = this.pendingCounterVerifications.get(e);
    return o === void 0 ? "missing" : Date.parse(o.expiresAt) <= Date.parse(t) ? (this.pendingCounterVerifications.delete(e), "expired") : o.counterpartyDid !== n ? "wrong-counterparty" : (this.pendingCounterVerifications.delete(e), "consumed");
  }
  async prunePendingCounterVerifications(e) {
    const n = Date.parse(e);
    for (const [t, o] of this.pendingCounterVerifications)
      Date.parse(o.expiresAt) <= n && this.pendingCounterVerifications.delete(t);
  }
  async clear() {
    this.consumedNonces.clear(), this.pendingCounterVerifications.clear();
  }
}
export {
  g as AutomergeOutboxStore,
  f as HttpDiscoveryAdapter,
  m as InMemoryAuthorizationAdapter,
  y as InMemoryCompactStore,
  C as InMemoryGraphCacheStore,
  h as InMemoryMessagingAdapter,
  l as InMemoryOutboxStore,
  S as InMemoryPublishStateStore,
  V as InMemorySpaceMetadataStorage,
  d as InMemoryVerificationStateStore,
  M as IndexedDBSpaceMetadataStorage,
  A as LocalStorageAdapter,
  N as OfflineFirstDiscoveryAdapter,
  D as OutboxMessagingAdapter,
  x as PersonalDocOutboxStore,
  I as PersonalDocSpaceMetadataStorage,
  P as SeedStorageIdentityVault,
  b as TracedOutboxMessagingAdapter,
  w as WebCryptoAdapter,
  O as WebSocketMessagingAdapter
};
