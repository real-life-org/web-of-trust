const l = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function y(e) {
  const r = [0];
  for (const n of e) {
    let o = n;
    for (let s = 0; s < r.length; s++)
      o += r[s] << 8, r[s] = o % 58, o = o / 58 | 0;
    for (; o > 0; )
      r.push(o % 58), o = o / 58 | 0;
  }
  let t = "";
  for (const n of e)
    if (n === 0) t += l[0];
    else break;
  for (let n = r.length - 1; n >= 0; n--) t += l[r[n]];
  return t;
}
function R(e) {
  const r = [0];
  for (const t of e) {
    const n = l.indexOf(t);
    if (n < 0) throw new Error(`Invalid base58 character: ${t}`);
    let o = n;
    for (let s = 0; s < r.length; s++)
      o += r[s] * 58, r[s] = o & 255, o >>= 8;
    for (; o > 0; )
      r.push(o & 255), o >>= 8;
  }
  for (const t of e)
    if (t === l[0]) r.push(0);
    else break;
  return new Uint8Array(r.reverse());
}
function L(e) {
  let r = "";
  for (let t = 0; t < e.length; t++) r += String.fromCharCode(e[t]);
  return btoa(r).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function v(e) {
  const r = e.replace(/-/g, "+").replace(/_/g, "/"), t = r + "=".repeat((4 - r.length % 4) % 4), n = atob(t);
  return Uint8Array.from(n, (o) => o.charCodeAt(0));
}
const c = new Uint8Array([237, 1]), a = new Uint8Array([236, 1]), d = 32;
class i extends Error {
  constructor(r) {
    super(r), this.name = "DidKeyValidationError";
  }
}
function S(e) {
  return `did:key:${h(e)}`;
}
function h(e) {
  u(e, "Ed25519");
  const r = new Uint8Array(c.length + e.length);
  return r.set(c), r.set(e, c.length), `z${y(r)}`;
}
function x(e) {
  u(e, "X25519");
  const r = new Uint8Array(a.length + e.length);
  return r.set(a), r.set(e, a.length), `z${y(r)}`;
}
function I(e) {
  return e.split("#", 1)[0];
}
function _(e) {
  const r = I(e);
  if (!r.startsWith("did:key:z")) throw new i("Expected did:key");
  return A(`z${r.slice(9)}`);
}
function A(e) {
  const r = w(e);
  if (r[0] !== c[0] || r[1] !== c[1])
    throw new i("Expected Ed25519 multibase key");
  const t = r.slice(c.length);
  return u(t, "Ed25519"), t;
}
function M(e) {
  const r = w(e);
  if (r[0] !== a[0] || r[1] !== a[1])
    throw new i("Expected X25519 multibase key");
  const t = r.slice(a.length);
  return u(t, "X25519"), t;
}
function O(e, r = {}) {
  K(e);
  const t = h(_(e)), n = b(r.keyAgreement) ?? [], o = p(r.service), s = {
    id: e,
    verificationMethod: [
      {
        id: "#sig-0",
        type: "Ed25519VerificationKey2020",
        controller: e,
        publicKeyMultibase: t
      }
    ],
    authentication: ["#sig-0"],
    assertionMethod: ["#sig-0"],
    keyAgreement: n
  };
  return o && (s.service = o), s;
}
function U(e = {}) {
  const r = D(e);
  return {
    async resolve(t) {
      if (!t.startsWith("did:key:")) return null;
      try {
        return O(t, C(r, t));
      } catch (n) {
        if (!(n instanceof i)) throw n;
        return null;
      }
    }
  };
}
function D(e) {
  const r = /* @__PURE__ */ Object.create(null);
  for (const [t, n] of Object.entries(e))
    n && (r[t] = T(n));
  return r;
}
function C(e, r) {
  return Object.prototype.hasOwnProperty.call(e, r) ? e[r] : void 0;
}
function T(e) {
  const r = {}, t = b(e.keyAgreement), n = p(e.service);
  return t && (r.keyAgreement = t), n && (r.service = n), r;
}
function b(e) {
  return e == null ? void 0 : e.map((r) => ({ ...r }));
}
function p(e) {
  if (!(!e || e.length === 0))
    return e == null ? void 0 : e.map((r) => ({ ...r }));
}
function K(e) {
  if (e.includes("#")) throw new i("Expected bare DID without fragment");
  if (!e.startsWith("did:key:z")) throw new i("Expected did:key");
}
function u(e, r) {
  if (e.length !== d)
    throw new i(`Expected ${d}-byte ${r} public key`);
}
function w(e) {
  if (!e.startsWith("z")) throw new i("Expected base58btc multibase key");
  try {
    return R(e.slice(1));
  } catch (r) {
    throw new i(r instanceof Error ? r.message : String(r));
  }
}
const k = Object.freeze([
  "DOC_NOT_FOUND",
  "CAPABILITY_INVALID",
  "CAPABILITY_EXPIRED",
  "CAPABILITY_GENERATION_STALE",
  "DEVICE_NOT_REGISTERED",
  "DEVICE_REVOKED",
  "DEVICE_ID_CONFLICT",
  "SEQ_COLLISION_DETECTED",
  "MALFORMED_MESSAGE",
  "AUTH_INVALID",
  "NONCE_REPLAY",
  "RATE_LIMITED",
  "INTERNAL_ERROR"
]), f = {
  restoreCloneRecovery: "restore-clone-recovery",
  requestFreshCapabilityViaPeerContact: "request-fresh-capability-via-peer-contact",
  noNormativeAction: "no-normative-action"
}, B = new Set(k);
function N(e) {
  return typeof e == "string" && B.has(e);
}
function g(e) {
  if (!N(e))
    throw new Error("Unknown wot-sync@0.1 broker error code");
}
function V(e) {
  const r = m(e, "broker error body");
  return E(r, "code", "broker error code"), E(r, "message", "broker error message"), g(r.code), P(r.message), { ...r };
}
function $(e) {
  return g(e), e === "SEQ_COLLISION_DETECTED" ? f.restoreCloneRecovery : e === "CAPABILITY_EXPIRED" ? f.requestFreshCapabilityViaPeerContact : f.noNormativeAction;
}
function m(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function E(e, r, t) {
  if (!Object.prototype.hasOwnProperty.call(e, r)) throw new Error(`Invalid ${t}`);
}
function P(e) {
  if (typeof e != "string" || e.trim().length === 0)
    throw new Error("Invalid broker error message");
}
export {
  f as B,
  k as K,
  _ as a,
  I as b,
  A as c,
  v as d,
  L as e,
  h as f,
  V as g,
  g as h,
  $ as i,
  U as j,
  R as k,
  y as l,
  N as m,
  M as n,
  S as p,
  O as r,
  x
};
