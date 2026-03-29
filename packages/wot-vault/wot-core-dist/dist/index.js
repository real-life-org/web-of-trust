var Ct = Object.defineProperty;
var zt = (s, e, t) => e in s ? Ct(s, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : s[e] = t;
var c = (s, e, t) => zt(s, typeof e != "symbol" ? e + "" : e, t);
import { openDB as tt } from "idb";
import { NetworkAdapter as Pt, Repo as Bt, parseAutomergeUrl as Ot } from "@automerge/automerge-repo";
const Rt = /* @__PURE__ */ new Set([
  "attestation",
  "verification",
  "contact",
  "space",
  "item"
]);
function dn(s, e, t) {
  return t ? `wot:${s}:${e}/${t}` : `wot:${s}:${e}`;
}
function hn(s) {
  if (!s.startsWith("wot:"))
    throw new Error(`Invalid ResourceRef: must start with "wot:" — got "${s}"`);
  const e = s.slice(4), t = e.indexOf(":");
  if (t === -1)
    throw new Error(`Invalid ResourceRef: missing type — got "${s}"`);
  const r = e.slice(0, t);
  if (!Rt.has(r))
    throw new Error(`Invalid ResourceRef: unknown type "${r}" — got "${s}"`);
  const n = e.slice(t + 1);
  if (!n)
    throw new Error(`Invalid ResourceRef: missing id — got "${s}"`);
  const i = n.indexOf("/");
  if (i === -1)
    return { type: r, id: n };
  const a = n.slice(0, i), o = n.slice(i + 1);
  return { type: r, id: a, subPath: o };
}
function fn(s) {
  return {
    getValue: () => s.getValue(),
    subscribe: (e) => {
      let t = !0;
      return s.subscribe((r) => {
        if (t) {
          t = !1;
          return;
        }
        e(r);
      });
    }
  };
}
const ye = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function Nt(s) {
  const e = [0];
  for (const r of s) {
    let n = r;
    for (let i = 0; i < e.length; i++)
      n += e[i] << 8, e[i] = n % 58, n = n / 58 | 0;
    for (; n > 0; )
      e.push(n % 58), n = n / 58 | 0;
  }
  let t = "";
  for (const r of s)
    if (r === 0) t += ye[0];
    else break;
  for (let r = e.length - 1; r >= 0; r--)
    t += ye[e[r]];
  return t;
}
function _t(s) {
  const e = [0];
  for (const t of s) {
    const r = ye.indexOf(t);
    if (r < 0) throw new Error(`Invalid base58 character: ${t}`);
    let n = r;
    for (let i = 0; i < e.length; i++)
      n += e[i] * 58, e[i] = n & 255, n >>= 8;
    for (; n > 0; )
      e.push(n & 255), n >>= 8;
  }
  for (const t of s)
    if (t === ye[0]) e.push(0);
    else break;
  return new Uint8Array(e.reverse());
}
function L(s) {
  let e = "";
  for (let t = 0; t < s.length; t++)
    e += String.fromCharCode(s[t]);
  return btoa(e).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function G(s) {
  const e = s.replace(/-/g, "+").replace(/_/g, "/"), t = (4 - e.length % 4) % 4, r = e + "=".repeat(t), n = atob(r);
  return Uint8Array.from(n, (i) => i.charCodeAt(0));
}
const Z = new Uint8Array([237, 1]);
function Ht(s) {
  const e = new Uint8Array(Z.length + s.length);
  return e.set(Z), e.set(s, Z.length), `did:key:${"z" + Nt(e)}`;
}
function Ke(s) {
  if (!s.startsWith("did:key:z"))
    throw new Error("Invalid did:key format");
  const e = s.slice(9), t = _t(e);
  if (t[0] !== Z[0] || t[1] !== Z[1])
    throw new Error("Invalid multicodec prefix for Ed25519");
  return t.slice(Z.length);
}
function pn(s) {
  try {
    return s.startsWith("did:key:z") ? (Ke(s), !0) : !1;
  } catch {
    return !1;
  }
}
function yn(s) {
  return s ? `User-${s.slice(-6)}` : "User";
}
function $t(s) {
  return s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength);
}
async function jt(s, e) {
  const t = {
    alg: "EdDSA",
    typ: "JWT"
  }, r = L(
    new TextEncoder().encode(JSON.stringify(t))
  ), n = L(
    new TextEncoder().encode(JSON.stringify(s))
  ), i = `${r}.${n}`, a = new TextEncoder().encode(i), o = await crypto.subtle.sign(
    "Ed25519",
    e,
    a
  ), l = new Uint8Array(o), d = L(l);
  return `${i}.${d}`;
}
async function rt(s, e) {
  try {
    const t = s.split(".");
    if (t.length !== 3)
      return { valid: !1, error: "Invalid JWS format" };
    const [r, n, i] = t, a = G(r), o = JSON.parse(new TextDecoder().decode(a));
    if (o.alg !== "EdDSA")
      return { valid: !1, error: `Unsupported algorithm: ${o.alg}` };
    const l = G(n), d = JSON.parse(new TextDecoder().decode(l)), f = G(i), u = `${r}.${n}`, h = new TextEncoder().encode(u);
    return { valid: await crypto.subtle.verify(
      "Ed25519",
      e,
      $t(f),
      h
    ), payload: d };
  } catch (t) {
    return {
      valid: !1,
      error: t instanceof Error ? t.message : "Verification failed"
    };
  }
}
function _e(s) {
  try {
    const e = s.split(".");
    if (e.length !== 3) return null;
    const t = G(e[1]);
    return JSON.parse(new TextDecoder().decode(t));
  } catch {
    return null;
  }
}
async function Lt(s, e) {
  const t = {
    id: crypto.randomUUID(),
    issuer: s.issuer,
    audience: s.audience,
    resource: s.resource,
    permissions: [...s.permissions].sort(),
    expiration: s.expiration
  };
  return e(t);
}
async function nt(s, e) {
  const t = e ?? /* @__PURE__ */ new Date(), r = _e(s);
  if (!r || typeof r != "object")
    return { valid: !1, error: "Invalid capability: cannot extract payload" };
  const n = r, i = Ft(n);
  if (i)
    return { valid: !1, error: i };
  const a = new Date(n.expiration);
  if (isNaN(a.getTime()))
    return { valid: !1, error: "Invalid expiration date" };
  if (t >= a)
    return { valid: !1, error: "Capability has expired" };
  let o;
  try {
    const f = Ke(n.issuer);
    o = await crypto.subtle.importKey(
      "raw",
      f,
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  } catch {
    return { valid: !1, error: `Cannot resolve issuer DID: ${n.issuer}` };
  }
  const l = await rt(s, o);
  if (!l.valid)
    return { valid: !1, error: `Invalid signature: ${l.error}` };
  const d = [];
  if (n.proof) {
    const f = await nt(n.proof, e);
    if (!f.valid)
      return { valid: !1, error: `Invalid delegation chain: ${f.error}` };
    const u = f.capability;
    if (u.audience !== n.issuer)
      return {
        valid: !1,
        error: `Delegation chain broken: parent audience (${u.audience}) !== child issuer (${n.issuer})`
      };
    if (u.resource !== n.resource)
      return {
        valid: !1,
        error: `Delegation resource mismatch: parent (${u.resource}) !== child (${n.resource})`
      };
    const h = new Set(u.permissions);
    for (const b of n.permissions)
      if (!h.has(b))
        return {
          valid: !1,
          error: `Permission escalation: "${b}" not in parent permissions [${u.permissions.join(", ")}]`
        };
    const y = new Date(u.expiration);
    if (a > y)
      return {
        valid: !1,
        error: "Delegated capability expires after parent"
      };
    if (!u.permissions.includes("delegate"))
      return {
        valid: !1,
        error: 'Parent capability does not include "delegate" permission'
      };
    d.push(...f.chain, u);
  }
  return { valid: !0, capability: n, chain: d };
}
function se(s) {
  const e = _e(s);
  return !e || typeof e != "object" ? null : e;
}
async function Gt(s, e, t) {
  const r = se(s);
  if (!r)
    throw new Error("Invalid parent capability");
  if (!r.permissions.includes("delegate"))
    throw new Error('Parent capability does not include "delegate" permission');
  const n = new Set(r.permissions);
  for (const l of e.permissions)
    if (!n.has(l))
      throw new Error(`Cannot delegate permission "${l}" — not in parent [${r.permissions.join(", ")}]`);
  const i = new Date(r.expiration);
  if (new Date(e.expiration) > i)
    throw new Error("Delegated capability cannot expire after parent");
  const o = {
    id: crypto.randomUUID(),
    issuer: r.audience,
    // Delegator is the audience of the parent
    audience: e.audience,
    resource: r.resource,
    permissions: [...e.permissions].sort(),
    expiration: e.expiration,
    proof: s
  };
  return t(o);
}
function Ft(s) {
  if (!s.id) return "Missing field: id";
  if (!s.issuer) return "Missing field: issuer";
  if (!s.audience) return "Missing field: audience";
  if (!s.resource) return "Missing field: resource";
  if (!s.permissions || !Array.isArray(s.permissions) || s.permissions.length === 0)
    return "Missing or empty field: permissions";
  if (!s.expiration) return "Missing field: expiration";
  const e = /* @__PURE__ */ new Set(["read", "write", "delete", "delegate"]);
  for (const t of s.permissions)
    if (!e.has(t))
      return `Invalid permission: "${t}"`;
  return null;
}
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function Vt(s) {
  return s instanceof Uint8Array || ArrayBuffer.isView(s) && s.constructor.name === "Uint8Array";
}
function Y(s, e = "") {
  if (!Number.isSafeInteger(s) || s < 0) {
    const t = e && `"${e}" `;
    throw new Error(`${t}expected integer >= 0, got ${s}`);
  }
}
function Q(s, e, t = "") {
  const r = Vt(s), n = s == null ? void 0 : s.length, i = e !== void 0;
  if (!r || i && n !== e) {
    const a = t && `"${t}" `, o = i ? ` of length ${e}` : "", l = r ? `length=${n}` : `type=${typeof s}`;
    throw new Error(a + "expected Uint8Array" + o + ", got " + l);
  }
  return s;
}
function st(s) {
  if (typeof s != "function" || typeof s.create != "function")
    throw new Error("Hash must wrapped by utils.createHasher");
  Y(s.outputLen), Y(s.blockLen);
}
function be(s, e = !0) {
  if (s.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (e && s.finished)
    throw new Error("Hash#digest() has already been called");
}
function qt(s, e) {
  Q(s, void 0, "digestInto() output");
  const t = e.outputLen;
  if (s.length < t)
    throw new Error('"digestInto() output" expected to be of length >=' + t);
}
function V(...s) {
  for (let e = 0; e < s.length; e++)
    s[e].fill(0);
}
function fe(s) {
  return new DataView(s.buffer, s.byteOffset, s.byteLength);
}
function D(s, e) {
  return s << 32 - e | s >>> e;
}
function Jt(s) {
  if (typeof s != "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(s));
}
function je(s, e = "") {
  return typeof s == "string" ? Jt(s) : Q(s, void 0, e);
}
function Wt(s, e) {
  if (e !== void 0 && {}.toString.call(e) !== "[object Object]")
    throw new Error("options must be object or undefined");
  return Object.assign(s, e);
}
function it(s, e = {}) {
  const t = (n, i) => s(i).update(n).digest(), r = s(void 0);
  return t.outputLen = r.outputLen, t.blockLen = r.blockLen, t.create = (n) => s(n), Object.assign(t, e), Object.freeze(t);
}
function Xt(s = 32) {
  const e = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof (e == null ? void 0 : e.getRandomValues) != "function")
    throw new Error("crypto.getRandomValues must be defined");
  return e.getRandomValues(new Uint8Array(s));
}
const at = (s) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, s])
});
class ot {
  constructor(e, t) {
    c(this, "oHash");
    c(this, "iHash");
    c(this, "blockLen");
    c(this, "outputLen");
    c(this, "finished", !1);
    c(this, "destroyed", !1);
    if (st(e), Q(t, void 0, "key"), this.iHash = e.create(), typeof this.iHash.update != "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen, this.outputLen = this.iHash.outputLen;
    const r = this.blockLen, n = new Uint8Array(r);
    n.set(t.length > r ? e.create().update(t).digest() : t);
    for (let i = 0; i < n.length; i++)
      n[i] ^= 54;
    this.iHash.update(n), this.oHash = e.create();
    for (let i = 0; i < n.length; i++)
      n[i] ^= 106;
    this.oHash.update(n), V(n);
  }
  update(e) {
    return be(this), this.iHash.update(e), this;
  }
  digestInto(e) {
    be(this), Q(e, this.outputLen, "output"), this.finished = !0, this.iHash.digestInto(e), this.oHash.update(e), this.oHash.digestInto(e), this.destroy();
  }
  digest() {
    const e = new Uint8Array(this.oHash.outputLen);
    return this.digestInto(e), e;
  }
  _cloneInto(e) {
    e || (e = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash: t, iHash: r, finished: n, destroyed: i, blockLen: a, outputLen: o } = this;
    return e = e, e.finished = n, e.destroyed = i, e.blockLen = a, e.outputLen = o, e.oHash = t._cloneInto(e.oHash), e.iHash = r._cloneInto(e.iHash), e;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = !0, this.oHash.destroy(), this.iHash.destroy();
  }
}
const ct = (s, e, t) => new ot(s, e).update(t).digest();
ct.create = (s, e) => new ot(s, e);
function Zt(s, e, t, r) {
  st(s);
  const n = Wt({ dkLen: 32, asyncTick: 10 }, r), { c: i, dkLen: a, asyncTick: o } = n;
  if (Y(i, "c"), Y(a, "dkLen"), Y(o, "asyncTick"), i < 1)
    throw new Error("iterations (c) must be >= 1");
  const l = je(e, "password"), d = je(t, "salt"), f = new Uint8Array(a), u = ct.create(s, l), h = u._cloneInto().update(d);
  return { c: i, dkLen: a, asyncTick: o, DK: f, PRF: u, PRFSalt: h };
}
function Yt(s, e, t, r, n) {
  return s.destroy(), e.destroy(), r && r.destroy(), V(n), t;
}
function Qt(s, e, t, r) {
  const { c: n, dkLen: i, DK: a, PRF: o, PRFSalt: l } = Zt(s, e, t, r);
  let d;
  const f = new Uint8Array(4), u = fe(f), h = new Uint8Array(o.outputLen);
  for (let y = 1, b = 0; b < i; y++, b += o.outputLen) {
    const m = a.subarray(b, b + o.outputLen);
    u.setInt32(0, y, !1), (d = l._cloneInto(d)).update(f).digestInto(h), m.set(h.subarray(0, m.length));
    for (let k = 1; k < n; k++) {
      o._cloneInto(d).update(h).digestInto(h);
      for (let E = 0; E < m.length; E++)
        m[E] ^= h[E];
    }
  }
  return Yt(o, l, a, d, h);
}
function er(s, e, t) {
  return s & e ^ ~s & t;
}
function tr(s, e, t) {
  return s & e ^ s & t ^ e & t;
}
class lt {
  constructor(e, t, r, n) {
    c(this, "blockLen");
    c(this, "outputLen");
    c(this, "padOffset");
    c(this, "isLE");
    // For partial updates less than block size
    c(this, "buffer");
    c(this, "view");
    c(this, "finished", !1);
    c(this, "length", 0);
    c(this, "pos", 0);
    c(this, "destroyed", !1);
    this.blockLen = e, this.outputLen = t, this.padOffset = r, this.isLE = n, this.buffer = new Uint8Array(e), this.view = fe(this.buffer);
  }
  update(e) {
    be(this), Q(e);
    const { view: t, buffer: r, blockLen: n } = this, i = e.length;
    for (let a = 0; a < i; ) {
      const o = Math.min(n - this.pos, i - a);
      if (o === n) {
        const l = fe(e);
        for (; n <= i - a; a += n)
          this.process(l, a);
        continue;
      }
      r.set(e.subarray(a, a + o), this.pos), this.pos += o, a += o, this.pos === n && (this.process(t, 0), this.pos = 0);
    }
    return this.length += e.length, this.roundClean(), this;
  }
  digestInto(e) {
    be(this), qt(e, this), this.finished = !0;
    const { buffer: t, view: r, blockLen: n, isLE: i } = this;
    let { pos: a } = this;
    t[a++] = 128, V(this.buffer.subarray(a)), this.padOffset > n - a && (this.process(r, 0), a = 0);
    for (let u = a; u < n; u++)
      t[u] = 0;
    r.setBigUint64(n - 8, BigInt(this.length * 8), i), this.process(r, 0);
    const o = fe(e), l = this.outputLen;
    if (l % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const d = l / 4, f = this.get();
    if (d > f.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let u = 0; u < d; u++)
      o.setUint32(4 * u, f[u], i);
  }
  digest() {
    const { buffer: e, outputLen: t } = this;
    this.digestInto(e);
    const r = e.slice(0, t);
    return this.destroy(), r;
  }
  _cloneInto(e) {
    e || (e = new this.constructor()), e.set(...this.get());
    const { blockLen: t, buffer: r, length: n, finished: i, destroyed: a, pos: o } = this;
    return e.destroyed = a, e.finished = i, e.length = n, e.pos = o, n % t && e.buffer.set(r), e;
  }
  clone() {
    return this._cloneInto();
  }
}
const R = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), x = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]), le = /* @__PURE__ */ BigInt(2 ** 32 - 1), Le = /* @__PURE__ */ BigInt(32);
function rr(s, e = !1) {
  return e ? { h: Number(s & le), l: Number(s >> Le & le) } : { h: Number(s >> Le & le) | 0, l: Number(s & le) | 0 };
}
function nr(s, e = !1) {
  const t = s.length;
  let r = new Uint32Array(t), n = new Uint32Array(t);
  for (let i = 0; i < t; i++) {
    const { h: a, l: o } = rr(s[i], e);
    [r[i], n[i]] = [a, o];
  }
  return [r, n];
}
const Ge = (s, e, t) => s >>> t, Fe = (s, e, t) => s << 32 - t | e >>> t, J = (s, e, t) => s >>> t | e << 32 - t, W = (s, e, t) => s << 32 - t | e >>> t, ue = (s, e, t) => s << 64 - t | e >>> t - 32, de = (s, e, t) => s >>> t - 32 | e << 64 - t;
function P(s, e, t, r) {
  const n = (e >>> 0) + (r >>> 0);
  return { h: s + t + (n / 2 ** 32 | 0) | 0, l: n | 0 };
}
const sr = (s, e, t) => (s >>> 0) + (e >>> 0) + (t >>> 0), ir = (s, e, t, r) => e + t + r + (s / 2 ** 32 | 0) | 0, ar = (s, e, t, r) => (s >>> 0) + (e >>> 0) + (t >>> 0) + (r >>> 0), or = (s, e, t, r, n) => e + t + r + n + (s / 2 ** 32 | 0) | 0, cr = (s, e, t, r, n) => (s >>> 0) + (e >>> 0) + (t >>> 0) + (r >>> 0) + (n >>> 0), lr = (s, e, t, r, n, i) => e + t + r + n + i + (s / 2 ** 32 | 0) | 0, ur = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]), N = /* @__PURE__ */ new Uint32Array(64);
class dr extends lt {
  constructor(e) {
    super(64, e, 8, !1);
  }
  get() {
    const { A: e, B: t, C: r, D: n, E: i, F: a, G: o, H: l } = this;
    return [e, t, r, n, i, a, o, l];
  }
  // prettier-ignore
  set(e, t, r, n, i, a, o, l) {
    this.A = e | 0, this.B = t | 0, this.C = r | 0, this.D = n | 0, this.E = i | 0, this.F = a | 0, this.G = o | 0, this.H = l | 0;
  }
  process(e, t) {
    for (let u = 0; u < 16; u++, t += 4)
      N[u] = e.getUint32(t, !1);
    for (let u = 16; u < 64; u++) {
      const h = N[u - 15], y = N[u - 2], b = D(h, 7) ^ D(h, 18) ^ h >>> 3, m = D(y, 17) ^ D(y, 19) ^ y >>> 10;
      N[u] = m + N[u - 7] + b + N[u - 16] | 0;
    }
    let { A: r, B: n, C: i, D: a, E: o, F: l, G: d, H: f } = this;
    for (let u = 0; u < 64; u++) {
      const h = D(o, 6) ^ D(o, 11) ^ D(o, 25), y = f + h + er(o, l, d) + ur[u] + N[u] | 0, m = (D(r, 2) ^ D(r, 13) ^ D(r, 22)) + tr(r, n, i) | 0;
      f = d, d = l, l = o, o = a + y | 0, a = i, i = n, n = r, r = y + m | 0;
    }
    r = r + this.A | 0, n = n + this.B | 0, i = i + this.C | 0, a = a + this.D | 0, o = o + this.E | 0, l = l + this.F | 0, d = d + this.G | 0, f = f + this.H | 0, this.set(r, n, i, a, o, l, d, f);
  }
  roundClean() {
    V(N);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), V(this.buffer);
  }
}
class hr extends dr {
  constructor() {
    super(32);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    c(this, "A", R[0] | 0);
    c(this, "B", R[1] | 0);
    c(this, "C", R[2] | 0);
    c(this, "D", R[3] | 0);
    c(this, "E", R[4] | 0);
    c(this, "F", R[5] | 0);
    c(this, "G", R[6] | 0);
    c(this, "H", R[7] | 0);
  }
}
const ut = nr([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((s) => BigInt(s))), fr = ut[0], pr = ut[1], _ = /* @__PURE__ */ new Uint32Array(80), H = /* @__PURE__ */ new Uint32Array(80);
class yr extends lt {
  constructor(e) {
    super(128, e, 16, !1);
  }
  // prettier-ignore
  get() {
    const { Ah: e, Al: t, Bh: r, Bl: n, Ch: i, Cl: a, Dh: o, Dl: l, Eh: d, El: f, Fh: u, Fl: h, Gh: y, Gl: b, Hh: m, Hl: k } = this;
    return [e, t, r, n, i, a, o, l, d, f, u, h, y, b, m, k];
  }
  // prettier-ignore
  set(e, t, r, n, i, a, o, l, d, f, u, h, y, b, m, k) {
    this.Ah = e | 0, this.Al = t | 0, this.Bh = r | 0, this.Bl = n | 0, this.Ch = i | 0, this.Cl = a | 0, this.Dh = o | 0, this.Dl = l | 0, this.Eh = d | 0, this.El = f | 0, this.Fh = u | 0, this.Fl = h | 0, this.Gh = y | 0, this.Gl = b | 0, this.Hh = m | 0, this.Hl = k | 0;
  }
  process(e, t) {
    for (let g = 0; g < 16; g++, t += 4)
      _[g] = e.getUint32(t), H[g] = e.getUint32(t += 4);
    for (let g = 16; g < 80; g++) {
      const I = _[g - 15] | 0, U = H[g - 15] | 0, re = J(I, U, 1) ^ J(I, U, 8) ^ Ge(I, U, 7), ne = W(I, U, 1) ^ W(I, U, 8) ^ Fe(I, U, 7), C = _[g - 2] | 0, z = H[g - 2] | 0, oe = J(C, z, 19) ^ ue(C, z, 61) ^ Ge(C, z, 6), Ie = W(C, z, 19) ^ de(C, z, 61) ^ Fe(C, z, 6), ce = ar(ne, Ie, H[g - 7], H[g - 16]), Ue = or(ce, re, oe, _[g - 7], _[g - 16]);
      _[g] = Ue | 0, H[g] = ce | 0;
    }
    let { Ah: r, Al: n, Bh: i, Bl: a, Ch: o, Cl: l, Dh: d, Dl: f, Eh: u, El: h, Fh: y, Fl: b, Gh: m, Gl: k, Hh: E, Hl: O } = this;
    for (let g = 0; g < 80; g++) {
      const I = J(u, h, 14) ^ J(u, h, 18) ^ ue(u, h, 41), U = W(u, h, 14) ^ W(u, h, 18) ^ de(u, h, 41), re = u & y ^ ~u & m, ne = h & b ^ ~h & k, C = cr(O, U, ne, pr[g], H[g]), z = lr(C, E, I, re, fr[g], _[g]), oe = C | 0, Ie = J(r, n, 28) ^ ue(r, n, 34) ^ ue(r, n, 39), ce = W(r, n, 28) ^ de(r, n, 34) ^ de(r, n, 39), Ue = r & i ^ r & o ^ i & o, Tt = n & a ^ n & l ^ a & l;
      E = m | 0, O = k | 0, m = y | 0, k = b | 0, y = u | 0, b = h | 0, { h: u, l: h } = P(d | 0, f | 0, z | 0, oe | 0), d = o | 0, f = l | 0, o = i | 0, l = a | 0, i = r | 0, a = n | 0;
      const $e = sr(oe, ce, Tt);
      r = ir($e, z, Ie, Ue), n = $e | 0;
    }
    ({ h: r, l: n } = P(this.Ah | 0, this.Al | 0, r | 0, n | 0)), { h: i, l: a } = P(this.Bh | 0, this.Bl | 0, i | 0, a | 0), { h: o, l } = P(this.Ch | 0, this.Cl | 0, o | 0, l | 0), { h: d, l: f } = P(this.Dh | 0, this.Dl | 0, d | 0, f | 0), { h: u, l: h } = P(this.Eh | 0, this.El | 0, u | 0, h | 0), { h: y, l: b } = P(this.Fh | 0, this.Fl | 0, y | 0, b | 0), { h: m, l: k } = P(this.Gh | 0, this.Gl | 0, m | 0, k | 0), { h: E, l: O } = P(this.Hh | 0, this.Hl | 0, E | 0, O | 0), this.set(r, n, i, a, o, l, d, f, u, h, y, b, m, k, E, O);
  }
  roundClean() {
    V(_, H);
  }
  destroy() {
    V(this.buffer), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}
class br extends yr {
  constructor() {
    super(64);
    c(this, "Ah", x[0] | 0);
    c(this, "Al", x[1] | 0);
    c(this, "Bh", x[2] | 0);
    c(this, "Bl", x[3] | 0);
    c(this, "Ch", x[4] | 0);
    c(this, "Cl", x[5] | 0);
    c(this, "Dh", x[6] | 0);
    c(this, "Dl", x[7] | 0);
    c(this, "Eh", x[8] | 0);
    c(this, "El", x[9] | 0);
    c(this, "Fh", x[10] | 0);
    c(this, "Fl", x[11] | 0);
    c(this, "Gh", x[12] | 0);
    c(this, "Gl", x[13] | 0);
    c(this, "Hh", x[14] | 0);
    c(this, "Hl", x[15] | 0);
  }
}
const gr = /* @__PURE__ */ it(
  () => new hr(),
  /* @__PURE__ */ at(1)
), mr = /* @__PURE__ */ it(
  () => new br(),
  /* @__PURE__ */ at(3)
);
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function ge(s) {
  return s instanceof Uint8Array || ArrayBuffer.isView(s) && s.constructor.name === "Uint8Array";
}
function dt(s, e) {
  return Array.isArray(e) ? e.length === 0 ? !0 : s ? e.every((t) => typeof t == "string") : e.every((t) => Number.isSafeInteger(t)) : !1;
}
function wr(s) {
  if (typeof s != "function")
    throw new Error("function expected");
  return !0;
}
function me(s, e) {
  if (typeof e != "string")
    throw new Error(`${s}: string expected`);
  return !0;
}
function te(s) {
  if (!Number.isSafeInteger(s))
    throw new Error(`invalid integer: ${s}`);
}
function we(s) {
  if (!Array.isArray(s))
    throw new Error("array expected");
}
function ke(s, e) {
  if (!dt(!0, e))
    throw new Error(`${s}: array of strings expected`);
}
function ht(s, e) {
  if (!dt(!1, e))
    throw new Error(`${s}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function ft(...s) {
  const e = (i) => i, t = (i, a) => (o) => i(a(o)), r = s.map((i) => i.encode).reduceRight(t, e), n = s.map((i) => i.decode).reduce(t, e);
  return { encode: r, decode: n };
}
// @__NO_SIDE_EFFECTS__
function pt(s) {
  const e = typeof s == "string" ? s.split("") : s, t = e.length;
  ke("alphabet", e);
  const r = new Map(e.map((n, i) => [n, i]));
  return {
    encode: (n) => (we(n), n.map((i) => {
      if (!Number.isSafeInteger(i) || i < 0 || i >= t)
        throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${s}`);
      return e[i];
    })),
    decode: (n) => (we(n), n.map((i) => {
      me("alphabet.decode", i);
      const a = r.get(i);
      if (a === void 0)
        throw new Error(`Unknown letter: "${i}". Allowed: ${s}`);
      return a;
    }))
  };
}
// @__NO_SIDE_EFFECTS__
function yt(s = "") {
  return me("join", s), {
    encode: (e) => (ke("join.decode", e), e.join(s)),
    decode: (e) => (me("join.decode", e), e.split(s))
  };
}
// @__NO_SIDE_EFFECTS__
function kr(s, e = "=") {
  return te(s), me("padding", e), {
    encode(t) {
      for (ke("padding.encode", t); t.length * s % 8; )
        t.push(e);
      return t;
    },
    decode(t) {
      ke("padding.decode", t);
      let r = t.length;
      if (r * s % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (; r > 0 && t[r - 1] === e; r--)
        if ((r - 1) * s % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      return t.slice(0, r);
    }
  };
}
function Pe(s, e, t) {
  if (e < 2)
    throw new Error(`convertRadix: invalid from=${e}, base cannot be less than 2`);
  if (t < 2)
    throw new Error(`convertRadix: invalid to=${t}, base cannot be less than 2`);
  if (we(s), !s.length)
    return [];
  let r = 0;
  const n = [], i = Array.from(s, (o) => {
    if (te(o), o < 0 || o >= e)
      throw new Error(`invalid integer: ${o}`);
    return o;
  }), a = i.length;
  for (; ; ) {
    let o = 0, l = !0;
    for (let d = r; d < a; d++) {
      const f = i[d], u = e * o, h = u + f;
      if (!Number.isSafeInteger(h) || u / e !== o || h - f !== u)
        throw new Error("convertRadix: carry overflow");
      const y = h / t;
      o = h % t;
      const b = Math.floor(y);
      if (i[d] = b, !Number.isSafeInteger(b) || b * t + o !== h)
        throw new Error("convertRadix: carry overflow");
      if (l)
        b ? l = !1 : r = d;
      else continue;
    }
    if (n.push(o), l)
      break;
  }
  for (let o = 0; o < s.length - 1 && s[o] === 0; o++)
    n.push(0);
  return n.reverse();
}
const bt = (s, e) => e === 0 ? s : bt(e, s % e), Se = /* @__NO_SIDE_EFFECTS__ */ (s, e) => s + (e - bt(s, e)), De = /* @__PURE__ */ (() => {
  let s = [];
  for (let e = 0; e < 40; e++)
    s.push(2 ** e);
  return s;
})();
function Be(s, e, t, r) {
  if (we(s), e <= 0 || e > 32)
    throw new Error(`convertRadix2: wrong from=${e}`);
  if (t <= 0 || t > 32)
    throw new Error(`convertRadix2: wrong to=${t}`);
  if (/* @__PURE__ */ Se(e, t) > 32)
    throw new Error(`convertRadix2: carry overflow from=${e} to=${t} carryBits=${/* @__PURE__ */ Se(e, t)}`);
  let n = 0, i = 0;
  const a = De[e], o = De[t] - 1, l = [];
  for (const d of s) {
    if (te(d), d >= a)
      throw new Error(`convertRadix2: invalid data word=${d} from=${e}`);
    if (n = n << e | d, i + e > 32)
      throw new Error(`convertRadix2: carry overflow pos=${i} from=${e}`);
    for (i += e; i >= t; i -= t)
      l.push((n >> i - t & o) >>> 0);
    const f = De[i];
    if (f === void 0)
      throw new Error("invalid carry");
    n &= f - 1;
  }
  if (n = n << t - i & o, !r && i >= e)
    throw new Error("Excess padding");
  if (!r && n > 0)
    throw new Error(`Non-zero padding: ${n}`);
  return r && i > 0 && l.push(n >>> 0), l;
}
// @__NO_SIDE_EFFECTS__
function gt(s) {
  te(s);
  const e = 2 ** 8;
  return {
    encode: (t) => {
      if (!ge(t))
        throw new Error("radix.encode input should be Uint8Array");
      return Pe(Array.from(t), e, s);
    },
    decode: (t) => (ht("radix.decode", t), Uint8Array.from(Pe(t, s, e)))
  };
}
// @__NO_SIDE_EFFECTS__
function Sr(s, e = !1) {
  if (te(s), s <= 0 || s > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ Se(8, s) > 32 || /* @__PURE__ */ Se(s, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (t) => {
      if (!ge(t))
        throw new Error("radix2.encode input should be Uint8Array");
      return Be(Array.from(t), 8, s, !e);
    },
    decode: (t) => (ht("radix2.decode", t), Uint8Array.from(Be(t, s, 8, e)))
  };
}
function vr(s, e) {
  return te(s), wr(e), {
    encode(t) {
      if (!ge(t))
        throw new Error("checksum.encode: input should be Uint8Array");
      const r = e(t).slice(0, s), n = new Uint8Array(t.length + s);
      return n.set(t), n.set(r, t.length), n;
    },
    decode(t) {
      if (!ge(t))
        throw new Error("checksum.decode: input should be Uint8Array");
      const r = t.slice(0, -s), n = t.slice(-s), i = e(r).slice(0, s);
      for (let a = 0; a < s; a++)
        if (i[a] !== n[a])
          throw new Error("Invalid checksum");
      return r;
    }
  };
}
const he = {
  alphabet: pt,
  chain: ft,
  checksum: vr,
  convertRadix: Pe,
  convertRadix2: Be,
  radix: gt,
  radix2: Sr,
  join: yt,
  padding: kr
}, xr = /* @__NO_SIDE_EFFECTS__ */ (s) => /* @__PURE__ */ ft(/* @__PURE__ */ gt(58), /* @__PURE__ */ pt(s), /* @__PURE__ */ yt("")), Ar = /* @__PURE__ */ xr("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
const Er = (s) => s[0] === "あいこくしん";
function mt(s) {
  if (typeof s != "string")
    throw new TypeError("invalid mnemonic type: " + typeof s);
  return s.normalize("NFKD");
}
function wt(s) {
  const e = mt(s), t = e.split(" ");
  if (![12, 15, 18, 21, 24].includes(t.length))
    throw new Error("Invalid mnemonic");
  return { nfkd: e, words: t };
}
function kt(s) {
  if (Q(s), ![16, 20, 24, 28, 32].includes(s.length))
    throw new Error("invalid entropy length");
}
function Kr(s, e = 128) {
  if (Y(e), e % 32 !== 0 || e > 256)
    throw new TypeError("Invalid entropy");
  return Dr(Xt(e / 8), s);
}
const Ir = (s) => {
  const e = 8 - s.length / 4;
  return new Uint8Array([gr(s)[0] >> e << e]);
};
function St(s) {
  if (!Array.isArray(s) || s.length !== 2048 || typeof s[0] != "string")
    throw new Error("Wordlist: expected array of 2048 strings");
  return s.forEach((e) => {
    if (typeof e != "string")
      throw new Error("wordlist: non-string element: " + e);
  }), he.chain(he.checksum(1, Ir), he.radix2(11, !0), he.alphabet(s));
}
function Ur(s, e) {
  const { words: t } = wt(s), r = St(e).decode(t);
  return kt(r), r;
}
function Dr(s, e) {
  return kt(s), St(e).encode(s).join(Er(e) ? "　" : " ");
}
function Mr(s, e) {
  try {
    Ur(s, e);
  } catch {
    return !1;
  }
  return !0;
}
const Tr = (s) => mt("mnemonic" + s);
function Ve(s, e = "") {
  return Qt(mr, wt(s).nfkd, Tr(e), { c: 2048, dkLen: 64 });
}
/*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
const vt = {
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
}, { p: A, n: pe, Gx: qe, Gy: Je, a: Me, d: Te, h: Cr } = vt, ve = 32, xt = 64, zr = (...s) => {
  "captureStackTrace" in Error && typeof Error.captureStackTrace == "function" && Error.captureStackTrace(...s);
}, v = (s = "") => {
  const e = new Error(s);
  throw zr(e, v), e;
}, Pr = (s) => typeof s == "bigint", Br = (s) => typeof s == "string", Or = (s) => s instanceof Uint8Array || ArrayBuffer.isView(s) && s.constructor.name === "Uint8Array", ae = (s, e, t = "") => {
  const r = Or(s), n = s == null ? void 0 : s.length, i = e !== void 0;
  if (!r || i && n !== e) {
    const a = t && `"${t}" `, o = i ? ` of length ${e}` : "", l = r ? `length=${n}` : `type=${typeof s}`;
    v(a + "expected Uint8Array" + o + ", got " + l);
  }
  return s;
}, He = (s) => new Uint8Array(s), At = (s) => Uint8Array.from(s), Et = (s, e) => s.toString(16).padStart(e, "0"), Kt = (s) => Array.from(ae(s)).map((e) => Et(e, 2)).join(""), B = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 }, We = (s) => {
  if (s >= B._0 && s <= B._9)
    return s - B._0;
  if (s >= B.A && s <= B.F)
    return s - (B.A - 10);
  if (s >= B.a && s <= B.f)
    return s - (B.a - 10);
}, It = (s) => {
  const e = "hex invalid";
  if (!Br(s))
    return v(e);
  const t = s.length, r = t / 2;
  if (t % 2)
    return v(e);
  const n = He(r);
  for (let i = 0, a = 0; i < r; i++, a += 2) {
    const o = We(s.charCodeAt(a)), l = We(s.charCodeAt(a + 1));
    if (o === void 0 || l === void 0)
      return v(e);
    n[i] = o * 16 + l;
  }
  return n;
}, Rr = () => globalThis == null ? void 0 : globalThis.crypto, Nr = () => {
  var s;
  return ((s = Rr()) == null ? void 0 : s.subtle) ?? v("crypto.subtle must be defined, consider polyfill");
}, Ut = (...s) => {
  const e = He(s.reduce((r, n) => r + ae(n).length, 0));
  let t = 0;
  return s.forEach((r) => {
    e.set(r, t), t += r.length;
  }), e;
}, xe = BigInt, F = (s, e, t, r = "bad number: out of range") => Pr(s) && e <= s && s < t ? s : v(r), p = (s, e = A) => {
  const t = s % e;
  return t >= 0n ? t : e + t;
}, _r = (s) => p(s, pe), Hr = (s, e) => {
  (s === 0n || e <= 0n) && v("no inverse n=" + s + " mod=" + e);
  let t = p(s, e), r = e, n = 0n, i = 1n;
  for (; t !== 0n; ) {
    const a = r / t, o = r % t, l = n - i * a;
    r = t, t = o, n = i, i = l;
  }
  return r === 1n ? p(n, e) : v("no inverse");
}, Ce = (s) => s instanceof q ? s : v("Point expected"), Oe = 2n ** 256n, T = class T {
  constructor(e, t, r, n) {
    c(this, "X");
    c(this, "Y");
    c(this, "Z");
    c(this, "T");
    const i = Oe;
    this.X = F(e, 0n, i), this.Y = F(t, 0n, i), this.Z = F(r, 1n, i), this.T = F(n, 0n, i), Object.freeze(this);
  }
  static CURVE() {
    return vt;
  }
  static fromAffine(e) {
    return new T(e.x, e.y, 1n, p(e.x * e.y));
  }
  /** RFC8032 5.1.3: Uint8Array to Point. */
  static fromBytes(e, t = !1) {
    const r = Te, n = At(ae(e, ve)), i = e[31];
    n[31] = i & -129;
    const a = Dt(n);
    F(a, 0n, t ? Oe : A);
    const l = p(a * a), d = p(l - 1n), f = p(r * l + 1n);
    let { isValid: u, value: h } = Lr(d, f);
    u || v("bad point: y not sqrt");
    const y = (h & 1n) === 1n, b = (i & 128) !== 0;
    return !t && h === 0n && b && v("bad point: x==0, isLastByteOdd"), b !== y && (h = p(-h)), new T(h, a, 1n, p(h * a));
  }
  static fromHex(e, t) {
    return T.fromBytes(It(e), t);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const e = Me, t = Te, r = this;
    if (r.is0())
      return v("bad point: ZERO");
    const { X: n, Y: i, Z: a, T: o } = r, l = p(n * n), d = p(i * i), f = p(a * a), u = p(f * f), h = p(l * e), y = p(f * p(h + d)), b = p(u + p(t * p(l * d)));
    if (y !== b)
      return v("bad point: equation left != right (1)");
    const m = p(n * i), k = p(a * o);
    return m !== k ? v("bad point: equation left != right (2)") : this;
  }
  /** Equality check: compare points P&Q. */
  equals(e) {
    const { X: t, Y: r, Z: n } = this, { X: i, Y: a, Z: o } = Ce(e), l = p(t * o), d = p(i * n), f = p(r * o), u = p(a * n);
    return l === d && f === u;
  }
  is0() {
    return this.equals(X);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new T(p(-this.X), this.Y, this.Z, p(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: e, Y: t, Z: r } = this, n = Me, i = p(e * e), a = p(t * t), o = p(2n * p(r * r)), l = p(n * i), d = e + t, f = p(p(d * d) - i - a), u = l + a, h = u - o, y = l - a, b = p(f * h), m = p(u * y), k = p(f * y), E = p(h * u);
    return new T(b, m, E, k);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(e) {
    const { X: t, Y: r, Z: n, T: i } = this, { X: a, Y: o, Z: l, T: d } = Ce(e), f = Me, u = Te, h = p(t * a), y = p(r * o), b = p(i * u * d), m = p(n * l), k = p((t + r) * (a + o) - h - y), E = p(m - b), O = p(m + b), g = p(y - f * h), I = p(k * E), U = p(O * g), re = p(k * g), ne = p(E * O);
    return new T(I, U, ne, re);
  }
  subtract(e) {
    return this.add(Ce(e).negate());
  }
  /**
   * Point-by-scalar multiplication. Scalar must be in range 1 <= n < CURVE.n.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n scalar by which point is multiplied
   * @param safe safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(e, t = !0) {
    if (!t && (e === 0n || this.is0()))
      return X;
    if (F(e, 1n, pe), e === 1n)
      return this;
    if (this.equals(ee))
      return Yr(e).p;
    let r = X, n = ee;
    for (let i = this; e > 0n; i = i.double(), e >>= 1n)
      e & 1n ? r = r.add(i) : t && (n = n.add(i));
    return r;
  }
  multiplyUnsafe(e) {
    return this.multiply(e, !1);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X: e, Y: t, Z: r } = this;
    if (this.equals(X))
      return { x: 0n, y: 1n };
    const n = Hr(r, A);
    p(r * n) !== 1n && v("invalid inverse");
    const i = p(e * n), a = p(t * n);
    return { x: i, y: a };
  }
  toBytes() {
    const { x: e, y: t } = this.assertValidity().toAffine(), r = $r(t);
    return r[31] |= e & 1n ? 128 : 0, r;
  }
  toHex() {
    return Kt(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(xe(Cr), !1);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let e = this.multiply(pe / 2n, !1).double();
    return pe % 2n && (e = e.add(this)), e.is0();
  }
};
c(T, "BASE"), c(T, "ZERO");
let q = T;
const ee = new q(qe, Je, 1n, p(qe * Je)), X = new q(0n, 1n, 1n, 0n);
q.BASE = ee;
q.ZERO = X;
const $r = (s) => It(Et(F(s, 0n, Oe), xt)).reverse(), Dt = (s) => xe("0x" + Kt(At(ae(s)).reverse())), M = (s, e) => {
  let t = s;
  for (; e-- > 0n; )
    t *= t, t %= A;
  return t;
}, jr = (s) => {
  const t = s * s % A * s % A, r = M(t, 2n) * t % A, n = M(r, 1n) * s % A, i = M(n, 5n) * n % A, a = M(i, 10n) * i % A, o = M(a, 20n) * a % A, l = M(o, 40n) * o % A, d = M(l, 80n) * l % A, f = M(d, 80n) * l % A, u = M(f, 10n) * i % A;
  return { pow_p_5_8: M(u, 2n) * s % A, b2: t };
}, Xe = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n, Lr = (s, e) => {
  const t = p(e * e * e), r = p(t * t * e), n = jr(s * r).pow_p_5_8;
  let i = p(s * t * n);
  const a = p(e * i * i), o = i, l = p(i * Xe), d = a === s, f = a === p(-s), u = a === p(-s * Xe);
  return d && (i = o), (f || u) && (i = l), (p(i) & 1n) === 1n && (i = p(-i)), { isValid: d || f, value: i };
}, Gr = (s) => _r(Dt(s)), Fr = (...s) => Wr.sha512Async(Ut(...s)), Vr = (s) => {
  const e = s.slice(0, ve);
  e[0] &= 248, e[31] &= 127, e[31] |= 64;
  const t = s.slice(ve, xt), r = Gr(e), n = ee.multiply(r), i = n.toBytes();
  return { head: e, prefix: t, scalar: r, point: n, pointBytes: i };
}, qr = (s) => Fr(ae(s, ve)).then(Vr), Jr = (s) => qr(s).then((e) => e.pointBytes), Wr = {
  sha512Async: async (s) => {
    const e = Nr(), t = Ut(s);
    return He(await e.digest("SHA-512", t.buffer));
  },
  sha512: void 0
}, Ae = 8, Xr = 256, Mt = Math.ceil(Xr / Ae) + 1, Re = 2 ** (Ae - 1), Zr = () => {
  const s = [];
  let e = ee, t = e;
  for (let r = 0; r < Mt; r++) {
    t = e, s.push(t);
    for (let n = 1; n < Re; n++)
      t = t.add(e), s.push(t);
    e = t.double();
  }
  return s;
};
let Ze;
const Ye = (s, e) => {
  const t = e.negate();
  return s ? t : e;
}, Yr = (s) => {
  const e = Ze || (Ze = Zr());
  let t = X, r = ee;
  const n = 2 ** Ae, i = n, a = xe(n - 1), o = xe(Ae);
  for (let l = 0; l < Mt; l++) {
    let d = Number(s & a);
    s >>= o, d > Re && (d -= i, s += 1n);
    const f = l * Re, u = f, h = f + Math.abs(d) - 1, y = l % 2 !== 0, b = d < 0;
    d === 0 ? r = r.add(Ye(y, e[u])) : t = t.add(Ye(b, e[h]));
  }
  return s !== 0n && v("invalid wnaf"), { p: t, f: r };
}, w = class w {
  constructor() {
    // 30 minutes
    c(this, "db", null);
  }
  /**
   * Initialize IndexedDB
   */
  async init() {
    return new Promise((e, t) => {
      const r = indexedDB.open(w.DB_NAME, 2);
      r.onerror = () => t(r.error), r.onsuccess = () => {
        this.db = r.result, e();
      }, r.onupgradeneeded = (n) => {
        const i = n.target.result;
        i.objectStoreNames.contains(w.STORE_NAME) || i.createObjectStore(w.STORE_NAME), i.objectStoreNames.contains(w.SESSION_STORE_NAME) || i.createObjectStore(w.SESSION_STORE_NAME);
      };
    });
  }
  /**
   * Store encrypted seed
   *
   * @param seed - Master seed (32 bytes)
   * @param passphrase - User's passphrase
   */
  async storeSeed(e, t) {
    this.db || await this.init();
    const r = crypto.getRandomValues(new Uint8Array(16)), n = await this.deriveEncryptionKey(t, r), i = crypto.getRandomValues(new Uint8Array(12)), a = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: i },
      n,
      e
    ), o = {
      ciphertext: this.arrayBufferToBase64Url(a),
      salt: this.arrayBufferToBase64Url(r.buffer),
      iv: this.arrayBufferToBase64Url(i.buffer)
    };
    return new Promise((l, d) => {
      const h = this.db.transaction([w.STORE_NAME], "readwrite").objectStore(w.STORE_NAME).put(o, "master-seed");
      h.onerror = () => d(h.error), h.onsuccess = () => l();
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
      const r = this.base64UrlToArrayBuffer(t.salt), n = await this.deriveEncryptionKey(e, new Uint8Array(r)), i = this.base64UrlToArrayBuffer(t.iv), a = this.base64UrlToArrayBuffer(t.ciphertext), o = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(i) },
        n,
        a
      );
      return await this.storeSessionKey(n), new Uint8Array(o);
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
      const r = this.base64UrlToArrayBuffer(t.iv), n = this.base64UrlToArrayBuffer(t.ciphertext), i = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(r) },
        e.key,
        n
      );
      return await this.storeSessionKey(e.key), new Uint8Array(i);
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
      const i = this.db.transaction([w.STORE_NAME], "readwrite").objectStore(w.STORE_NAME).delete("master-seed");
      i.onerror = () => t(i.error), i.onsuccess = () => e();
    });
  }
  /**
   * Clear the cached session key
   */
  async clearSessionKey() {
    return this.db || await this.init(), new Promise((e, t) => {
      const i = this.db.transaction([w.SESSION_STORE_NAME], "readwrite").objectStore(w.SESSION_STORE_NAME).delete("session-key");
      i.onerror = () => t(i.error), i.onsuccess = () => e();
    });
  }
  // Private methods
  async storeSessionKey(e, t = w.DEFAULT_SESSION_TTL) {
    const r = {
      key: e,
      expiresAt: Date.now() + t
    };
    return new Promise((n, i) => {
      const l = this.db.transaction([w.SESSION_STORE_NAME], "readwrite").objectStore(w.SESSION_STORE_NAME).put(r, "session-key");
      l.onerror = () => i(l.error), l.onsuccess = () => n();
    });
  }
  async getSessionEntry() {
    return new Promise((e, t) => {
      const i = this.db.transaction([w.SESSION_STORE_NAME], "readonly").objectStore(w.SESSION_STORE_NAME).get("session-key");
      i.onerror = () => t(i.error), i.onsuccess = () => e(i.result || null);
    });
  }
  async getEncryptedSeed() {
    return new Promise((e, t) => {
      const i = this.db.transaction([w.STORE_NAME], "readonly").objectStore(w.STORE_NAME).get("master-seed");
      i.onerror = () => t(i.error), i.onsuccess = () => e(i.result || null);
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
        iterations: w.PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      r,
      { name: "AES-GCM", length: 256 },
      !1,
      // non-extractable
      ["encrypt", "decrypt"]
    );
  }
  // Utility methods
  arrayBufferToBase64Url(e) {
    const t = new Uint8Array(e);
    let r = "";
    for (let n = 0; n < t.length; n++)
      r += String.fromCharCode(t[n]);
    return btoa(r).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  base64UrlToArrayBuffer(e) {
    const t = atob(e.replace(/-/g, "+").replace(/_/g, "/")), r = new Uint8Array(t.length);
    for (let n = 0; n < t.length; n++)
      r[n] = t.charCodeAt(n);
    return r.buffer;
  }
};
c(w, "DB_NAME", "wot-identity"), c(w, "STORE_NAME", "seeds"), c(w, "SESSION_STORE_NAME", "session"), c(w, "PBKDF2_ITERATIONS", 1e5), c(w, "DEFAULT_SESSION_TTL", 1800 * 1e3);
let Ne = w;
const ie = [
  "abbau",
  "abbild",
  "abbruch",
  "abdruck",
  "abend",
  "abfall",
  "abflug",
  "abgas",
  "abgrund",
  "abitur",
  "abkommen",
  "ablauf",
  "ablehnen",
  "abluft",
  "abpfiff",
  "abreise",
  "abriss",
  "absage",
  "abschied",
  "abseits",
  "absicht",
  "absolut",
  "abstand",
  "absurd",
  "abteil",
  "abwarten",
  "abwehr",
  "abzug",
  "achse",
  "acht",
  "acker",
  "adapter",
  "ader",
  "adler",
  "adresse",
  "advent",
  "affe",
  "agent",
  "agieren",
  "ahnen",
  "ahnung",
  "ahorn",
  "akademie",
  "akkord",
  "akte",
  "aktie",
  "aktuell",
  "akustik",
  "akzent",
  "alarm",
  "albatros",
  "album",
  "alge",
  "alkohol",
  "allee",
  "allianz",
  "alltag",
  "alpen",
  "alptraum",
  "alter",
  "altglas",
  "altstadt",
  "alufolie",
  "amboss",
  "ameise",
  "ampel",
  "amsel",
  "amulett",
  "analyse",
  "ananas",
  "anbau",
  "anbieten",
  "anblick",
  "anfang",
  "anfrage",
  "angabe",
  "angel",
  "angriff",
  "angst",
  "anhand",
  "anheben",
  "anhieb",
  "anker",
  "anklage",
  "ankommt",
  "ankunft",
  "anlage",
  "anleiten",
  "anliegen",
  "anmelden",
  "annehmen",
  "annonce",
  "anomalie",
  "anpassen",
  "anregung",
  "anruf",
  "ansatz",
  "anschein",
  "ansehen",
  "ansicht",
  "anspruch",
  "anstalt",
  "anteil",
  "antik",
  "antrag",
  "antwort",
  "anwalt",
  "anwesen",
  "anwohner",
  "anzahl",
  "anzeige",
  "anzug",
  "apfel",
  "apotheke",
  "apparat",
  "appell",
  "applaus",
  "april",
  "aquarell",
  "arbeit",
  "archiv",
  "areal",
  "arena",
  "argument",
  "armband",
  "armut",
  "aroma",
  "arten",
  "artikel",
  "arzt",
  "asche",
  "aspekt",
  "asphalt",
  "atelier",
  "atem",
  "athlet",
  "atlas",
  "atom",
  "attacke",
  "auerhahn",
  "aufbau",
  "aufgabe",
  "auflage",
  "aufnahme",
  "aufruf",
  "aufstand",
  "auftrag",
  "aufwand",
  "aufzug",
  "auge",
  "august",
  "auktion",
  "aula",
  "ausbruch",
  "ausdruck",
  "ausflug",
  "ausgang",
  "auskunft",
  "ausnahme",
  "aussicht",
  "auswahl",
  "auszug",
  "autark",
  "auto",
  "avocado",
  "baby",
  "bach",
  "backen",
  "baden",
  "bagger",
  "bahn",
  "baldrian",
  "balkon",
  "ball",
  "balsam",
  "bambus",
  "banane",
  "band",
  "bank",
  "bargeld",
  "barsch",
  "bart",
  "basis",
  "bass",
  "basteln",
  "batterie",
  "bauch",
  "bauer",
  "bauland",
  "baum",
  "bauplan",
  "bausatz",
  "baut",
  "bauwagen",
  "bauzaun",
  "beachten",
  "beamte",
  "bebauung",
  "beben",
  "becher",
  "becken",
  "bedarf",
  "bedenken",
  "bedienen",
  "bedroht",
  "beenden",
  "beere",
  "befahren",
  "befehl",
  "befinden",
  "befragen",
  "befund",
  "begabt",
  "begeben",
  "beginn",
  "begonnen",
  "begriff",
  "behalten",
  "beide",
  "beifall",
  "beige",
  "beihilfe",
  "beil",
  "bein",
  "beirat",
  "beispiel",
  "beitrag",
  "bekannt",
  "bekennen",
  "beklagen",
  "bekommen",
  "belasten",
  "belegen",
  "beliebt",
  "belohnen",
  "bemerkt",
  "benannt",
  "benutzen",
  "benzin",
  "bequem",
  "beraten",
  "bereich",
  "berg",
  "bericht",
  "beruf",
  "bescheid",
  "besen",
  "besitz",
  "besorgen",
  "besser",
  "bestand",
  "besuch",
  "beton",
  "betrieb",
  "bett",
  "beule",
  "beute",
  "bewahren",
  "bewegen",
  "bewirken",
  "bewohner",
  "bezahlen",
  "bezirk",
  "bezog",
  "bezug",
  "biber",
  "bieder",
  "biene",
  "bier",
  "biest",
  "bieten",
  "bilanz",
  "bild",
  "billig",
  "binden",
  "binnen",
  "biologie",
  "biotonne",
  "birgt",
  "birke",
  "birne",
  "bitter",
  "blasen",
  "blatt",
  "blau",
  "blech",
  "blick",
  "blind",
  "blitz",
  "block",
  "blume",
  "blut",
  "boden",
  "bogen",
  "bohne",
  "bohren",
  "boje",
  "bolzen",
  "bombe",
  "bonus",
  "boot",
  "bord",
  "botanik",
  "bote",
  "boxen",
  "boxring",
  "boykott",
  "brachten",
  "brand",
  "braten",
  "braun",
  "brav",
  "brechen",
  "brei",
  "bremsen",
  "brennen",
  "brett",
  "brief",
  "brille",
  "bringen",
  "brisant",
  "brokkoli",
  "bronze",
  "brosche",
  "brot",
  "bruch",
  "bruder",
  "brunnen",
  "brust",
  "bube",
  "buch",
  "bude",
  "budget",
  "bunker",
  "bunt",
  "burg",
  "busch",
  "busfahrt",
  "bussard",
  "butter",
  "campen",
  "caravan",
  "chance",
  "chaos",
  "charme",
  "chat",
  "chemie",
  "chillen",
  "chlor",
  "chor",
  "chrom",
  "clever",
  "clown",
  "code",
  "computer",
  "couch",
  "creme",
  "dach",
  "damals",
  "dame",
  "damm",
  "dampf",
  "danken",
  "darm",
  "datei",
  "dattel",
  "datum",
  "dauer",
  "daumen",
  "deal",
  "debatte",
  "decke",
  "defekt",
  "defizit",
  "dehnen",
  "deich",
  "delfin",
  "delle",
  "denkmal",
  "depot",
  "design",
  "dessert",
  "detail",
  "detektiv",
  "deuten",
  "devise",
  "dezember",
  "diagnose",
  "dialog",
  "dichter",
  "dick",
  "dieb",
  "dienstag",
  "diesel",
  "digital",
  "diktat",
  "dilemma",
  "dill",
  "ding",
  "diplomat",
  "direktor",
  "dirigent",
  "diskette",
  "distel",
  "diverse",
  "docht",
  "doktor",
  "dokument",
  "dolch",
  "domizil",
  "donner",
  "doppelt",
  "dorf",
  "dorn",
  "dose",
  "dozent",
  "drache",
  "draht",
  "drama",
  "dreck",
  "drehbuch",
  "drei",
  "dringend",
  "drohne",
  "drossel",
  "drucker",
  "ducken",
  "duell",
  "duft",
  "dunkel",
  "dunst",
  "durst",
  "dusche",
  "dynamik",
  "ebbe",
  "ebene",
  "echo",
  "echse",
  "echt",
  "ecke",
  "efeu",
  "effekt",
  "egal",
  "ehefrau",
  "ehemann",
  "ehepaar",
  "ehre",
  "ehrgeiz",
  "ehrlich",
  "eichel",
  "eidechse",
  "eier",
  "eigentum",
  "eile",
  "eimer",
  "einblick",
  "eindruck",
  "einfach",
  "eingang",
  "einheit",
  "einigung",
  "einkauf",
  "einladen",
  "einmal",
  "einnahme",
  "einrad",
  "eins",
  "eintritt",
  "einzeln",
  "eisberg",
  "eisdecke",
  "eisen",
  "eistee",
  "eisvogel",
  "eiszeit",
  "elch",
  "elefant",
  "elegant",
  "element",
  "elend",
  "elite",
  "elle",
  "elster",
  "eltern",
  "empfang",
  "ende",
  "endlich",
  "energie",
  "engel",
  "engpass",
  "enkel",
  "enorm",
  "ensemble",
  "ente",
  "entgegen",
  "entlang",
  "entwurf",
  "entzogen",
  "epoche",
  "erbe",
  "erbracht",
  "erbse",
  "erdbeere",
  "erde",
  "erdgas",
  "erdnuss",
  "ereignis",
  "erfassen",
  "erfinden",
  "erfolg",
  "erfreuen",
  "ergebnis",
  "erhalten",
  "erheben",
  "erholung",
  "erinnern",
  "erkennen",
  "erlauben",
  "erlebnis",
  "erlitten",
  "erneut",
  "ernst",
  "ernte",
  "erobern",
  "erproben",
  "erregen",
  "ersatz",
  "ersetzen",
  "ersparen",
  "erteilen",
  "ertrag",
  "erwarten",
  "erwerben",
  "erwiesen",
  "erworben",
  "erzeugen",
  "erzielen",
  "esel",
  "essen",
  "essig",
  "esstisch",
  "etage",
  "etappe",
  "etat",
  "ethik",
  "etikett",
  "etliche",
  "eule",
  "euphorie",
  "event",
  "ewig",
  "exakt",
  "examen",
  "exil",
  "existenz",
  "exkurs",
  "experte",
  "export",
  "express",
  "extern",
  "extrem",
  "fabel",
  "fabrik",
  "fach",
  "fackel",
  "faden",
  "fahne",
  "fahrrad",
  "faktor",
  "falke",
  "fallen",
  "falsch",
  "falter",
  "familie",
  "fangen",
  "fans",
  "fantasie",
  "farbe",
  "farn",
  "fasching",
  "fass",
  "faultier",
  "fauna",
  "faust",
  "favorit",
  "faxen",
  "fazit",
  "februar",
  "fechten",
  "feder",
  "fegen",
  "fehler",
  "feier",
  "feile",
  "fein",
  "feld",
  "fell",
  "fels",
  "fenchel",
  "fenster",
  "ferien",
  "fern",
  "ferse",
  "fertig",
  "fest",
  "fett",
  "feucht",
  "feuer",
  "fichte",
  "fieber",
  "figur",
  "fiktion",
  "filiale",
  "film",
  "filter",
  "filz",
  "finale",
  "finden",
  "finger",
  "fink",
  "finster",
  "firma",
  "fisch",
  "flach",
  "flagge",
  "flamme",
  "flasche",
  "fleck",
  "fleisch",
  "flexibel",
  "fliege",
  "flink",
  "flocke",
  "floh",
  "flora",
  "flucht",
  "flugzeug",
  "flur",
  "fluss",
  "flut",
  "fokus",
  "folge",
  "folie",
  "fordern",
  "forelle",
  "formel",
  "forst",
  "foto",
  "foyer",
  "fracht",
  "frage",
  "fraktion",
  "frau",
  "frech",
  "freizeit",
  "fremd",
  "frequenz",
  "freund",
  "frieden",
  "friseur",
  "froh",
  "front",
  "frosch",
  "frucht",
  "frust",
  "fuchs",
  "fund",
  "funktion",
  "furcht",
  "fusion",
  "futter",
  "gabel",
  "galaxie",
  "galerie",
  "gang",
  "ganove",
  "gans",
  "ganz",
  "garage",
  "gardine",
  "garn",
  "garten",
  "gasse",
  "gast",
  "gattung",
  "gauner",
  "gazelle",
  "geben",
  "gebiet",
  "geboren",
  "gebracht",
  "geburt",
  "gecko",
  "gedanke",
  "gedicht",
  "geduld",
  "gefahr",
  "gefieder",
  "geflecht",
  "gegend",
  "gegner",
  "gehen",
  "gehirn",
  "geier",
  "geige",
  "geist",
  "geiz",
  "gelassen",
  "gelb",
  "geld",
  "gelee",
  "gelten",
  "gelungen",
  "gemacht",
  "gemein",
  "genau",
  "generell",
  "genie",
  "genug",
  "gepard",
  "gerade",
  "gerecht",
  "gericht",
  "gern",
  "gerste",
  "geruch",
  "gesamt",
  "geschenk",
  "gesetz",
  "gesicht",
  "gespenst",
  "gestalt",
  "gesund",
  "getan",
  "getreide",
  "gewalt",
  "gewerbe",
  "gewitter",
  "gewonnen",
  "giebel",
  "gier",
  "gift",
  "gigant",
  "gipfel",
  "gips",
  "giraffe",
  "girlande",
  "gitarre",
  "gitter",
  "glanz",
  "glas",
  "glatt",
  "glaube",
  "gleis",
  "glitzer",
  "globus",
  "glocke",
  "glut",
  "gnade",
  "gold",
  "golf",
  "gondel",
  "gorilla",
  "grab",
  "grad",
  "grafik",
  "gramm",
  "granit",
  "gras",
  "gratis",
  "grau",
  "gravur",
  "greifen",
  "gremium",
  "grenze",
  "griff",
  "grill",
  "grinsen",
  "groll",
  "grotte",
  "grube",
  "gruft",
  "grund",
  "gruppe",
  "gruselig",
  "gulasch",
  "gully",
  "gummi",
  "gunst",
  "gurke",
  "gurt",
  "guthaben",
  "haar",
  "habgier",
  "habicht",
  "hacken",
  "hafen",
  "haft",
  "hagel",
  "hahn",
  "haken",
  "halb",
  "halde",
  "halle",
  "halm",
  "hals",
  "halten",
  "hammer",
  "hamster",
  "hand",
  "hanger",
  "hantel",
  "harfe",
  "harke",
  "harmonie",
  "hart",
  "hase",
  "haube",
  "hauch",
  "haufen",
  "haus",
  "haut",
  "hebamme",
  "hebel",
  "hecht",
  "hecke",
  "hefe",
  "heft",
  "heilen",
  "heim",
  "heiraten",
  "heizung",
  "hektar",
  "held",
  "helfen",
  "hell",
  "helm",
  "hemd",
  "henkel",
  "herbst",
  "herd",
  "hering",
  "herkunft",
  "herr",
  "herz",
  "heute",
  "hilfe",
  "himbeere",
  "himmel",
  "hinblick",
  "hinsicht",
  "hinten",
  "hinweis",
  "hirse",
  "hirte",
  "hitze",
  "hobel",
  "hoch",
  "hoffen",
  "hohl",
  "holen",
  "holunder",
  "holz",
  "honig",
  "honorar",
  "hopfen",
  "horizont",
  "horn",
  "hose",
  "hotel",
  "hufeisen",
  "huhn",
  "hummer",
  "humor",
  "hund",
  "hunger",
  "hupe",
  "husten",
  "hydrant",
  "hygiene",
  "ideal",
  "idee",
  "idol",
  "idyll",
  "igel",
  "illegal",
  "illusion",
  "imbiss",
  "imker",
  "immun",
  "impfen",
  "import",
  "impuls",
  "index",
  "indiz",
  "infolge",
  "ingwer",
  "inhalt",
  "innen",
  "insasse",
  "insel",
  "institut",
  "internet",
  "investor",
  "irgendwo",
  "ironie",
  "irrtum",
  "isoliert",
  "jacht",
  "jacke",
  "jagd",
  "jagen",
  "jaguar",
  "jahr",
  "januar",
  "jargon",
  "jazz",
  "jemand",
  "joggen",
  "joghurt",
  "jubel",
  "jugend",
  "juli",
  "jung",
  "juni",
  "jurist",
  "jury",
  "justiz",
  "juwel",
  "kabarett",
  "kabel",
  "kabine",
  "kaffee",
  "kahl",
  "kajak",
  "kakao",
  "kaktus",
  "kalender",
  "kalt",
  "kamera",
  "kamin",
  "kamm",
  "kampf",
  "kanal",
  "kandidat",
  "kanister",
  "kanne",
  "kante",
  "kanu",
  "kapelle",
  "kapitel",
  "kapsel",
  "kaputt",
  "karneval",
  "karotte",
  "karriere",
  "karte",
  "kasse",
  "kasten",
  "katalog",
  "katze",
  "kaufhaus",
  "kauz",
  "kegel",
  "kehren",
  "keks",
  "kelch",
  "keller",
  "kennen",
  "keramik",
  "kern",
  "kerze",
  "kessel",
  "ketchup",
  "kette",
  "keule",
  "kiefer",
  "kiesel",
  "kilo",
  "kind",
  "kino",
  "kiosk",
  "kirsche",
  "kissen",
  "kiste",
  "kittel",
  "kiwi",
  "klage",
  "klammer",
  "klang",
  "klappe",
  "klar",
  "klasse",
  "klavier",
  "kleben",
  "klee",
  "kleid",
  "klettern",
  "klientel",
  "klima",
  "klinik",
  "klippe",
  "klon",
  "klopfen",
  "klotz",
  "klug",
  "knapp",
  "kneipe",
  "knie",
  "knochen",
  "knopf",
  "knoten",
  "koala",
  "kochen",
  "koffer",
  "kohle",
  "koje",
  "kolibri",
  "kollege",
  "komisch",
  "kommen",
  "komplett",
  "konflikt",
  "konkurs",
  "konsum",
  "kontakt",
  "konzert",
  "kopf",
  "kopie",
  "korb",
  "korn",
  "korrekt",
  "kosten",
  "krabbe",
  "kraft",
  "kralle",
  "kran",
  "kraut",
  "krawatte",
  "krebs",
  "kredit",
  "kreis",
  "kresse",
  "kreuz",
  "kriegen",
  "krippe",
  "krise",
  "kritik",
  "krokodil",
  "krone",
  "krug",
  "krumm",
  "kruste",
  "kuchen",
  "kugel",
  "kuhstall",
  "kulisse",
  "kultur",
  "kunde",
  "kunst",
  "kupfer",
  "kurier",
  "kurs",
  "kurve",
  "kurz",
  "kuss",
  "kutsche",
  "label",
  "labor",
  "lachen",
  "lack",
  "laden",
  "ladung",
  "lager",
  "laie",
  "lama",
  "lamm",
  "lampe",
  "land",
  "lang",
  "lappen",
  "larve",
  "lassen",
  "last",
  "laterne",
  "latte",
  "laub",
  "lauch",
  "laufen",
  "laune",
  "laut",
  "lavendel",
  "lawine",
  "leben",
  "lecker",
  "leder",
  "leer",
  "legen",
  "lehm",
  "lehnen",
  "lehrer",
  "leib",
  "leicht",
  "leid",
  "leim",
  "leinwand",
  "leiste",
  "leiter",
  "lektor",
  "lemming",
  "lenken",
  "leopard",
  "lernen",
  "lesen",
  "lesung",
  "leuchte",
  "leute",
  "lexikon",
  "libelle",
  "licht",
  "liebe",
  "lied",
  "liefern",
  "liegen",
  "lila",
  "lilie",
  "limette",
  "linde",
  "lineal",
  "linie",
  "links",
  "lippe",
  "liste",
  "liter",
  "lizenz",
  "loch",
  "locke",
  "logistik",
  "lohn",
  "lokal",
  "lotse",
  "loyal",
  "luchs",
  "luft",
  "lunge",
  "lupe",
  "lustig",
  "luxus",
  "lyrik",
  "machen",
  "made",
  "magazin",
  "magen",
  "magie",
  "magnet",
  "mahnen",
  "mais",
  "malen",
  "mama",
  "mango",
  "mann",
  "mantel",
  "marder",
  "markt",
  "marmor",
  "marsch",
  "maschine",
  "maske",
  "masse",
  "mast",
  "material",
  "matrose",
  "matte",
  "mauer",
  "maulwurf",
  "maus",
  "maximal",
  "medaille",
  "medizin",
  "meer",
  "mehl",
  "mehrweg",
  "meinung",
  "meister",
  "melden",
  "melken",
  "melone",
  "membran",
  "menge",
  "mensch",
  "mentor",
  "merkmal",
  "messer",
  "metall",
  "meter",
  "methode",
  "miene",
  "mieten",
  "milan",
  "milch",
  "milde",
  "milieu",
  "mimik",
  "mineral",
  "minigolf",
  "minute",
  "minze",
  "mischung",
  "mitglied",
  "mitleid",
  "mittag",
  "mode",
  "molch",
  "moment",
  "monat",
  "mond",
  "monitor",
  "monster",
  "montag",
  "moos",
  "moped",
  "moral",
  "morgen",
  "motiv",
  "motor",
  "motte",
  "mulde",
  "mund",
  "muschel",
  "museum",
  "musik",
  "muskel",
  "muster",
  "mutig",
  "mutter",
  "mythos",
  "nacht",
  "nacken",
  "nadel",
  "nagel",
  "nahrung",
  "name",
  "napf",
  "narbe",
  "narr",
  "narzisse",
  "nase",
  "nashorn",
  "nass",
  "natter",
  "natur",
  "nebel",
  "negativ",
  "nehmen",
  "neid",
  "neigung",
  "nektar",
  "nennen",
  "nerven",
  "nest",
  "nett",
  "netz",
  "neubau",
  "neugier",
  "neuland",
  "neun",
  "niedrig",
  "niemand",
  "nilpferd",
  "niveau",
  "nobel",
  "nochmal",
  "norden",
  "normal",
  "note",
  "notfall",
  "notiz",
  "november",
  "nudel",
  "null",
  "nummer",
  "nuss",
  "nutzen",
  "oase",
  "oben",
  "objekt",
  "obst",
  "ofen",
  "offen",
  "ohne",
  "ohren",
  "ohrring",
  "oktober",
  "olive",
  "olympia",
  "omelett",
  "onkel",
  "online",
  "oper",
  "option",
  "orange",
  "ordnung",
  "organ",
  "orgel",
  "original",
  "orkan",
  "ortsrand",
  "ostern",
  "otter",
  "oval",
  "paar",
  "packen",
  "paket",
  "palast",
  "palette",
  "palme",
  "panda",
  "panik",
  "papagei",
  "papier",
  "pappe",
  "paprika",
  "parade",
  "park",
  "parole",
  "party",
  "passage",
  "patent",
  "pathos",
  "patient",
  "pause",
  "pavian",
  "pech",
  "pedal",
  "pegel",
  "peinlich",
  "peitsche",
  "pelikan",
  "pelz",
  "pendel",
  "perfekt",
  "periode",
  "perle",
  "person",
  "pfad",
  "pfahl",
  "pfanne",
  "pfau",
  "pfeffer",
  "pfeil",
  "pferd",
  "pfiff",
  "pfirsich",
  "pflaume",
  "pflegen",
  "pflicht",
  "pflug",
  "pforte",
  "pfosten",
  "pfote",
  "phase",
  "physik",
  "picknick",
  "pier",
  "pigment",
  "pille",
  "pilot",
  "pilz",
  "pinguin",
  "pink",
  "pinnwand",
  "pinsel",
  "pinzette",
  "pirat",
  "piste",
  "pixel",
  "plakat",
  "planet",
  "plastik",
  "platz",
  "pleite",
  "plus",
  "podest",
  "podium",
  "poesie",
  "pokal",
  "politik",
  "pollen",
  "polster",
  "pommes",
  "pony",
  "pool",
  "portrait",
  "positiv",
  "post",
  "pracht",
  "praxis",
  "preis",
  "presse",
  "prinzip",
  "privat",
  "probe",
  "produkt",
  "profil",
  "programm",
  "projekt",
  "prospekt",
  "protest",
  "provinz",
  "prozent",
  "psyche",
  "publikum",
  "pudding",
  "puder",
  "puls",
  "pulver",
  "puma",
  "pumpe",
  "punkt",
  "punsch",
  "puppe",
  "pute",
  "putzen",
  "puzzel",
  "pyjama",
  "pyramide",
  "quadrat",
  "qualle",
  "quark",
  "quatsch",
  "quelle",
  "quer",
  "quittung",
  "quiz",
  "quote",
  "rabatt",
  "rabe",
  "rache",
  "radar",
  "radio",
  "radtour",
  "radweg",
  "rahmen",
  "rakete",
  "rampe",
  "rand",
  "rang",
  "ranke",
  "raps",
  "rasen",
  "rassel",
  "rast",
  "rasur",
  "raten",
  "ratgeber",
  "rathaus",
  "ratte",
  "rauch",
  "raum",
  "raupe",
  "raus",
  "raute",
  "razzia",
  "reaktion",
  "real",
  "rebell",
  "rechnen",
  "reden",
  "redner",
  "referent",
  "reform",
  "regal",
  "regen",
  "region",
  "rehkitz",
  "reibe",
  "reich",
  "reifen",
  "reihe",
  "reim",
  "rein",
  "reise",
  "reiten",
  "reiz",
  "rekord",
  "rektor",
  "relativ",
  "rennen",
  "rentier",
  "reporter",
  "reptil",
  "reserve",
  "residenz",
  "resonanz",
  "respekt",
  "rest",
  "resultat",
  "retten",
  "revier",
  "rezept",
  "rhythmus",
  "richtig",
  "riechen",
  "riegel",
  "riesig",
  "rind",
  "ring",
  "rinnsaal",
  "risiko",
  "riss",
  "ritter",
  "ritual",
  "ritze",
  "robbe",
  "roboter",
  "rock",
  "roggen",
  "rohbau",
  "rohkost",
  "rohr",
  "rohstoff",
  "roller",
  "roman",
  "rosa",
  "rose",
  "rosine",
  "rost",
  "rotkohl",
  "rotor",
  "rucksack",
  "rudel",
  "rufen",
  "ruhe",
  "ruhig",
  "ruhm",
  "ruine",
  "rummel",
  "rund",
  "runter",
  "rute",
  "rutsche",
  "saal",
  "saat",
  "sache",
  "sack",
  "safran",
  "saft",
  "sagen",
  "sahne",
  "saison",
  "salat",
  "salbe",
  "saloon",
  "salz",
  "samen",
  "sammeln",
  "samstag",
  "samt",
  "sand",
  "sanft",
  "saniert",
  "sardine",
  "satellit",
  "satire",
  "sattel",
  "satz",
  "sauber",
  "sauer",
  "saugen",
  "sauna",
  "saurier",
  "schaf",
  "schere",
  "schirm",
  "schlange",
  "schmuck",
  "schnee",
  "schock",
  "schrank",
  "schuh",
  "schwan",
  "sechs",
  "seefahrt",
  "seehund",
  "seekuh",
  "seele",
  "seestern",
  "segel",
  "segment",
  "sehen",
  "seide",
  "seife",
  "seil",
  "seite",
  "sektor",
  "sekunde",
  "sellerie",
  "selten",
  "semester",
  "seminar",
  "senden",
  "senf",
  "senior",
  "senken",
  "sense",
  "serie",
  "serum",
  "server",
  "sessel",
  "setzen",
  "shop",
  "sichel",
  "sieb",
  "siedlung",
  "sieg",
  "signal",
  "silber",
  "simpel",
  "singen",
  "sinken",
  "sinn",
  "sirene",
  "sirup",
  "sitzen",
  "skala",
  "skandal",
  "skelett",
  "skizze",
  "skript",
  "skulptur",
  "socke",
  "sofa",
  "sohle",
  "sohn",
  "soja",
  "solide",
  "sollen",
  "sommer",
  "sonne",
  "sorge",
  "sorte",
  "sozial",
  "spachtel",
  "spagat",
  "spalten",
  "spange",
  "spargel",
  "spaten",
  "specht",
  "speise",
  "spektrum",
  "spende",
  "sperling",
  "speziell",
  "spiegel",
  "spinne",
  "spion",
  "spitze",
  "sponsor",
  "sport",
  "sprache",
  "sprechen",
  "springen",
  "sprotte",
  "sprung",
  "spur",
  "stabil",
  "stachel",
  "stadt",
  "stahl",
  "stall",
  "stamm",
  "standort",
  "stapel",
  "stark",
  "station",
  "staub",
  "stecken",
  "steg",
  "stehen",
  "stein",
  "stellen",
  "stempel",
  "steppe",
  "stern",
  "stetig",
  "steuer",
  "stichtag",
  "stier",
  "stift",
  "still",
  "stimme",
  "stirn",
  "stock",
  "stoff",
  "stolz",
  "stoppen",
  "storch",
  "strand",
  "strecke",
  "strich",
  "strom",
  "strumpf",
  "stube",
  "stuck",
  "studium",
  "stufe",
  "stuhl",
  "stumm",
  "stunde",
  "sturm",
  "substanz",
  "suche",
  "summe",
  "sumpf",
  "suppe",
  "surfen",
  "symbol",
  "symptome",
  "system",
  "szenario",
  "tabelle",
  "tabu",
  "tacker",
  "tadel",
  "tafel",
  "tagebuch",
  "takt",
  "talent",
  "talfahrt",
  "tango",
  "tank",
  "tanne",
  "tante",
  "tanz",
  "tapfer",
  "tapir",
  "tarif",
  "tarnen",
  "tasche",
  "tasse",
  "tastatur",
  "tatort",
  "tatsache",
  "taube",
  "tauchen",
  "tausch",
  "taxi",
  "team",
  "technik",
  "teekanne",
  "teer",
  "teesieb",
  "teich",
  "teig",
  "teilen",
  "telefon",
  "teller",
  "tempo",
  "tendenz",
  "tennis",
  "tenor",
  "teppich",
  "termin",
  "terrasse",
  "test",
  "teuer",
  "text",
  "theater",
  "thema",
  "theorie",
  "therapie",
  "these",
  "tief",
  "tier",
  "tiger",
  "tinte",
  "tipp",
  "tisch",
  "titel",
  "tochter",
  "toilette",
  "toleranz",
  "toll",
  "tomate",
  "tonband",
  "tonne",
  "topf",
  "torbogen",
  "torte",
  "torwart",
  "total",
  "tracht",
  "tragen",
  "training",
  "trapez",
  "trasse",
  "traum",
  "treffen",
  "treiben",
  "trennen",
  "treppe",
  "tresor",
  "treten",
  "treu",
  "triangel",
  "trick",
  "trinken",
  "trocken",
  "trommel",
  "tropfen",
  "trost",
  "trubel",
  "truhe",
  "trumpf",
  "trunk",
  "truthahn",
  "tuch",
  "tukan",
  "tulpe",
  "tunnel",
  "turbine",
  "turm",
  "turnen",
  "tusche",
  "typisch",
  "ufer",
  "uhrwerk",
  "umbau",
  "umbruch",
  "umfang",
  "umfeld",
  "umfrage",
  "umgang",
  "umgebung",
  "umhang",
  "umkreis",
  "umland",
  "umriss",
  "umsatz",
  "umschlag",
  "umsetzen",
  "umsonst",
  "umstand",
  "umwelt",
  "umzug",
  "unfall",
  "unikat",
  "unmut",
  "unrat",
  "unrecht",
  "unruhe",
  "unschuld",
  "unsinn",
  "unten",
  "unweit",
  "urkunde",
  "urlaub",
  "ursache",
  "ursprung",
  "urteil",
  "utopie",
  "vage",
  "vakuum",
  "vanille",
  "variante",
  "vase",
  "vater",
  "ventil",
  "veranda",
  "verband",
  "verdacht",
  "verein",
  "verfall",
  "verkehr",
  "verloren",
  "vernunft",
  "verrat",
  "verstand",
  "vertrag",
  "verwandt",
  "verzicht",
  "video",
  "vieh",
  "viel",
  "vier",
  "villa",
  "virus",
  "vision",
  "vitamine",
  "vitrine",
  "vogel",
  "voliere",
  "voll",
  "volumen",
  "vorbild",
  "vorfall",
  "vorgabe",
  "vorhang",
  "vorlage",
  "vorn",
  "vorort",
  "vorrat",
  "vorsicht",
  "vortrag",
  "vorwurf",
  "votum",
  "vulkan",
  "waage",
  "wachs",
  "wade",
  "waffel",
  "wagen",
  "waggon",
  "wahl",
  "wahrheit",
  "wald",
  "walnuss",
  "walross",
  "walze",
  "wand",
  "wanne",
  "wanze",
  "wappen",
  "ware",
  "warm",
  "warnung",
  "warten",
  "warze",
  "waschen",
  "wasser",
  "webstuhl",
  "wechsel",
  "wecker",
  "wedel",
  "weggabel",
  "wehren",
  "weich",
  "weide",
  "wein",
  "weisheit",
  "weit",
  "weizen",
  "welken",
  "welle",
  "welpe",
  "welt",
  "wende",
  "wenig",
  "werbung",
  "werfen",
  "werkzeug",
  "wert",
  "wesen",
  "wespe",
  "weste",
  "wetter",
  "wichtig",
  "widder",
  "wiegen",
  "wiese",
  "wild",
  "wille",
  "wimper",
  "wind",
  "winkel",
  "winter",
  "winzig",
  "wippe",
  "wirbel",
  "wirkung",
  "wirt",
  "wischen",
  "wisent",
  "wissen",
  "witz",
  "woche",
  "wohl",
  "wohnen",
  "wolf",
  "wolke",
  "wolle",
  "wort",
  "wunder",
  "wunsch",
  "wurm",
  "wurzel",
  "zacke",
  "zahl",
  "zahm",
  "zahn",
  "zander",
  "zange",
  "zapfen",
  "zart",
  "zauber",
  "zaun",
  "zebra",
  "zeche",
  "zecke",
  "zehe",
  "zehn",
  "zeichen",
  "zeigen",
  "zeile",
  "zeit",
  "zelle",
  "zelt",
  "zement",
  "zensur",
  "zentrum",
  "zettel",
  "zeug",
  "ziege",
  "ziehen",
  "ziel",
  "ziffer",
  "zimmer",
  "zimt",
  "zins",
  "zipfel",
  "zirkus",
  "zitat",
  "zitrone",
  "zocken",
  "zollfrei",
  "zone",
  "zorn",
  "zucchini",
  "zucker",
  "zufall",
  "zuflucht",
  "zugang",
  "zugriff",
  "zukunft",
  "zunge",
  "zusatz",
  "zuschlag",
  "zustand",
  "zutat",
  "zwang",
  "zweck",
  "zwei",
  "zwiebel",
  "zwilling",
  "zwingen",
  "zwirn",
  "zyklus"
];
if (ie.length !== 2048)
  throw new Error(
    `German wordlist must contain exactly 2048 words, but has ${ie.length}`
  );
const Qe = new Set(ie.map((s) => s.slice(0, 4)));
if (Qe.size !== 2048)
  throw new Error(
    `First 4 characters must be unique. Have ${Qe.size} unique, need 2048`
  );
class bn {
  constructor() {
    c(this, "masterKey", null);
    c(this, "identityKeyPair", null);
    c(this, "encryptionKeyPair", null);
    c(this, "did", null);
    c(this, "storage", new Ne());
  }
  /**
   * Create a new identity with BIP39 mnemonic
   *
   * @param userPassphrase - User's passphrase for seed encryption
   * @param storeSeed - Store encrypted seed in IndexedDB (default: true)
   * @returns Mnemonic (12 words) and DID
   */
  async create(e, t = !0) {
    const r = Kr(ie, 128), n = Ve(r, "");
    return t && await this.storage.storeSeed(new Uint8Array(n.slice(0, 32)), e), this.masterKey = await crypto.subtle.importKey(
      "raw",
      n.slice(0, 32),
      // First 32 bytes
      { name: "HKDF" },
      !1,
      // non-extractable!
      ["deriveKey", "deriveBits"]
    ), await this.deriveIdentityKeyPair(), this.did = await this.generateDID(), { mnemonic: r, did: this.did };
  }
  /**
   * Unlock identity from mnemonic + passphrase
   *
   * @param mnemonic - 12 word BIP39 mnemonic
   * @param passphrase - User's passphrase
   * @param storeSeed - Store encrypted seed in IndexedDB (default: false)
   */
  async unlock(e, t, r = !1) {
    if (!Mr(e, ie))
      throw new Error("Invalid mnemonic");
    const n = Ve(e, "");
    r && await this.storage.storeSeed(new Uint8Array(n.slice(0, 32)), t), this.masterKey = await crypto.subtle.importKey(
      "raw",
      n.slice(0, 32),
      { name: "HKDF" },
      !1,
      // non-extractable!
      ["deriveKey", "deriveBits"]
    ), await this.deriveIdentityKeyPair(), this.did = await this.generateDID();
  }
  /**
   * Unlock identity from stored encrypted seed.
   * If no passphrase is provided, attempts to use a cached session key.
   *
   * @param passphrase - User's passphrase (optional if session key is cached)
   * @throws Error if no seed stored, wrong passphrase, or no active session
   */
  async unlockFromStorage(e) {
    let t = null;
    if (e) {
      if (t = await this.storage.loadSeed(e), !t)
        throw new Error("No identity found in storage");
    } else if (t = await this.storage.loadSeedWithSessionKey(), !t)
      throw new Error("Session expired");
    this.masterKey = await crypto.subtle.importKey(
      "raw",
      t,
      { name: "HKDF" },
      !1,
      // non-extractable!
      ["deriveKey", "deriveBits"]
    ), await this.deriveIdentityKeyPair(), this.did = await this.generateDID();
  }
  /**
   * Check if a valid session key exists (allows unlock without passphrase)
   */
  async hasActiveSession() {
    return this.storage.hasActiveSession();
  }
  /**
   * Check if identity exists in storage
   */
  async hasStoredIdentity() {
    return this.storage.hasSeed();
  }
  /**
   * Delete stored identity
   */
  async deleteStoredIdentity() {
    await this.storage.deleteSeed(), await this.lock();
  }
  /**
   * Lock identity (clear all keys from memory and session cache)
   */
  async lock() {
    this.masterKey = null, this.identityKeyPair = null, this.encryptionKeyPair = null, this.did = null, await this.storage.clearSessionKey();
  }
  /**
   * Get DID (Decentralized Identifier)
   */
  getDid() {
    if (!this.did)
      throw new Error("Identity not unlocked");
    return this.did;
  }
  /**
   * Sign a payload as JWS (JSON Web Signature) compact serialization
   *
   * @param payload - Data to sign (will be JSON-serialized)
   * @returns JWS compact serialization (header.payload.signature)
   */
  async signJws(e) {
    if (!this.identityKeyPair)
      throw new Error("Identity not unlocked");
    return jt(e, this.identityKeyPair.privateKey);
  }
  /**
   * Sign data with identity private key
   *
   * @param data - Data to sign
   * @returns Signature as base64url string
   */
  async sign(e) {
    if (!this.identityKeyPair)
      throw new Error("Identity not unlocked");
    const t = new TextEncoder(), r = await crypto.subtle.sign(
      "Ed25519",
      this.identityKeyPair.privateKey,
      t.encode(e)
    );
    return this.arrayBufferToBase64Url(r);
  }
  /**
   * Derive framework-specific keys (extractable for Evolu, etc.)
   *
   * @param info - Context string (e.g., 'evolu-storage-v1')
   * @returns Derived key bytes
   */
  async deriveFrameworkKey(e) {
    if (!this.masterKey)
      throw new Error("Identity not unlocked");
    const t = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode(e)
      },
      this.masterKey,
      256
      // 32 bytes
    );
    return new Uint8Array(t);
  }
  /**
   * Get public key (for DID Document, etc.)
   */
  async getPublicKey() {
    if (!this.identityKeyPair)
      throw new Error("Identity not unlocked");
    return this.identityKeyPair.publicKey;
  }
  /**
   * Export public key as JWK
   */
  async exportPublicKeyJwk() {
    const e = await this.getPublicKey();
    return crypto.subtle.exportKey("jwk", e);
  }
  /**
   * Get public key as multibase encoded string (same format as in DID)
   */
  async getPublicKeyMultibase() {
    if (!this.identityKeyPair)
      throw new Error("Identity not unlocked");
    const e = await crypto.subtle.exportKey(
      "jwk",
      this.identityKeyPair.publicKey
    ), t = this.base64UrlToArrayBuffer(e.x), r = new Uint8Array([237, 1]), n = new Uint8Array(r.length + t.byteLength);
    return n.set(r), n.set(new Uint8Array(t), r.length), "z" + this.base58Encode(n);
  }
  // --- Encryption (X25519 ECDH + AES-GCM) ---
  /**
   * Get the X25519 encryption key pair (derived via separate HKDF path).
   * Lazily derived on first call, then cached.
   */
  async getEncryptionKeyPair() {
    if (!this.masterKey)
      throw new Error("Identity not unlocked");
    return this.encryptionKeyPair || await this.deriveEncryptionKeyPair(), this.encryptionKeyPair;
  }
  /**
   * Get X25519 public key as raw bytes (32 bytes).
   * This is what others need to encrypt messages for this identity.
   */
  async getEncryptionPublicKeyBytes() {
    const e = await this.getEncryptionKeyPair(), t = await crypto.subtle.exportKey("raw", e.publicKey);
    return new Uint8Array(t);
  }
  /**
   * Encrypt data for a recipient using their X25519 public key.
   * Uses ephemeral ECDH + HKDF + AES-256-GCM (ECIES-like).
   */
  async encryptForRecipient(e, t) {
    if (!this.masterKey)
      throw new Error("Identity not unlocked");
    const r = await crypto.subtle.generateKey(
      { name: "X25519" },
      !0,
      // extractable (need to send public key)
      ["deriveBits"]
    ), n = await crypto.subtle.importKey(
      "raw",
      t,
      { name: "X25519" },
      !0,
      []
    ), i = await crypto.subtle.deriveBits(
      { name: "X25519", public: n },
      r.privateKey,
      256
    ), a = await crypto.subtle.importKey(
      "raw",
      i,
      { name: "HKDF" },
      !1,
      ["deriveKey"]
    ), o = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode("wot-ecies-v1")
      },
      a,
      { name: "AES-GCM", length: 256 },
      !1,
      ["encrypt"]
    ), l = crypto.getRandomValues(new Uint8Array(12)), d = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: l },
      o,
      e
    ), f = new Uint8Array(
      await crypto.subtle.exportKey("raw", r.publicKey)
    );
    return {
      ciphertext: new Uint8Array(d),
      nonce: l,
      ephemeralPublicKey: f
    };
  }
  /**
   * Decrypt data encrypted for this identity.
   * Uses own X25519 private key + ephemeral public key from sender.
   */
  async decryptForMe(e) {
    if (!this.masterKey)
      throw new Error("Identity not unlocked");
    if (!e.ephemeralPublicKey)
      throw new Error("Missing ephemeral public key");
    const t = await this.getEncryptionKeyPair(), r = await crypto.subtle.importKey(
      "raw",
      e.ephemeralPublicKey,
      { name: "X25519" },
      !0,
      []
    ), n = await crypto.subtle.deriveBits(
      { name: "X25519", public: r },
      t.privateKey,
      256
    ), i = await crypto.subtle.importKey(
      "raw",
      n,
      { name: "HKDF" },
      !1,
      ["deriveKey"]
    ), a = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode("wot-ecies-v1")
      },
      i,
      { name: "AES-GCM", length: 256 },
      !1,
      ["decrypt"]
    ), o = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: e.nonce },
      a,
      e.ciphertext
    );
    return new Uint8Array(o);
  }
  // Private methods
  async deriveIdentityKeyPair() {
    if (!this.masterKey)
      throw new Error("Master key not initialized");
    const e = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode("wot-identity-v1")
      },
      this.masterKey,
      256
      // 32 bytes for Ed25519
    ), t = new Uint8Array(e), r = await Jr(t), n = {
      kty: "OKP",
      crv: "Ed25519",
      x: this.arrayBufferToBase64Url(r.buffer),
      d: this.arrayBufferToBase64Url(t.buffer),
      ext: !1,
      // non-extractable
      key_ops: ["sign"]
    }, i = {
      kty: "OKP",
      crv: "Ed25519",
      x: this.arrayBufferToBase64Url(r.buffer),
      ext: !0,
      key_ops: ["verify"]
    }, a = await crypto.subtle.importKey(
      "jwk",
      n,
      "Ed25519",
      !1,
      // non-extractable!
      ["sign"]
    ), o = await crypto.subtle.importKey(
      "jwk",
      i,
      "Ed25519",
      !0,
      // public key can be extractable
      ["verify"]
    );
    this.identityKeyPair = { privateKey: a, publicKey: o };
  }
  async deriveEncryptionKeyPair() {
    if (!this.masterKey)
      throw new Error("Master key not initialized");
    const e = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode("wot-encryption-v1")
      },
      this.masterKey,
      256
      // 32 bytes for X25519
    ), t = this.wrapX25519PrivateKey(new Uint8Array(e)), r = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !1,
      // non-extractable
      ["deriveBits"]
    ), n = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !0,
      // extractable to get JWK
      ["deriveBits"]
    ), i = await crypto.subtle.exportKey("jwk", n), a = await crypto.subtle.importKey(
      "jwk",
      { kty: i.kty, crv: i.crv, x: i.x },
      { name: "X25519" },
      !0,
      []
    );
    this.encryptionKeyPair = { privateKey: r, publicKey: a };
  }
  /**
   * Wrap raw 32-byte X25519 private key in PKCS8 DER format.
   * PKCS8 = SEQUENCE { version, algorithm, key }
   */
  wrapX25519PrivateKey(e) {
    const t = new Uint8Array([
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
      // OCTET STRING (32 bytes) — the actual key
    ]), r = new Uint8Array(t.length + e.length);
    return r.set(t), r.set(e, t.length), r;
  }
  async generateDID() {
    if (!this.identityKeyPair)
      throw new Error("Key pair not initialized");
    const e = await crypto.subtle.exportKey(
      "jwk",
      this.identityKeyPair.publicKey
    ), t = this.base64UrlToArrayBuffer(e.x), r = new Uint8Array([237, 1]), n = new Uint8Array(r.length + t.byteLength);
    return n.set(r), n.set(new Uint8Array(t), r.length), `did:key:z${this.base58Encode(n)}`;
  }
  // Utility methods
  arrayBufferToBase64Url(e) {
    const t = new Uint8Array(e);
    let r = "";
    for (let n = 0; n < t.length; n++)
      r += String.fromCharCode(t[n]);
    return btoa(r).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  base64UrlToArrayBuffer(e) {
    const t = atob(e.replace(/-/g, "+").replace(/_/g, "/")), r = new Uint8Array(t.length);
    for (let n = 0; n < t.length; n++)
      r[n] = t.charCodeAt(n);
    return r.buffer;
  }
  base58Encode(e) {
    const t = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let r = "", n = BigInt(0);
    for (const i of e)
      n = n * BigInt(256) + BigInt(i);
    for (; n > 0; ) {
      const i = n % BigInt(58);
      r = t[Number(i)] + r, n = n / BigInt(58);
    }
    for (const i of e)
      if (i === 0)
        r = t[0] + r;
      else
        break;
    return r;
  }
}
class gn {
  /**
   * Create a verification challenge
   *
   * @param identity - WotIdentity of challenger
   * @param name - Display name of challenger
   * @returns Base64-encoded challenge string
   */
  static async createChallenge(e, t) {
    const r = {
      nonce: crypto.randomUUID(),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      fromDid: e.getDid(),
      fromPublicKey: await e.getPublicKeyMultibase(),
      fromName: t
    };
    return btoa(JSON.stringify(r));
  }
  /**
   * Respond to a verification challenge
   *
   * @param challengeCode - Base64-encoded challenge
   * @param identity - WotIdentity of responder
   * @param name - Display name of responder
   * @returns Base64-encoded response string
   */
  static async respondToChallenge(e, t, r) {
    const n = JSON.parse(atob(e)), i = {
      nonce: n.nonce,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      // Responder info
      toDid: t.getDid(),
      toPublicKey: await t.getPublicKeyMultibase(),
      toName: r,
      // Original challenge info
      fromDid: n.fromDid,
      fromPublicKey: n.fromPublicKey,
      fromName: n.fromName
    };
    return btoa(JSON.stringify(i));
  }
  /**
   * Complete verification by creating signed verification object
   *
   * @param responseCode - Base64-encoded response
   * @param identity - WotIdentity of initiator (signer)
   * @param expectedNonce - Nonce from original challenge
   * @returns Signed Verification object
   * @throws Error if nonce mismatch
   */
  static async completeVerification(e, t, r) {
    const n = JSON.parse(atob(e));
    if (n.nonce !== r)
      throw new Error("Nonce mismatch");
    const i = JSON.stringify({
      from: t.getDid(),
      to: n.toDid,
      timestamp: n.timestamp
    }), a = await t.sign(i);
    return {
      id: `urn:uuid:ver-${n.nonce}`,
      from: t.getDid(),
      to: n.toDid,
      timestamp: n.timestamp,
      proof: {
        type: "Ed25519Signature2020",
        verificationMethod: `${t.getDid()}#key-1`,
        created: (/* @__PURE__ */ new Date()).toISOString(),
        proofPurpose: "authentication",
        proofValue: a
      }
    };
  }
  /**
   * Create a verification for a specific DID (Empfänger-Prinzip).
   * Used when Bob verifies Alice: from=Bob, to=Alice.
   *
   * @param identity - WotIdentity of the signer (from)
   * @param toDid - DID of the person being verified (to/recipient)
   * @param nonce - Nonce from the challenge for deterministic ID
   * @returns Signed Verification object
   */
  static async createVerificationFor(e, t, r) {
    const n = (/* @__PURE__ */ new Date()).toISOString(), i = JSON.stringify({
      from: e.getDid(),
      to: t,
      timestamp: n
    }), a = await e.sign(i);
    return {
      id: `urn:uuid:ver-${r}-${e.getDid().slice(-8)}`,
      from: e.getDid(),
      to: t,
      timestamp: n,
      proof: {
        type: "Ed25519Signature2020",
        verificationMethod: `${e.getDid()}#key-1`,
        created: n,
        proofPurpose: "authentication",
        proofValue: a
      }
    };
  }
  /**
   * Verify signature on a verification object
   *
   * @param verification - Verification object to verify
   * @returns True if signature is valid
   */
  static async verifySignature(e) {
    try {
      const t = this.publicKeyFromDid(e.from), r = JSON.stringify({
        from: e.from,
        to: e.to,
        timestamp: e.timestamp
      }), n = this.multibaseToBytes(t), i = await crypto.subtle.importKey(
        "raw",
        n,
        "Ed25519",
        !1,
        ["verify"]
      ), a = this.base64UrlToBytes(e.proof.proofValue), o = new TextEncoder();
      return await crypto.subtle.verify(
        "Ed25519",
        i,
        a,
        o.encode(r)
      );
    } catch (t) {
      return console.error("Signature verification failed:", t), !1;
    }
  }
  /**
   * Extract public key from did:key DID
   *
   * @param did - DID in format did:key:z6Mk...
   * @returns Multibase-encoded public key (z6Mk...)
   */
  static publicKeyFromDid(e) {
    if (!e.startsWith("did:key:"))
      throw new Error("Invalid did:key format");
    return e.slice(8);
  }
  /**
   * Convert multibase (base58btc) to bytes
   *
   * @param multibase - Multibase string (z-prefixed base58btc)
   * @returns Uint8Array of decoded bytes
   */
  static multibaseToBytes(e) {
    if (!e.startsWith("z"))
      throw new Error("Only base58btc (z-prefix) multibase supported");
    const t = e.slice(1), r = Ar.decode(t);
    if (r.length === 34 && r[0] === 237 && r[1] === 1)
      return r.slice(2);
    throw new Error("Invalid Ed25519 public key format in multibase");
  }
  /**
   * Convert base64url to bytes
   *
   * @param base64url - Base64url-encoded string
   * @returns Uint8Array of decoded bytes
   */
  static base64UrlToBytes(e) {
    const t = e.replace(/-/g, "+").replace(/_/g, "/"), r = atob(t), n = new Uint8Array(r.length);
    for (let i = 0; i < r.length; i++)
      n[i] = r.charCodeAt(i);
    return n;
  }
}
function Qr(s) {
  return s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength);
}
class ze {
  /**
   * Sign a public profile as JWS using the identity's private key
   */
  static async signProfile(e, t) {
    return t.signJws(e);
  }
  /**
   * Verify a JWS-signed profile.
   * Extracts the DID from the payload, resolves the public key,
   * and verifies the signature.
   */
  static async verifyProfile(e) {
    try {
      const t = _e(e);
      if (!t || typeof t != "object")
        return { valid: !1, error: "Invalid JWS payload" };
      const r = t;
      if (!r.did || !r.did.startsWith("did:key:z"))
        return { valid: !1, error: "Missing or invalid DID in profile" };
      const n = Ke(r.did), i = await crypto.subtle.importKey(
        "raw",
        Qr(n),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ), a = await rt(e, i);
      return a.valid ? { valid: !0, profile: a.payload } : { valid: !1, error: a.error ?? "Signature verification failed" };
    } catch (t) {
      return {
        valid: !1,
        error: t instanceof Error ? t.message : "Verification failed"
      };
    }
  }
}
class Ee {
  /**
   * Encrypt a CRDT change with a group key.
   */
  static async encryptChange(e, t, r, n, i) {
    const a = await crypto.subtle.importKey(
      "raw",
      t,
      { name: "AES-GCM" },
      !1,
      ["encrypt"]
    ), o = crypto.getRandomValues(new Uint8Array(12)), l = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: o },
      a,
      e
    );
    return {
      ciphertext: new Uint8Array(l),
      nonce: o,
      spaceId: r,
      generation: n,
      fromDid: i
    };
  }
  /**
   * Decrypt a CRDT change with a group key.
   */
  static async decryptChange(e, t) {
    const r = await crypto.subtle.importKey(
      "raw",
      t,
      { name: "AES-GCM" },
      !1,
      ["decrypt"]
    ), n = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: e.nonce },
      r,
      e.ciphertext
    );
    return new Uint8Array(n);
  }
}
class mn {
  constructor() {
    c(this, "spaces", /* @__PURE__ */ new Map());
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
    const r = crypto.getRandomValues(new Uint8Array(32));
    return t.keys.push(r), r;
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
    const r = this.spaces.get(e);
    return !r || t < 0 || t >= r.keys.length ? null : r.keys[t];
  }
  /**
   * Import a key for a space at a specific generation.
   * Used when receiving a group key from an invite.
   */
  importKey(e, t, r) {
    let n = this.spaces.get(e);
    for (n || (n = { keys: [] }, this.spaces.set(e, n)); n.keys.length <= r; )
      n.keys.push(new Uint8Array(0));
    n.keys[r] = t;
  }
}
class wn {
  constructor(e, t, r) {
    c(this, "staleDurationMs");
    c(this, "concurrency");
    c(this, "refreshing", /* @__PURE__ */ new Set());
    this.discovery = e, this.store = t, this.staleDurationMs = (r == null ? void 0 : r.staleDurationMs) ?? 3600 * 1e3, this.concurrency = (r == null ? void 0 : r.concurrency) ?? 3;
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
      const [t, r, n] = await Promise.all([
        this.discovery.resolveProfile(e),
        this.discovery.resolveVerifications(e),
        this.discovery.resolveAttestations(e)
      ]);
      return await this.store.cacheEntry(e, t.profile, r, n), this.store.getEntry(e);
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
    const t = await this.store.getEntries(e), r = e.filter((n) => {
      const i = t.get(n);
      return !i || this.isStale(i);
    });
    if (r.length !== 0)
      for (let n = 0; n < r.length; n += this.concurrency) {
        const i = r.slice(n, n + this.concurrency);
        await Promise.allSettled(i.map((a) => this.refresh(a)));
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
        for (const r of t)
          await this.store.updateSummary(r.did, r.name, r.verificationCount, r.attestationCount);
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
class kn {
  constructor() {
    c(this, "deliveryStatus", /* @__PURE__ */ new Map());
    c(this, "statusSubscribers", /* @__PURE__ */ new Set());
    c(this, "receiptUnsubscribe", null);
    c(this, "messageUnsubscribe", null);
    c(this, "persistFn", null);
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
    for (const [r, n] of e)
      t.includes(n) && this.deliveryStatus.set(r, n);
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
    var r;
    this.deliveryStatus = new Map(this.deliveryStatus), this.deliveryStatus.set(e, t), this.notifySubscribers(), (r = this.persistFn) == null || r.call(this, e, t).catch(() => {
    });
  }
  // --- Listeners ---
  /**
   * Listen for relay delivery receipts and attestation-ack messages.
   * Call once after messaging is connected.
   */
  listenForReceipts(e) {
    var t, r;
    (t = this.receiptUnsubscribe) == null || t.call(this), (r = this.messageUnsubscribe) == null || r.call(this), this.receiptUnsubscribe = e.onReceipt((n) => {
      this.deliveryStatus.has(n.messageId) && (n.status === "delivered" ? this.setStatus(n.messageId, "delivered") : n.status === "failed" && this.setStatus(n.messageId, "failed"));
    }), this.messageUnsubscribe = e.onMessage((n) => {
      if (n.type === "attestation-ack")
        try {
          const { attestationId: i } = JSON.parse(n.payload);
          i && this.deliveryStatus.has(i) && this.setStatus(i, "acknowledged");
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
    const t = await e.getPending(), r = /* @__PURE__ */ new Set();
    for (const n of t)
      n.envelope.type === "attestation" && (r.add(n.envelope.id), this.setStatus(n.envelope.id, "queued"));
    for (const [n, i] of this.deliveryStatus)
      i === "sending" && !r.has(n) && this.setStatus(n, "failed");
  }
  // --- Private ---
  notifySubscribers() {
    for (const e of this.statusSubscribers)
      e(this.deliveryStatus);
  }
}
function K(s) {
  return s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength);
}
class Sn {
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
      publicKey: L(new Uint8Array(t)),
      privateKey: L(new Uint8Array(r))
    };
  }
  async importKeyPair(e) {
    const t = G(e.publicKey), r = G(e.privateKey), [n, i] = await Promise.all([
      crypto.subtle.importKey(
        "raw",
        K(t),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ),
      crypto.subtle.importKey(
        "pkcs8",
        K(r),
        { name: "Ed25519" },
        !0,
        ["sign"]
      )
    ]);
    return { publicKey: n, privateKey: i };
  }
  async exportPublicKey(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return L(new Uint8Array(t));
  }
  async importPublicKey(e) {
    const t = G(e);
    return crypto.subtle.importKey(
      "raw",
      K(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  // Mnemonic / Recovery - TODO: Implement with BIP39 library
  generateMnemonic() {
    throw new Error("Not implemented: requires BIP39 library");
  }
  async deriveKeyPairFromMnemonic(e) {
    throw new Error("Not implemented: requires BIP39 library");
  }
  validateMnemonic(e) {
    throw new Error("Not implemented: requires BIP39 library");
  }
  async createDid(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return Ht(new Uint8Array(t));
  }
  async didToPublicKey(e) {
    const t = Ke(e);
    return crypto.subtle.importKey(
      "raw",
      K(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  async sign(e, t) {
    const r = await crypto.subtle.sign(
      { name: "Ed25519" },
      t,
      K(e)
    );
    return new Uint8Array(r);
  }
  async verify(e, t, r) {
    return crypto.subtle.verify(
      { name: "Ed25519" },
      r,
      K(t),
      K(e)
    );
  }
  async signString(e, t) {
    const r = new TextEncoder(), n = await this.sign(r.encode(e), t);
    return L(n);
  }
  async verifyString(e, t, r) {
    const n = new TextEncoder();
    return this.verify(n.encode(e), G(t), r);
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
    const r = crypto.getRandomValues(new Uint8Array(12)), n = await crypto.subtle.importKey(
      "raw",
      K(t),
      { name: "AES-GCM" },
      !1,
      ["encrypt"]
    ), i = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: r },
      n,
      K(e)
    );
    return { ciphertext: new Uint8Array(i), nonce: r };
  }
  async decryptSymmetric(e, t, r) {
    const n = await crypto.subtle.importKey(
      "raw",
      K(r),
      { name: "AES-GCM" },
      !1,
      ["decrypt"]
    ), i = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: t },
      n,
      K(e)
    );
    return new Uint8Array(i);
  }
  // Asymmetric Encryption - TODO: Implement with X25519 + AES-GCM
  async encrypt(e, t) {
    throw new Error("Not implemented: requires X25519 key exchange");
  }
  async decrypt(e, t) {
    throw new Error("Not implemented: requires X25519 key exchange");
  }
  generateNonce() {
    const e = new Uint8Array(32);
    return crypto.getRandomValues(e), L(e);
  }
  async hashData(e) {
    const t = await crypto.subtle.digest("SHA-256", K(e));
    return new Uint8Array(t);
  }
}
const en = "web-of-trust", tn = 2;
class vn {
  constructor() {
    c(this, "db", null);
  }
  async init() {
    this.db = await tt(en, tn, {
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
    const r = this.ensureDb(), n = (/* @__PURE__ */ new Date()).toISOString(), i = {
      did: e,
      profile: t,
      createdAt: n,
      updatedAt: n
    };
    return await r.put("identity", i), i;
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
    const t = this.ensureDb(), r = await t.getAll("verifications");
    for (const n of r)
      n.from === e.from && n.to === e.to && n.id !== e.id && await t.delete("verifications", n.id);
    await t.put("verifications", e);
  }
  async getReceivedVerifications() {
    return this.ensureDb().getAll("verifications");
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
    const r = this.ensureDb(), n = {
      attestationId: e,
      accepted: t,
      ...t ? { acceptedAt: (/* @__PURE__ */ new Date()).toISOString() } : {}
    };
    await r.put("attestationMetadata", n);
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
const S = class S {
  constructor() {
    c(this, "myDid", null);
    c(this, "state", "disconnected");
    c(this, "messageCallbacks", /* @__PURE__ */ new Set());
    c(this, "receiptCallbacks", /* @__PURE__ */ new Set());
  }
  async connect(e) {
    this.myDid = e, this.state = "connected", S.registry.set(e, this);
    const t = S.offlineQueue.get(e);
    if (t && t.length > 0) {
      S.offlineQueue.delete(e);
      for (const r of t)
        await this.deliverToSelf(r);
    }
  }
  async disconnect() {
    this.myDid && S.registry.delete(this.myDid), this.myDid = null, this.state = "disconnected";
  }
  getState() {
    return this.state;
  }
  async send(e) {
    if (this.state !== "connected" || !this.myDid)
      throw new Error("MessagingAdapter: must call connect() before send()");
    const t = (/* @__PURE__ */ new Date()).toISOString(), r = S.registry.get(e.toDid);
    if (r) {
      await r.deliverToSelf(e);
      const i = {
        messageId: e.id,
        status: "delivered",
        timestamp: t
      };
      for (const a of this.receiptCallbacks)
        a(i);
      return {
        messageId: e.id,
        status: "accepted",
        timestamp: t
      };
    }
    const n = S.offlineQueue.get(e.toDid) ?? [];
    return n.push(e), S.offlineQueue.set(e.toDid, n), {
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
    S.transportMap.set(e, t);
  }
  async resolveTransport(e) {
    return S.transportMap.get(e) ?? null;
  }
  /** Reset all shared state. Call in afterEach() for test isolation. */
  static resetAll() {
    for (const e of S.registry.values())
      e.myDid = null, e.state = "disconnected";
    S.registry.clear(), S.offlineQueue.clear(), S.transportMap.clear();
  }
  async deliverToSelf(e) {
    for (const t of this.messageCallbacks)
      try {
        await t(e);
      } catch (r) {
        console.error("Message callback error:", r);
      }
  }
};
// Shared state across all instances (same process)
c(S, "registry", /* @__PURE__ */ new Map()), c(S, "offlineQueue", /* @__PURE__ */ new Map()), c(S, "transportMap", /* @__PURE__ */ new Map());
let et = S;
class xn {
  constructor(e, t) {
    c(this, "ws", null);
    c(this, "state", "disconnected");
    c(this, "messageCallbacks", /* @__PURE__ */ new Set());
    c(this, "receiptCallbacks", /* @__PURE__ */ new Set());
    c(this, "stateCallbacks", /* @__PURE__ */ new Set());
    c(this, "transportMap", /* @__PURE__ */ new Map());
    c(this, "pendingReceipts", /* @__PURE__ */ new Map());
    c(this, "heartbeatInterval", null);
    c(this, "heartbeatTimeout", null);
    c(this, "HEARTBEAT_INTERVAL_MS", 15e3);
    c(this, "HEARTBEAT_TIMEOUT_MS", 5e3);
    c(this, "SEND_TIMEOUT_MS");
    this.relayUrl = e, this.SEND_TIMEOUT_MS = (t == null ? void 0 : t.sendTimeoutMs) ?? 1e4;
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
    return this.state === "connected" && await this.disconnect(), this.setState("connecting"), new Promise((t, r) => {
      this.ws = new WebSocket(this.relayUrl), this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ type: "register", did: e }));
      }, this.ws.onmessage = (n) => {
        const i = JSON.parse(typeof n.data == "string" ? n.data : n.data.toString());
        switch (i.type) {
          case "registered":
            this.setState("connected"), this.startHeartbeat(), t();
            break;
          case "message":
            this.handleIncomingMessage(i.envelope);
            break;
          case "receipt": {
            const a = i.receipt, o = this.pendingReceipts.get(a.messageId);
            o && (this.pendingReceipts.delete(a.messageId), o(a));
            for (const l of this.receiptCallbacks)
              l(a);
            break;
          }
          case "pong":
            this.handlePong();
            break;
          case "error":
            this.state === "connecting" && (this.setState("error"), r(new Error(`Relay error: ${i.message}`)));
            break;
        }
      }, this.ws.onerror = () => {
        this.state === "connecting" && (this.setState("error"), r(new Error(`WebSocket connection failed to ${this.relayUrl}`)));
      }, this.ws.onclose = () => {
        this.setState("disconnected");
      };
    });
  }
  async disconnect() {
    this.stopHeartbeat(), this.ws && (this.ws.close(), this.ws = null), this.setState("disconnected");
  }
  getState() {
    return this.state;
  }
  startHeartbeat() {
    this.stopHeartbeat(), this.heartbeatInterval = setInterval(() => {
      if (this.state !== "connected" || !this.ws) {
        this.stopHeartbeat();
        return;
      }
      this.ws.send(JSON.stringify({ type: "ping" })), this.heartbeatTimeout = setTimeout(() => {
        this.stopHeartbeat(), this.ws && (this.ws.close(), this.ws = null), this.setState("disconnected");
      }, this.HEARTBEAT_TIMEOUT_MS);
    }, this.HEARTBEAT_INTERVAL_MS);
  }
  stopHeartbeat() {
    this.heartbeatInterval && (clearInterval(this.heartbeatInterval), this.heartbeatInterval = null), this.heartbeatTimeout && (clearTimeout(this.heartbeatTimeout), this.heartbeatTimeout = null);
  }
  /**
   * Process incoming message: await all callbacks, then ACK.
   * Extracted from onmessage handler so callbacks can be async.
   */
  async handleIncomingMessage(e) {
    let t = !1;
    for (const r of this.messageCallbacks)
      try {
        await r(e), t = !0;
      } catch (n) {
        console.error("Message callback error:", n);
      }
    t && this.ws && this.ws.send(JSON.stringify({ type: "ack", messageId: e.id }));
  }
  handlePong() {
    this.heartbeatTimeout && (clearTimeout(this.heartbeatTimeout), this.heartbeatTimeout = null);
  }
  async send(e) {
    if (this.state !== "connected" || !this.ws)
      throw new Error("WebSocketMessagingAdapter: must call connect() before send()");
    return new Promise((t, r) => {
      const n = this.SEND_TIMEOUT_MS > 0 ? setTimeout(() => {
        this.pendingReceipts.delete(e.id), r(new Error(`Send timeout: no receipt from relay after ${this.SEND_TIMEOUT_MS}ms`));
      }, this.SEND_TIMEOUT_MS) : null;
      this.pendingReceipts.set(e.id, (i) => {
        n && clearTimeout(n), t(i);
      }), this.ws.send(JSON.stringify({ type: "send", envelope: e }));
    });
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
    this.transportMap.set(e, t);
  }
  async resolveTransport(e) {
    return this.transportMap.get(e) ?? null;
  }
}
class rn extends Pt {
  // spaceId -> Set<DID>
  constructor(t, r, n) {
    super();
    c(this, "messaging");
    c(this, "identity");
    c(this, "groupKeyService");
    c(this, "ready", !1);
    c(this, "readyResolve");
    c(this, "readyPromise");
    c(this, "unsubMessage");
    // Document -> Space mapping (needed to find the right group key)
    c(this, "docToSpace", /* @__PURE__ */ new Map());
    // Known peers per space
    c(this, "spacePeers", /* @__PURE__ */ new Map());
    this.messaging = t, this.identity = r, this.groupKeyService = n, this.readyPromise = new Promise((i) => {
      this.readyResolve = i;
    });
  }
  // --- NetworkAdapter interface ---
  isReady() {
    return this.ready;
  }
  whenReady() {
    return this.readyPromise;
  }
  connect(t, r) {
    var n;
    this.peerId = t, this.peerMetadata = r, this.unsubMessage = this.messaging.onMessage(async (i) => {
      if (i.type === "content")
        try {
          const a = JSON.parse(i.payload);
          if (!a.syncData) return;
          const o = a.spaceId, l = a.generation, d = this.groupKeyService.getKeyByGeneration(o, l);
          if (!d) {
            console.warn(`No group key for space ${o} generation ${l}`);
            return;
          }
          const f = {
            ciphertext: new Uint8Array(a.ciphertext),
            nonce: new Uint8Array(a.nonce),
            spaceId: o,
            generation: l,
            fromDid: i.fromDid
          }, u = await Ee.decryptChange(f, d), h = a.documentId;
          if (!h) return;
          const y = {
            type: a.messageType || "sync",
            senderId: i.fromDid,
            targetId: this.peerId,
            documentId: h,
            data: u
          };
          this.emit("message", y);
        } catch (a) {
          console.debug("EncryptedMessagingNetworkAdapter: failed to process message", a);
        }
    }), this.ready = !0, (n = this.readyResolve) == null || n.call(this), this.emit("ready", void 0);
  }
  send(t) {
    if (!this.ready || !t.data || !t.documentId) return;
    const r = this.docToSpace.get(t.documentId);
    if (!r) return;
    const n = this.groupKeyService.getCurrentKey(r);
    if (!n) return;
    const i = this.groupKeyService.getCurrentGeneration(r);
    (async () => {
      try {
        const a = await Ee.encryptChange(
          t.data,
          n,
          r,
          i,
          this.identity.getDid()
        ), o = {
          syncData: !0,
          spaceId: r,
          documentId: t.documentId,
          messageType: t.type,
          generation: i,
          ciphertext: Array.from(a.ciphertext),
          nonce: Array.from(a.nonce)
        }, l = {
          v: 1,
          id: crypto.randomUUID(),
          type: "content",
          fromDid: this.identity.getDid(),
          toDid: t.targetId,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          encoding: "json",
          payload: JSON.stringify(o),
          signature: ""
        };
        await this.messaging.send(l);
      } catch {
      }
    })();
  }
  disconnect() {
    var t;
    (t = this.unsubMessage) == null || t.call(this), this.unsubMessage = void 0, this.ready = !1;
  }
  // --- Space/Document registration ---
  /**
   * Register a document -> space mapping.
   * Needed so we can look up the right group key when sending/receiving.
   */
  registerDocument(t, r) {
    this.docToSpace.set(t, r);
  }
  /**
   * Unregister a document mapping.
   */
  unregisterDocument(t) {
    this.docToSpace.delete(t);
  }
  /**
   * Register a peer (DID) as a member of a space.
   * Emits peer-candidate so automerge-repo starts syncing with this peer.
   */
  registerSpacePeer(t, r) {
    let n = this.spacePeers.get(t);
    n || (n = /* @__PURE__ */ new Set(), this.spacePeers.set(t, n)), !n.has(r) && (n.add(r), this.emit("peer-candidate", {
      peerId: r,
      peerMetadata: { isEphemeral: !0 }
    }));
  }
  /**
   * Unregister a peer from a space.
   */
  unregisterSpacePeer(t, r) {
    const n = this.spacePeers.get(t);
    if (n) {
      n.delete(r);
      for (const [, i] of this.spacePeers)
        if (i.has(r)) return;
      this.emit("peer-disconnected", { peerId: r });
    }
  }
}
class nn {
  constructor(e, t) {
    c(this, "id");
    c(this, "spaceState");
    c(this, "docHandle");
    c(this, "remoteUpdateCallbacks", /* @__PURE__ */ new Set());
    c(this, "closed", !1);
    c(this, "localChanging", !1);
    c(this, "unsubChange");
    this.id = e.info.id, this.spaceState = e, this.docHandle = t;
    const r = () => {
      this.localChanging || this._notifyRemoteUpdate();
    };
    this.docHandle.on("change", r), this.unsubChange = () => this.docHandle.off("change", r);
  }
  info() {
    return { ...this.spaceState.info };
  }
  getDoc() {
    return this.docHandle.doc();
  }
  transact(e) {
    if (this.closed) throw new Error("Handle is closed");
    this.localChanging = !0;
    try {
      this.docHandle.change(e);
    } finally {
      this.localChanging = !1;
    }
  }
  onRemoteUpdate(e) {
    return this.remoteUpdateCallbacks.add(e), () => {
      this.remoteUpdateCallbacks.delete(e);
    };
  }
  _notifyRemoteUpdate() {
    for (const e of this.remoteUpdateCallbacks)
      e();
  }
  close() {
    var e;
    this.closed = !0, (e = this.unsubChange) == null || e.call(this), this.remoteUpdateCallbacks.clear(), this.spaceState.handles.delete(this);
  }
}
class An {
  constructor(e) {
    c(this, "identity");
    c(this, "messaging");
    c(this, "groupKeyService");
    c(this, "metadataStorage");
    c(this, "repoStorage");
    c(this, "spaces", /* @__PURE__ */ new Map());
    c(this, "state", "idle");
    c(this, "memberChangeCallbacks", /* @__PURE__ */ new Set());
    c(this, "spacesSubscribers", /* @__PURE__ */ new Set());
    c(this, "unsubscribeMessaging", null);
    c(this, "repo");
    c(this, "networkAdapter");
    this.identity = e.identity, this.messaging = e.messaging, this.groupKeyService = e.groupKeyService, this.metadataStorage = e.metadataStorage ?? null, this.repoStorage = e.repoStorage;
  }
  async start() {
    this.networkAdapter = new rn(
      this.messaging,
      this.identity,
      this.groupKeyService
    ), this.repo = new Bt({
      peerId: this.identity.getDid(),
      network: [this.networkAdapter],
      storage: this.repoStorage,
      // Share all documents with all peers (our NetworkAdapter handles routing)
      sharePolicy: async () => !0
    }), await this.restoreSpacesFromMetadata(), this.state = "idle", this._notifySpacesSubscribers(), this.unsubscribeMessaging = this.messaging.onMessage(
      (e) => this.handleMessage(e)
    );
  }
  /**
   * Restore spaces from metadata storage.
   * Called on start() and can be called again after remote sync
   * delivers new space metadata (e.g. multi-device sync).
   * Only loads spaces that aren't already known.
   */
  async restoreSpacesFromMetadata() {
    if (!this.metadataStorage || !this.repo) return;
    const e = await this.metadataStorage.loadAllSpaceMetadata();
    let t = !1;
    for (const r of e) {
      if (this.spaces.has(r.info.id)) continue;
      const n = /* @__PURE__ */ new Map();
      for (const [o, l] of Object.entries(r.memberEncryptionKeys))
        n.set(o, l);
      const i = {
        info: r.info,
        documentId: r.documentId,
        documentUrl: r.documentUrl,
        handles: /* @__PURE__ */ new Set(),
        memberEncryptionKeys: n
      };
      this.spaces.set(r.info.id, i), this.networkAdapter.registerDocument(i.documentId, r.info.id);
      for (const o of r.info.members)
        o !== this.identity.getDid() && this.networkAdapter.registerSpacePeer(r.info.id, o);
      try {
        const o = new AbortController(), l = setTimeout(() => o.abort(), 5e3), d = await this.repo.find(i.documentUrl, {
          allowableStates: ["ready", "unavailable"],
          signal: o.signal
        });
        if (clearTimeout(l), !d.isReady()) {
          console.warn("[ReplicationAdapter] Doc unavailable for space:", r.info.name, "- removing stale entry"), this.spaces.delete(r.info.id), this.metadataStorage.deleteSpaceMetadata(r.info.id), this.metadataStorage.deleteGroupKeys(r.info.id);
          continue;
        }
      } catch {
        console.warn("[ReplicationAdapter] Failed to load doc for space:", r.info.name, "- removing stale entry"), this.spaces.delete(r.info.id), this.metadataStorage.deleteSpaceMetadata(r.info.id), this.metadataStorage.deleteGroupKeys(r.info.id);
        continue;
      }
      const a = await this.metadataStorage.loadGroupKeys(r.info.id);
      for (const o of a)
        this.groupKeyService.importKey(o.spaceId, o.key, o.generation);
      t = !0, console.log("[ReplicationAdapter] Restored space from metadata:", r.info.name || r.info.id);
    }
    t && this._notifySpacesSubscribers();
  }
  async stop() {
    this.unsubscribeMessaging && (this.unsubscribeMessaging(), this.unsubscribeMessaging = null);
    for (const e of this.spaces.values())
      for (const t of e.handles)
        t.close();
    this.repo && (this.networkAdapter.disconnect(), await this.repo.shutdown()), this.state = "idle";
  }
  getState() {
    return this.state;
  }
  async createSpace(e, t, r) {
    const n = crypto.randomUUID(), i = this.repo.create(t);
    await i.whenReady(), await this.groupKeyService.createKey(n), this.networkAdapter.registerDocument(i.documentId, n);
    const a = {
      id: n,
      type: e,
      name: r == null ? void 0 : r.name,
      description: r == null ? void 0 : r.description,
      members: [this.identity.getDid()],
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }, o = {
      info: a,
      documentId: i.documentId,
      documentUrl: i.url,
      handles: /* @__PURE__ */ new Set(),
      memberEncryptionKeys: /* @__PURE__ */ new Map()
    };
    return this.spaces.set(n, o), this._notifySpacesSubscribers(), await this._persistSpaceMetadata(o), await this.repo.flush([i.documentId]), { ...a };
  }
  async getSpaces() {
    return this._getSpacesSnapshot();
  }
  watchSpaces() {
    return {
      subscribe: (e) => (this.spacesSubscribers.add(e), () => {
        this.spacesSubscribers.delete(e);
      }),
      getValue: () => this._getSpacesSnapshot()
    };
  }
  _getSpacesSnapshot() {
    return Array.from(this.spaces.values()).map((e) => ({ ...e.info }));
  }
  _notifySpacesSubscribers() {
    const e = this._getSpacesSnapshot();
    for (const t of this.spacesSubscribers)
      t(e);
  }
  async getSpace(e) {
    const t = this.spaces.get(e);
    return t ? { ...t.info } : null;
  }
  async openSpace(e) {
    const t = this.spaces.get(e);
    if (!t)
      throw new Error(`Unknown space: ${e}`);
    const r = await this.repo.find(t.documentUrl);
    await r.whenReady();
    const n = new nn(t, r);
    return t.handles.add(n), n;
  }
  async addMember(e, t, r) {
    const n = this.spaces.get(e);
    if (!n) throw new Error(`Unknown space: ${e}`);
    n.info.members.includes(t) || (n.info.members.push(t), this._notifySpacesSubscribers()), n.memberEncryptionKeys.set(t, r), this.networkAdapter.registerSpacePeer(e, t);
    const i = this.groupKeyService.getCurrentKey(e);
    if (!i) throw new Error(`No group key for space: ${e}`);
    const a = this.groupKeyService.getCurrentGeneration(e), o = await this.identity.encryptForRecipient(
      i,
      r
    ), l = await this.repo.export(n.documentUrl);
    if (!l) throw new Error(`Cannot export doc for space: ${e}`);
    const d = await Ee.encryptChange(
      l,
      i,
      e,
      a,
      this.identity.getDid()
    ), f = {
      spaceId: e,
      spaceType: n.info.type,
      spaceName: n.info.name,
      members: n.info.members,
      createdAt: n.info.createdAt,
      generation: a,
      documentUrl: n.documentUrl,
      encryptedGroupKey: {
        ciphertext: Array.from(o.ciphertext),
        nonce: Array.from(o.nonce),
        ephemeralPublicKey: Array.from(o.ephemeralPublicKey)
      },
      encryptedDoc: {
        ciphertext: Array.from(d.ciphertext),
        nonce: Array.from(d.nonce)
      }
    }, u = {
      v: 1,
      id: crypto.randomUUID(),
      type: "space-invite",
      fromDid: this.identity.getDid(),
      toDid: t,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      encoding: "json",
      payload: JSON.stringify(f),
      signature: ""
    };
    await this.messaging.send(u);
    for (const h of n.info.members) {
      if (h === this.identity.getDid() || h === t) continue;
      const y = {
        spaceId: e,
        action: "added",
        memberDid: t,
        members: n.info.members
      }, b = {
        v: 1,
        id: crypto.randomUUID(),
        type: "member-update",
        fromDid: this.identity.getDid(),
        toDid: h,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        encoding: "json",
        payload: JSON.stringify(y),
        signature: ""
      };
      await this.messaging.send(b);
    }
    await this._persistSpaceMetadata(n);
    for (const h of this.memberChangeCallbacks)
      h({ spaceId: e, did: t, action: "added" });
  }
  async removeMember(e, t) {
    const r = this.spaces.get(e);
    if (!r) throw new Error(`Unknown space: ${e}`);
    r.info.members = r.info.members.filter((a) => a !== t), r.memberEncryptionKeys.delete(t), this._notifySpacesSubscribers(), this.networkAdapter.unregisterSpacePeer(e, t);
    const n = await this.groupKeyService.rotateKey(e), i = this.groupKeyService.getCurrentGeneration(e);
    for (const [a, o] of r.memberEncryptionKeys.entries()) {
      if (a === this.identity.getDid()) continue;
      const l = await this.identity.encryptForRecipient(n, o), d = {
        spaceId: e,
        generation: i,
        encryptedGroupKey: {
          ciphertext: Array.from(l.ciphertext),
          nonce: Array.from(l.nonce),
          ephemeralPublicKey: Array.from(l.ephemeralPublicKey)
        }
      }, f = {
        v: 1,
        id: crypto.randomUUID(),
        type: "group-key-rotation",
        fromDid: this.identity.getDid(),
        toDid: a,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        encoding: "json",
        payload: JSON.stringify(d),
        signature: ""
      };
      await this.messaging.send(f);
    }
    for (const a of r.info.members) {
      if (a === this.identity.getDid()) continue;
      const o = {
        spaceId: e,
        action: "removed",
        memberDid: t,
        members: r.info.members
      }, l = {
        v: 1,
        id: crypto.randomUUID(),
        type: "member-update",
        fromDid: this.identity.getDid(),
        toDid: a,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        encoding: "json",
        payload: JSON.stringify(o),
        signature: ""
      };
      await this.messaging.send(l);
    }
    await this._persistSpaceMetadata(r);
    for (const a of this.memberChangeCallbacks)
      a({ spaceId: e, did: t, action: "removed" });
  }
  onMemberChange(e) {
    return this.memberChangeCallbacks.add(e), () => {
      this.memberChangeCallbacks.delete(e);
    };
  }
  getKeyGeneration(e) {
    return this.groupKeyService.getCurrentGeneration(e);
  }
  async requestSync(e) {
  }
  async _persistSpaceMetadata(e) {
    if (!this.metadataStorage) return;
    const t = {};
    for (const [n, i] of e.memberEncryptionKeys.entries())
      t[n] = i;
    await this.metadataStorage.saveSpaceMetadata({
      info: e.info,
      documentId: e.documentId,
      documentUrl: e.documentUrl,
      memberEncryptionKeys: t
    });
    const r = this.groupKeyService.getCurrentGeneration(e.info.id);
    for (let n = 0; n <= r; n++) {
      const i = this.groupKeyService.getKeyByGeneration(e.info.id, n);
      i && i.length > 0 && await this.metadataStorage.saveGroupKey({ spaceId: e.info.id, generation: n, key: i });
    }
  }
  async handleMessage(e) {
    switch (e.type) {
      case "space-invite":
        await this.handleSpaceInvite(e);
        break;
      case "group-key-rotation":
        await this.handleKeyRotation(e);
        break;
      case "member-update":
        await this.handleMemberUpdate(e);
        break;
    }
  }
  async handleSpaceInvite(e) {
    const t = JSON.parse(e.payload), r = {
      ciphertext: new Uint8Array(t.encryptedGroupKey.ciphertext),
      nonce: new Uint8Array(t.encryptedGroupKey.nonce),
      ephemeralPublicKey: new Uint8Array(t.encryptedGroupKey.ephemeralPublicKey)
    }, n = await this.identity.decryptForMe(r);
    this.groupKeyService.importKey(t.spaceId, n, t.generation);
    const i = {
      ciphertext: new Uint8Array(t.encryptedDoc.ciphertext),
      nonce: new Uint8Array(t.encryptedDoc.nonce),
      spaceId: t.spaceId,
      generation: t.generation,
      fromDid: e.fromDid
    }, a = await Ee.decryptChange(i, n), { documentId: o } = Ot(t.documentUrl), l = this.repo.import(a, { docId: o });
    l.isReady() || l.doneLoading(), this.networkAdapter.registerDocument(l.documentId, t.spaceId);
    const d = t.members || [];
    for (const h of d)
      h !== this.identity.getDid() && this.networkAdapter.registerSpacePeer(t.spaceId, h);
    const u = {
      info: {
        id: t.spaceId,
        type: t.spaceType,
        name: t.spaceName,
        members: d,
        createdAt: t.createdAt
      },
      documentId: l.documentId,
      documentUrl: l.url,
      handles: /* @__PURE__ */ new Set(),
      memberEncryptionKeys: /* @__PURE__ */ new Map()
    };
    this.spaces.set(t.spaceId, u), this._notifySpacesSubscribers(), await this._persistSpaceMetadata(u), await this.repo.flush([l.documentId]);
    for (const h of this.memberChangeCallbacks)
      h({ spaceId: t.spaceId, did: this.identity.getDid(), action: "added" });
  }
  async handleKeyRotation(e) {
    const t = JSON.parse(e.payload), r = {
      ciphertext: new Uint8Array(t.encryptedGroupKey.ciphertext),
      nonce: new Uint8Array(t.encryptedGroupKey.nonce),
      ephemeralPublicKey: new Uint8Array(t.encryptedGroupKey.ephemeralPublicKey)
    }, n = await this.identity.decryptForMe(r);
    this.groupKeyService.importKey(t.spaceId, n, t.generation);
    const i = this.spaces.get(t.spaceId);
    i && await this._persistSpaceMetadata(i);
  }
  async handleMemberUpdate(e) {
    const t = JSON.parse(e.payload), r = this.spaces.get(t.spaceId);
    if (!r) return;
    const n = new Set(r.info.members);
    r.info.members = t.members, this._notifySpacesSubscribers();
    for (const i of t.members)
      i !== this.identity.getDid() && !n.has(i) && this.networkAdapter.registerSpacePeer(t.spaceId, i);
    for (const i of n)
      t.members.includes(i) || this.networkAdapter.unregisterSpacePeer(t.spaceId, i);
    await this._persistSpaceMetadata(r);
    for (const i of t.members)
      if (!n.has(i))
        for (const a of this.memberChangeCallbacks)
          a({ spaceId: t.spaceId, did: i, action: "added" });
    for (const i of n)
      if (!t.members.includes(i))
        for (const a of this.memberChangeCallbacks)
          a({ spaceId: t.spaceId, did: i, action: "removed" });
  }
}
class En {
  constructor(e) {
    c(this, "TIMEOUT_MS", 5e3);
    this.baseUrl = e;
  }
  fetchWithTimeout(e, t) {
    const r = new AbortController(), n = setTimeout(() => r.abort(), this.TIMEOUT_MS);
    return fetch(e, { ...t, signal: r.signal }).finally(() => clearTimeout(n));
  }
  async publishProfile(e, t) {
    const r = await t.signJws(e), n = await this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(e.did)}`,
      { method: "PUT", body: r, headers: { "Content-Type": "text/plain" } }
    );
    if (!n.ok) throw new Error(`Profile upload failed: ${n.status}`);
  }
  async publishVerifications(e, t) {
    const r = await t.signJws(e), n = await this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(e.did)}/v`,
      { method: "PUT", body: r, headers: { "Content-Type": "text/plain" } }
    );
    if (!n.ok) throw new Error(`Verifications upload failed: ${n.status}`);
  }
  async publishAttestations(e, t) {
    const r = await t.signJws(e), n = await this.fetchWithTimeout(
      `${this.baseUrl}/p/${encodeURIComponent(e.did)}/a`,
      { method: "PUT", body: r, headers: { "Content-Type": "text/plain" } }
    );
    if (!n.ok) throw new Error(`Attestations upload failed: ${n.status}`);
  }
  async resolveProfile(e) {
    const t = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}`);
    if (t.status === 404) return { profile: null, fromCache: !1 };
    if (!t.ok) throw new Error(`Profile fetch failed: ${t.status}`);
    const r = await t.text(), n = await ze.verifyProfile(r);
    return { profile: n.valid && n.profile ? n.profile : null, fromCache: !1 };
  }
  async resolveVerifications(e) {
    const t = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/v`);
    if (t.status === 404) return [];
    if (!t.ok) throw new Error(`Verifications fetch failed: ${t.status}`);
    const r = await t.text(), n = await ze.verifyProfile(r);
    return !n.valid || !n.profile ? [] : n.profile.verifications ?? [];
  }
  async resolveAttestations(e) {
    const t = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/a`);
    if (t.status === 404) return [];
    if (!t.ok) throw new Error(`Attestations fetch failed: ${t.status}`);
    const r = await t.text(), n = await ze.verifyProfile(r);
    return !n.valid || !n.profile ? [] : n.profile.attestations ?? [];
  }
  async resolveSummaries(e) {
    const t = e.map((n) => encodeURIComponent(n)).join(","), r = await this.fetchWithTimeout(`${this.baseUrl}/s?dids=${t}`);
    if (!r.ok) throw new Error(`Summary fetch failed: ${r.status}`);
    return r.json();
  }
}
class Kn {
  constructor(e, t, r) {
    c(this, "_lastError", null);
    c(this, "_errorListeners", []);
    this.inner = e, this.publishState = t, this.graphCache = r;
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
    } catch (r) {
      this.setError(r);
    }
  }
  async publishVerifications(e, t) {
    await this.publishState.markDirty(e.did, "verifications");
    try {
      await this.inner.publishVerifications(e, t), await this.publishState.clearDirty(e.did, "verifications"), this.clearError();
    } catch (r) {
      this.setError(r);
    }
  }
  async publishAttestations(e, t) {
    await this.publishState.markDirty(e.did, "attestations");
    try {
      await this.inner.publishAttestations(e, t), await this.publishState.clearDirty(e.did, "attestations"), this.clearError();
    } catch (r) {
      this.setError(r);
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
          ...t.encryptionPublicKey ? { encryptionPublicKey: t.encryptionPublicKey } : {},
          updatedAt: t.fetchedAt
        },
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
   * @param identity - The unlocked WotIdentity (needed for JWS signing)
   * @param getPublishData - Callback that reads current local data at retry time
   *                         (not stale data from the original publish attempt)
   */
  async syncPending(e, t, r) {
    const n = await this.publishState.getDirtyFields(e);
    if (n.size === 0) return;
    const i = await r();
    if (n.has("profile") && i.profile)
      try {
        await this.inner.publishProfile(i.profile, t), await this.publishState.clearDirty(e, "profile"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
    if (n.has("verifications") && i.verifications)
      try {
        await this.inner.publishVerifications(i.verifications, t), await this.publishState.clearDirty(e, "verifications"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
    if (n.has("attestations") && i.attestations)
      try {
        await this.inner.publishAttestations(i.attestations, t), await this.publishState.clearDirty(e, "attestations"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
  }
}
class In {
  constructor() {
    c(this, "dirty", /* @__PURE__ */ new Map());
  }
  async markDirty(e, t) {
    const r = this.dirty.get(e) ?? /* @__PURE__ */ new Set();
    r.add(t), this.dirty.set(e, r);
  }
  async clearDirty(e, t) {
    const r = this.dirty.get(e);
    r && (r.delete(t), r.size === 0 && this.dirty.delete(e));
  }
  async getDirtyFields(e) {
    return new Set(this.dirty.get(e) ?? []);
  }
}
class Un {
  constructor() {
    c(this, "profiles", /* @__PURE__ */ new Map());
    c(this, "verifications", /* @__PURE__ */ new Map());
    c(this, "attestations", /* @__PURE__ */ new Map());
    c(this, "fetchedAt", /* @__PURE__ */ new Map());
    c(this, "summaryCounts", /* @__PURE__ */ new Map());
  }
  async cacheEntry(e, t, r, n) {
    t && this.profiles.set(e, t), this.verifications.set(e, r), this.attestations.set(e, n), this.fetchedAt.set(e, (/* @__PURE__ */ new Date()).toISOString()), this.summaryCounts.delete(e);
  }
  async getEntry(e) {
    const t = this.fetchedAt.get(e);
    if (!t) return null;
    const r = this.profiles.get(e), n = this.verifications.get(e) ?? [], i = this.attestations.get(e) ?? [], a = this.summaryCounts.get(e);
    return {
      did: e,
      name: r == null ? void 0 : r.name,
      bio: r == null ? void 0 : r.bio,
      avatar: r == null ? void 0 : r.avatar,
      encryptionPublicKey: r == null ? void 0 : r.encryptionPublicKey,
      verificationCount: (a == null ? void 0 : a.verificationCount) ?? n.length,
      attestationCount: (a == null ? void 0 : a.attestationCount) ?? i.length,
      verifierDids: n.map((o) => o.from),
      fetchedAt: t
    };
  }
  async getEntries(e) {
    const t = /* @__PURE__ */ new Map();
    for (const r of e) {
      const n = await this.getEntry(r);
      n && t.set(r, n);
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
    var r;
    const t = /* @__PURE__ */ new Map();
    for (const n of e) {
      const i = (r = this.profiles.get(n)) == null ? void 0 : r.name;
      i && t.set(n, i);
    }
    return t;
  }
  async findMutualContacts(e, t) {
    const r = this.verifications.get(e) ?? [], n = new Set(r.map((i) => i.from));
    return t.filter((i) => n.has(i));
  }
  async search(e) {
    var n, i;
    const t = e.toLowerCase(), r = [];
    for (const [a] of this.fetchedAt) {
      const o = this.profiles.get(a), l = (n = o == null ? void 0 : o.name) == null ? void 0 : n.toLowerCase().includes(t), d = (i = o == null ? void 0 : o.bio) == null ? void 0 : i.toLowerCase().includes(t), u = (this.attestations.get(a) ?? []).some((h) => h.claim.toLowerCase().includes(t));
      if (l || d || u) {
        const h = await this.getEntry(a);
        h && r.push(h);
      }
    }
    return r;
  }
  async updateSummary(e, t, r, n) {
    if (t !== null) {
      const i = this.profiles.get(e);
      this.profiles.set(e, {
        did: e,
        name: t,
        ...i != null && i.bio ? { bio: i.bio } : {},
        ...i != null && i.avatar ? { avatar: i.avatar } : {},
        updatedAt: (i == null ? void 0 : i.updatedAt) ?? (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    this.summaryCounts.set(e, { verificationCount: r, attestationCount: n }), this.fetchedAt.has(e) || this.fetchedAt.set(e, (/* @__PURE__ */ new Date()).toISOString());
  }
  async evict(e) {
    this.profiles.delete(e), this.verifications.delete(e), this.attestations.delete(e), this.fetchedAt.delete(e), this.summaryCounts.delete(e);
  }
  async clear() {
    this.profiles.clear(), this.verifications.clear(), this.attestations.clear(), this.fetchedAt.clear(), this.summaryCounts.clear();
  }
}
class Dn {
  constructor(e, t, r) {
    c(this, "flushing", !1);
    c(this, "skipTypes");
    c(this, "sendTimeoutMs");
    c(this, "reconnectIntervalMs");
    c(this, "isOnline");
    c(this, "reconnectTimer", null);
    c(this, "myDid", null);
    c(this, "unsubscribeStateChange", null);
    this.inner = e, this.outbox = t, this.skipTypes = new Set((r == null ? void 0 : r.skipTypes) ?? ["profile-update"]), this.sendTimeoutMs = (r == null ? void 0 : r.sendTimeoutMs) ?? 15e3, this.reconnectIntervalMs = (r == null ? void 0 : r.reconnectIntervalMs) ?? 1e4, this.isOnline = (r == null ? void 0 : r.isOnline) ?? (() => !0);
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
    return this.sendTimeoutMs <= 0 ? this.inner.send(e) : new Promise((t, r) => {
      const n = setTimeout(() => {
        r(new Error(`Send timeout after ${this.sendTimeoutMs}ms`));
      }, this.sendTimeoutMs);
      this.inner.send(e).then(
        (i) => {
          clearTimeout(n), t(i);
        },
        (i) => {
          clearTimeout(n), r(i);
        }
      );
    });
  }
}
class Mn {
  constructor() {
    c(this, "entries", /* @__PURE__ */ new Map());
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
class Tn {
  constructor() {
    c(this, "spaces", /* @__PURE__ */ new Map());
    c(this, "groupKeys", /* @__PURE__ */ new Map());
  }
  async saveSpace(e) {
    this.spaces.set(e.info.id, e);
  }
  async loadSpace(e) {
    return this.spaces.get(e) ?? null;
  }
  async loadAllSpaces() {
    return Array.from(this.spaces.values());
  }
  async deleteSpace(e) {
    this.spaces.delete(e);
  }
  async saveGroupKey(e) {
    const t = this.groupKeys.get(e.spaceId) ?? [], r = t.findIndex((n) => n.generation === e.generation);
    r >= 0 ? t[r] = e : t.push(e), this.groupKeys.set(e.spaceId, t);
  }
  async loadGroupKeys(e) {
    return this.groupKeys.get(e) ?? [];
  }
  async deleteGroupKeys(e) {
    this.groupKeys.delete(e);
  }
}
class Cn {
  constructor() {
    c(this, "spaces", /* @__PURE__ */ new Map());
    c(this, "groupKeys", /* @__PURE__ */ new Map());
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
    const t = this.groupKeys.get(e.spaceId) ?? [], r = t.findIndex((n) => n.generation === e.generation);
    r >= 0 ? t[r] = e : t.push(e), this.groupKeys.set(e.spaceId, t);
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
const sn = "wot-space-metadata", an = 1, $ = "spaces", j = "groupKeys";
function on(s, e) {
  return `${s}:${e}`;
}
class zn {
  constructor(e = sn) {
    c(this, "dbPromise");
    this.dbPromise = tt(e, an, {
      upgrade(t) {
        t.objectStoreNames.contains($) || t.createObjectStore($, { keyPath: "info.id" }), t.objectStoreNames.contains(j) || t.createObjectStore(j, { keyPath: "id" }).createIndex("bySpaceId", "spaceId");
      }
    });
  }
  async saveSpaceMetadata(e) {
    const t = await this.dbPromise, r = {
      info: e.info,
      documentId: e.documentId,
      documentUrl: e.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(e.memberEncryptionKeys).map(
          ([n, i]) => [n, Array.from(i)]
        )
      )
    };
    await t.put($, r);
  }
  async loadSpaceMetadata(e) {
    const r = await (await this.dbPromise).get($, e);
    return r ? this.deserialize(r) : null;
  }
  async loadAllSpaceMetadata() {
    return (await (await this.dbPromise).getAll($)).map((r) => this.deserialize(r));
  }
  async deleteSpaceMetadata(e) {
    await (await this.dbPromise).delete($, e);
  }
  async saveGroupKey(e) {
    const t = await this.dbPromise, r = {
      id: on(e.spaceId, e.generation),
      spaceId: e.spaceId,
      generation: e.generation,
      key: Array.from(e.key)
    };
    await t.put(j, r);
  }
  async loadGroupKeys(e) {
    return (await (await this.dbPromise).getAllFromIndex(j, "bySpaceId", e)).map((n) => ({
      spaceId: n.spaceId,
      generation: n.generation,
      key: new Uint8Array(n.key)
    }));
  }
  async deleteGroupKeys(e) {
    const t = await this.dbPromise, r = await t.getAllKeysFromIndex(j, "bySpaceId", e), n = t.transaction(j, "readwrite");
    for (const i of r)
      await n.store.delete(i);
    await n.done;
  }
  async clearAll() {
    const t = (await this.dbPromise).transaction([$, j], "readwrite");
    await t.objectStore($).clear(), await t.objectStore(j).clear(), await t.done;
  }
  deserialize(e) {
    return {
      info: e.info,
      documentId: e.documentId,
      documentUrl: e.documentUrl,
      memberEncryptionKeys: Object.fromEntries(
        Object.entries(e.memberEncryptionKeys).map(
          ([t, r]) => [t, new Uint8Array(r)]
        )
      )
    };
  }
}
class Pn {
  constructor(e, t) {
    c(this, "myDid");
    c(this, "sign");
    /** Capabilities granted TO this user (received from others) */
    c(this, "received", []);
    /** Capabilities granted BY this user (issued to others) */
    c(this, "granted", []);
    /** Revoked capability IDs */
    c(this, "revoked", /* @__PURE__ */ new Set());
    this.myDid = e, this.sign = t;
  }
  async grant(e, t, r, n) {
    const i = await Lt(
      {
        issuer: this.myDid,
        audience: t,
        resource: e,
        permissions: r,
        expiration: n
      },
      this.sign
    );
    return this.granted.push(i), i;
  }
  async delegate(e, t, r, n) {
    const i = se(e);
    if (!i) throw new Error("Invalid parent capability");
    const a = n ?? i.expiration, o = await Gt(
      e,
      { audience: t, permissions: r, expiration: a },
      this.sign
    );
    return this.granted.push(o), o;
  }
  async verify(e) {
    const t = await nt(e);
    if (!t.valid) return t;
    if (this.revoked.has(t.capability.id))
      return { valid: !1, error: `Capability ${t.capability.id} has been revoked` };
    for (const r of t.chain)
      if (this.revoked.has(r.id))
        return { valid: !1, error: `Ancestor capability ${r.id} has been revoked` };
    return t;
  }
  async canAccess(e, t, r) {
    const n = [...this.received, ...this.granted];
    for (const i of n) {
      const a = se(i);
      if (!a || a.audience !== e || a.resource !== t || !a.permissions.includes(r)) continue;
      if ((await this.verify(i)).valid) return !0;
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
      const r = se(t);
      return r && r.resource === e;
    }) : [...this.received];
  }
  async getGrantedCapabilities(e) {
    return e ? this.granted.filter((t) => {
      const r = se(t);
      return r && r.resource === e;
    }) : [...this.granted];
  }
}
export {
  kn as AttestationDeliveryService,
  An as AutomergeReplicationAdapter,
  rn as EncryptedMessagingNetworkAdapter,
  Ee as EncryptedSyncService,
  wn as GraphCacheService,
  mn as GroupKeyService,
  En as HttpDiscoveryAdapter,
  Pn as InMemoryAuthorizationAdapter,
  Un as InMemoryGraphCacheStore,
  et as InMemoryMessagingAdapter,
  Mn as InMemoryOutboxStore,
  In as InMemoryPublishStateStore,
  Cn as InMemorySpaceMetadataStorage,
  Tn as InMemorySpaceStorageAdapter,
  zn as IndexedDBSpaceMetadataStorage,
  vn as LocalStorageAdapter,
  Kn as OfflineFirstDiscoveryAdapter,
  Dn as OutboxMessagingAdapter,
  ze as ProfileService,
  gn as VerificationHelper,
  Sn as WebCryptoAdapter,
  xn as WebSocketMessagingAdapter,
  bn as WotIdentity,
  Lt as createCapability,
  Ht as createDid,
  dn as createResourceRef,
  _t as decodeBase58,
  G as decodeBase64Url,
  Gt as delegateCapability,
  Ke as didToPublicKeyBytes,
  Nt as encodeBase58,
  L as encodeBase64Url,
  se as extractCapability,
  _e as extractJwsPayload,
  yn as getDefaultDisplayName,
  pn as isValidDid,
  hn as parseResourceRef,
  jt as signJws,
  fn as skipFirst,
  nt as verifyCapability,
  rt as verifyJws
};
