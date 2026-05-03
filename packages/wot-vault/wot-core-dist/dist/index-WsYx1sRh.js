var Oe = Object.defineProperty;
var ke = (r) => {
  throw TypeError(r);
};
var We = (r, e, t) => e in r ? Oe(r, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : r[e] = t;
var c = (r, e, t) => We(r, typeof e != "symbol" ? e + "" : e, t), we = (r, e, t) => e.has(r) || ke("Cannot " + t);
var S = (r, e, t) => (we(r, e, "read from private field"), t ? t.call(r) : e.get(r)), C = (r, e, t) => e.has(r) ? ke("Cannot add the same private member more than once") : e instanceof WeakSet ? e.add(r) : e.set(r, t), $ = (r, e, t, n) => (we(r, e, "write to private field"), n ? n.call(r, t) : e.set(r, t), t);
import { S as Re, W as Je } from "./WebCryptoAdapter-A_OiWZNL.js";
import { s as Ge } from "./jws-8PD3qxx2.js";
import { s as ye } from "./index-D3HkpEuJ.js";
import { e as j, d as T, a as Ze, g as Ye } from "./did-key-CMSqoIj7.js";
import { n as Qe, e as Xe, o as et, j as tt, i as rt, q as nt } from "./attestation-vc-jws-CRBZHOwR.js";
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function it(r) {
  return r instanceof Uint8Array || ArrayBuffer.isView(r) && r.constructor.name === "Uint8Array";
}
function V(r, e = "") {
  if (!Number.isSafeInteger(r) || r < 0) {
    const t = e && `"${e}" `;
    throw new Error(`${t}expected integer >= 0, got ${r}`);
  }
}
function q(r, e, t = "") {
  const n = it(r), i = r == null ? void 0 : r.length, a = e !== void 0;
  if (!n || a && i !== e) {
    const o = t && `"${t}" `, s = a ? ` of length ${e}` : "", h = n ? `length=${i}` : `type=${typeof r}`;
    throw new Error(o + "expected Uint8Array" + s + ", got " + h);
  }
  return r;
}
function Ke(r) {
  if (typeof r != "function" || typeof r.create != "function")
    throw new Error("Hash must wrapped by utils.createHasher");
  V(r.outputLen), V(r.blockLen);
}
function ne(r, e = !0) {
  if (r.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (e && r.finished)
    throw new Error("Hash#digest() has already been called");
}
function at(r, e) {
  q(r, void 0, "digestInto() output");
  const t = e.outputLen;
  if (r.length < t)
    throw new Error('"digestInto() output" expected to be of length >=' + t);
}
function F(...r) {
  for (let e = 0; e < r.length; e++)
    r[e].fill(0);
}
function re(r) {
  return new DataView(r.buffer, r.byteOffset, r.byteLength);
}
function x(r, e) {
  return r << 32 - e | r >>> e;
}
function st(r) {
  if (typeof r != "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(r));
}
function xe(r, e = "") {
  return typeof r == "string" ? st(r) : q(r, void 0, e);
}
function ot(r, e) {
  if (e !== void 0 && {}.toString.call(e) !== "[object Object]")
    throw new Error("options must be object or undefined");
  return Object.assign(r, e);
}
function Pe(r, e = {}) {
  const t = (i, a) => r(a).update(i).digest(), n = r(void 0);
  return t.outputLen = n.outputLen, t.blockLen = n.blockLen, t.create = (i) => r(i), Object.assign(t, e), Object.freeze(t);
}
function ct(r = 32) {
  const e = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof (e == null ? void 0 : e.getRandomValues) != "function")
    throw new Error("crypto.getRandomValues must be defined");
  return e.getRandomValues(new Uint8Array(r));
}
const He = (r) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, r])
});
class Ue {
  constructor(e, t) {
    c(this, "oHash");
    c(this, "iHash");
    c(this, "blockLen");
    c(this, "outputLen");
    c(this, "finished", !1);
    c(this, "destroyed", !1);
    if (Ke(e), q(t, void 0, "key"), this.iHash = e.create(), typeof this.iHash.update != "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen, this.outputLen = this.iHash.outputLen;
    const n = this.blockLen, i = new Uint8Array(n);
    i.set(t.length > n ? e.create().update(t).digest() : t);
    for (let a = 0; a < i.length; a++)
      i[a] ^= 54;
    this.iHash.update(i), this.oHash = e.create();
    for (let a = 0; a < i.length; a++)
      i[a] ^= 106;
    this.oHash.update(i), F(i);
  }
  update(e) {
    return ne(this), this.iHash.update(e), this;
  }
  digestInto(e) {
    ne(this), q(e, this.outputLen, "output"), this.finished = !0, this.iHash.digestInto(e), this.oHash.update(e), this.oHash.digestInto(e), this.destroy();
  }
  digest() {
    const e = new Uint8Array(this.oHash.outputLen);
    return this.digestInto(e), e;
  }
  _cloneInto(e) {
    e || (e = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash: t, iHash: n, finished: i, destroyed: a, blockLen: o, outputLen: s } = this;
    return e = e, e.finished = i, e.destroyed = a, e.blockLen = o, e.outputLen = s, e.oHash = t._cloneInto(e.oHash), e.iHash = n._cloneInto(e.iHash), e;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = !0, this.oHash.destroy(), this.iHash.destroy();
  }
}
const De = (r, e, t) => new Ue(r, e).update(t).digest();
De.create = (r, e) => new Ue(r, e);
function lt(r, e, t, n) {
  Ke(r);
  const i = ot({ dkLen: 32, asyncTick: 10 }, n), { c: a, dkLen: o, asyncTick: s } = i;
  if (V(a, "c"), V(o, "dkLen"), V(s, "asyncTick"), a < 1)
    throw new Error("iterations (c) must be >= 1");
  const h = xe(e, "password"), d = xe(t, "salt"), f = new Uint8Array(o), l = De.create(r, h), u = l._cloneInto().update(d);
  return { c: a, dkLen: o, asyncTick: s, DK: f, PRF: l, PRFSalt: u };
}
function ht(r, e, t, n, i) {
  return r.destroy(), e.destroy(), n && n.destroy(), F(i), t;
}
function ut(r, e, t, n) {
  const { c: i, dkLen: a, DK: o, PRF: s, PRFSalt: h } = lt(r, e, t, n);
  let d;
  const f = new Uint8Array(4), l = re(f), u = new Uint8Array(s.outputLen);
  for (let m = 1, g = 0; g < a; m++, g += s.outputLen) {
    const p = o.subarray(g, g + s.outputLen);
    l.setInt32(0, m, !1), (d = h._cloneInto(d)).update(f).digestInto(u), p.set(u.subarray(0, p.length));
    for (let w = 1; w < i; w++) {
      s._cloneInto(d).update(u).digestInto(u);
      for (let y = 0; y < p.length; y++)
        p[y] ^= u[y];
    }
  }
  return ht(s, h, o, d, u);
}
function dt(r, e, t) {
  return r & e ^ ~r & t;
}
function ft(r, e, t) {
  return r & e ^ r & t ^ e & t;
}
class je {
  constructor(e, t, n, i) {
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
    this.blockLen = e, this.outputLen = t, this.padOffset = n, this.isLE = i, this.buffer = new Uint8Array(e), this.view = re(this.buffer);
  }
  update(e) {
    ne(this), q(e);
    const { view: t, buffer: n, blockLen: i } = this, a = e.length;
    for (let o = 0; o < a; ) {
      const s = Math.min(i - this.pos, a - o);
      if (s === i) {
        const h = re(e);
        for (; i <= a - o; o += i)
          this.process(h, o);
        continue;
      }
      n.set(e.subarray(o, o + s), this.pos), this.pos += s, o += s, this.pos === i && (this.process(t, 0), this.pos = 0);
    }
    return this.length += e.length, this.roundClean(), this;
  }
  digestInto(e) {
    ne(this), at(e, this), this.finished = !0;
    const { buffer: t, view: n, blockLen: i, isLE: a } = this;
    let { pos: o } = this;
    t[o++] = 128, F(this.buffer.subarray(o)), this.padOffset > i - o && (this.process(n, 0), o = 0);
    for (let l = o; l < i; l++)
      t[l] = 0;
    n.setBigUint64(i - 8, BigInt(this.length * 8), a), this.process(n, 0);
    const s = re(e), h = this.outputLen;
    if (h % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const d = h / 4, f = this.get();
    if (d > f.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let l = 0; l < d; l++)
      s.setUint32(4 * l, f[l], a);
  }
  digest() {
    const { buffer: e, outputLen: t } = this;
    this.digestInto(e);
    const n = e.slice(0, t);
    return this.destroy(), n;
  }
  _cloneInto(e) {
    e || (e = new this.constructor()), e.set(...this.get());
    const { blockLen: t, buffer: n, length: i, finished: a, destroyed: o, pos: s } = this;
    return e.destroyed = o, e.finished = a, e.length = i, e.pos = s, i % t && e.buffer.set(n), e;
  }
  clone() {
    return this._cloneInto();
  }
}
const K = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), k = /* @__PURE__ */ Uint32Array.from([
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
]), Q = /* @__PURE__ */ BigInt(2 ** 32 - 1), ze = /* @__PURE__ */ BigInt(32);
function bt(r, e = !1) {
  return e ? { h: Number(r & Q), l: Number(r >> ze & Q) } : { h: Number(r >> ze & Q) | 0, l: Number(r & Q) | 0 };
}
function gt(r, e = !1) {
  const t = r.length;
  let n = new Uint32Array(t), i = new Uint32Array(t);
  for (let a = 0; a < t; a++) {
    const { h: o, l: s } = bt(r[a], e);
    [n[a], i[a]] = [o, s];
  }
  return [n, i];
}
const ve = (r, e, t) => r >>> t, Se = (r, e, t) => r << 32 - t | e >>> t, B = (r, e, t) => r >>> t | e << 32 - t, _ = (r, e, t) => r << 32 - t | e >>> t, X = (r, e, t) => r << 64 - t | e >>> t - 32, ee = (r, e, t) => r >>> t - 32 | e << 64 - t;
function A(r, e, t, n) {
  const i = (e >>> 0) + (n >>> 0);
  return { h: r + t + (i / 2 ** 32 | 0) | 0, l: i | 0 };
}
const mt = (r, e, t) => (r >>> 0) + (e >>> 0) + (t >>> 0), pt = (r, e, t, n) => e + t + n + (r / 2 ** 32 | 0) | 0, kt = (r, e, t, n) => (r >>> 0) + (e >>> 0) + (t >>> 0) + (n >>> 0), wt = (r, e, t, n, i) => e + t + n + i + (r / 2 ** 32 | 0) | 0, yt = (r, e, t, n, i) => (r >>> 0) + (e >>> 0) + (t >>> 0) + (n >>> 0) + (i >>> 0), xt = (r, e, t, n, i, a) => e + t + n + i + a + (r / 2 ** 32 | 0) | 0, zt = /* @__PURE__ */ Uint32Array.from([
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
]), P = /* @__PURE__ */ new Uint32Array(64);
class vt extends je {
  constructor(e) {
    super(64, e, 8, !1);
  }
  get() {
    const { A: e, B: t, C: n, D: i, E: a, F: o, G: s, H: h } = this;
    return [e, t, n, i, a, o, s, h];
  }
  // prettier-ignore
  set(e, t, n, i, a, o, s, h) {
    this.A = e | 0, this.B = t | 0, this.C = n | 0, this.D = i | 0, this.E = a | 0, this.F = o | 0, this.G = s | 0, this.H = h | 0;
  }
  process(e, t) {
    for (let l = 0; l < 16; l++, t += 4)
      P[l] = e.getUint32(t, !1);
    for (let l = 16; l < 64; l++) {
      const u = P[l - 15], m = P[l - 2], g = x(u, 7) ^ x(u, 18) ^ u >>> 3, p = x(m, 17) ^ x(m, 19) ^ m >>> 10;
      P[l] = p + P[l - 7] + g + P[l - 16] | 0;
    }
    let { A: n, B: i, C: a, D: o, E: s, F: h, G: d, H: f } = this;
    for (let l = 0; l < 64; l++) {
      const u = x(s, 6) ^ x(s, 11) ^ x(s, 25), m = f + u + dt(s, h, d) + zt[l] + P[l] | 0, p = (x(n, 2) ^ x(n, 13) ^ x(n, 22)) + ft(n, i, a) | 0;
      f = d, d = h, h = s, s = o + m | 0, o = a, a = i, i = n, n = m + p | 0;
    }
    n = n + this.A | 0, i = i + this.B | 0, a = a + this.C | 0, o = o + this.D | 0, s = s + this.E | 0, h = h + this.F | 0, d = d + this.G | 0, f = f + this.H | 0, this.set(n, i, a, o, s, h, d, f);
  }
  roundClean() {
    F(P);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), F(this.buffer);
  }
}
class St extends vt {
  constructor() {
    super(32);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    c(this, "A", K[0] | 0);
    c(this, "B", K[1] | 0);
    c(this, "C", K[2] | 0);
    c(this, "D", K[3] | 0);
    c(this, "E", K[4] | 0);
    c(this, "F", K[5] | 0);
    c(this, "G", K[6] | 0);
    c(this, "H", K[7] | 0);
  }
}
const Le = gt([
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
].map((r) => BigInt(r))), At = Le[0], Et = Le[1], H = /* @__PURE__ */ new Uint32Array(80), U = /* @__PURE__ */ new Uint32Array(80);
class It extends je {
  constructor(e) {
    super(128, e, 16, !1);
  }
  // prettier-ignore
  get() {
    const { Ah: e, Al: t, Bh: n, Bl: i, Ch: a, Cl: o, Dh: s, Dl: h, Eh: d, El: f, Fh: l, Fl: u, Gh: m, Gl: g, Hh: p, Hl: w } = this;
    return [e, t, n, i, a, o, s, h, d, f, l, u, m, g, p, w];
  }
  // prettier-ignore
  set(e, t, n, i, a, o, s, h, d, f, l, u, m, g, p, w) {
    this.Ah = e | 0, this.Al = t | 0, this.Bh = n | 0, this.Bl = i | 0, this.Ch = a | 0, this.Cl = o | 0, this.Dh = s | 0, this.Dl = h | 0, this.Eh = d | 0, this.El = f | 0, this.Fh = l | 0, this.Fl = u | 0, this.Gh = m | 0, this.Gl = g | 0, this.Hh = p | 0, this.Hl = w | 0;
  }
  process(e, t) {
    for (let b = 0; b < 16; b++, t += 4)
      H[b] = e.getUint32(t), U[b] = e.getUint32(t += 4);
    for (let b = 16; b < 80; b++) {
      const E = H[b - 15] | 0, I = U[b - 15] | 0, le = B(E, I, 1) ^ B(E, I, 8) ^ ve(E, I, 7), he = _(E, I, 1) ^ _(E, I, 8) ^ Se(E, I, 7), z = H[b - 2] | 0, v = U[b - 2] | 0, Z = B(z, v, 19) ^ X(z, v, 61) ^ ve(z, v, 6), ue = _(z, v, 19) ^ ee(z, v, 61) ^ Se(z, v, 6), Y = kt(he, ue, U[b - 7], U[b - 16]), de = wt(Y, le, Z, H[b - 7], H[b - 16]);
      H[b] = de | 0, U[b] = Y | 0;
    }
    let { Ah: n, Al: i, Bh: a, Bl: o, Ch: s, Cl: h, Dh: d, Dl: f, Eh: l, El: u, Fh: m, Fl: g, Gh: p, Gl: w, Hh: y, Hl: W } = this;
    for (let b = 0; b < 80; b++) {
      const E = B(l, u, 14) ^ B(l, u, 18) ^ X(l, u, 41), I = _(l, u, 14) ^ _(l, u, 18) ^ ee(l, u, 41), le = l & m ^ ~l & p, he = u & g ^ ~u & w, z = yt(W, I, he, Et[b], U[b]), v = xt(z, y, E, le, At[b], H[b]), Z = z | 0, ue = B(n, i, 28) ^ X(n, i, 34) ^ X(n, i, 39), Y = _(n, i, 28) ^ ee(n, i, 34) ^ ee(n, i, 39), de = n & a ^ n & s ^ a & s, qe = i & o ^ i & h ^ o & h;
      y = p | 0, W = w | 0, p = m | 0, w = g | 0, m = l | 0, g = u | 0, { h: l, l: u } = A(d | 0, f | 0, v | 0, Z | 0), d = s | 0, f = h | 0, s = a | 0, h = o | 0, a = n | 0, o = i | 0;
      const pe = mt(Z, Y, qe);
      n = pt(pe, v, ue, de), i = pe | 0;
    }
    ({ h: n, l: i } = A(this.Ah | 0, this.Al | 0, n | 0, i | 0)), { h: a, l: o } = A(this.Bh | 0, this.Bl | 0, a | 0, o | 0), { h: s, l: h } = A(this.Ch | 0, this.Cl | 0, s | 0, h | 0), { h: d, l: f } = A(this.Dh | 0, this.Dl | 0, d | 0, f | 0), { h: l, l: u } = A(this.Eh | 0, this.El | 0, l | 0, u | 0), { h: m, l: g } = A(this.Fh | 0, this.Fl | 0, m | 0, g | 0), { h: p, l: w } = A(this.Gh | 0, this.Gl | 0, p | 0, w | 0), { h: y, l: W } = A(this.Hh | 0, this.Hl | 0, y | 0, W | 0), this.set(n, i, a, o, s, h, d, f, l, u, m, g, p, w, y, W);
  }
  roundClean() {
    F(H, U);
  }
  destroy() {
    F(this.buffer), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}
class Kt extends It {
  constructor() {
    super(64);
    c(this, "Ah", k[0] | 0);
    c(this, "Al", k[1] | 0);
    c(this, "Bh", k[2] | 0);
    c(this, "Bl", k[3] | 0);
    c(this, "Ch", k[4] | 0);
    c(this, "Cl", k[5] | 0);
    c(this, "Dh", k[6] | 0);
    c(this, "Dl", k[7] | 0);
    c(this, "Eh", k[8] | 0);
    c(this, "El", k[9] | 0);
    c(this, "Fh", k[10] | 0);
    c(this, "Fl", k[11] | 0);
    c(this, "Gh", k[12] | 0);
    c(this, "Gl", k[13] | 0);
    c(this, "Hh", k[14] | 0);
    c(this, "Hl", k[15] | 0);
  }
}
const Pt = /* @__PURE__ */ Pe(
  () => new St(),
  /* @__PURE__ */ He(1)
), Ht = /* @__PURE__ */ Pe(
  () => new Kt(),
  /* @__PURE__ */ He(3)
);
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function ie(r) {
  return r instanceof Uint8Array || ArrayBuffer.isView(r) && r.constructor.name === "Uint8Array";
}
function Fe(r, e) {
  return Array.isArray(e) ? e.length === 0 ? !0 : r ? e.every((t) => typeof t == "string") : e.every((t) => Number.isSafeInteger(t)) : !1;
}
function Ut(r) {
  if (typeof r != "function")
    throw new Error("function expected");
  return !0;
}
function ae(r, e) {
  if (typeof e != "string")
    throw new Error(`${r}: string expected`);
  return !0;
}
function O(r) {
  if (!Number.isSafeInteger(r))
    throw new Error(`invalid integer: ${r}`);
}
function se(r) {
  if (!Array.isArray(r))
    throw new Error("array expected");
}
function oe(r, e) {
  if (!Fe(!0, e))
    throw new Error(`${r}: array of strings expected`);
}
function Me(r, e) {
  if (!Fe(!1, e))
    throw new Error(`${r}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function Dt(...r) {
  const e = (a) => a, t = (a, o) => (s) => a(o(s)), n = r.map((a) => a.encode).reduceRight(t, e), i = r.map((a) => a.decode).reduce(t, e);
  return { encode: n, decode: i };
}
// @__NO_SIDE_EFFECTS__
function jt(r) {
  const e = typeof r == "string" ? r.split("") : r, t = e.length;
  oe("alphabet", e);
  const n = new Map(e.map((i, a) => [i, a]));
  return {
    encode: (i) => (se(i), i.map((a) => {
      if (!Number.isSafeInteger(a) || a < 0 || a >= t)
        throw new Error(`alphabet.encode: digit index outside alphabet "${a}". Allowed: ${r}`);
      return e[a];
    })),
    decode: (i) => (se(i), i.map((a) => {
      ae("alphabet.decode", a);
      const o = n.get(a);
      if (o === void 0)
        throw new Error(`Unknown letter: "${a}". Allowed: ${r}`);
      return o;
    }))
  };
}
// @__NO_SIDE_EFFECTS__
function Lt(r = "") {
  return ae("join", r), {
    encode: (e) => (oe("join.decode", e), e.join(r)),
    decode: (e) => (ae("join.decode", e), e.split(r))
  };
}
// @__NO_SIDE_EFFECTS__
function Ft(r, e = "=") {
  return O(r), ae("padding", e), {
    encode(t) {
      for (oe("padding.encode", t); t.length * r % 8; )
        t.push(e);
      return t;
    },
    decode(t) {
      oe("padding.decode", t);
      let n = t.length;
      if (n * r % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (; n > 0 && t[n - 1] === e; n--)
        if ((n - 1) * r % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      return t.slice(0, n);
    }
  };
}
function be(r, e, t) {
  if (e < 2)
    throw new Error(`convertRadix: invalid from=${e}, base cannot be less than 2`);
  if (t < 2)
    throw new Error(`convertRadix: invalid to=${t}, base cannot be less than 2`);
  if (se(r), !r.length)
    return [];
  let n = 0;
  const i = [], a = Array.from(r, (s) => {
    if (O(s), s < 0 || s >= e)
      throw new Error(`invalid integer: ${s}`);
    return s;
  }), o = a.length;
  for (; ; ) {
    let s = 0, h = !0;
    for (let d = n; d < o; d++) {
      const f = a[d], l = e * s, u = l + f;
      if (!Number.isSafeInteger(u) || l / e !== s || u - f !== l)
        throw new Error("convertRadix: carry overflow");
      const m = u / t;
      s = u % t;
      const g = Math.floor(m);
      if (a[d] = g, !Number.isSafeInteger(g) || g * t + s !== u)
        throw new Error("convertRadix: carry overflow");
      if (h)
        g ? h = !1 : n = d;
      else continue;
    }
    if (i.push(s), h)
      break;
  }
  for (let s = 0; s < r.length - 1 && r[s] === 0; s++)
    i.push(0);
  return i.reverse();
}
const Ce = (r, e) => e === 0 ? r : Ce(e, r % e), ce = /* @__NO_SIDE_EFFECTS__ */ (r, e) => r + (e - Ce(r, e)), fe = /* @__PURE__ */ (() => {
  let r = [];
  for (let e = 0; e < 40; e++)
    r.push(2 ** e);
  return r;
})();
function ge(r, e, t, n) {
  if (se(r), e <= 0 || e > 32)
    throw new Error(`convertRadix2: wrong from=${e}`);
  if (t <= 0 || t > 32)
    throw new Error(`convertRadix2: wrong to=${t}`);
  if (/* @__PURE__ */ ce(e, t) > 32)
    throw new Error(`convertRadix2: carry overflow from=${e} to=${t} carryBits=${/* @__PURE__ */ ce(e, t)}`);
  let i = 0, a = 0;
  const o = fe[e], s = fe[t] - 1, h = [];
  for (const d of r) {
    if (O(d), d >= o)
      throw new Error(`convertRadix2: invalid data word=${d} from=${e}`);
    if (i = i << e | d, a + e > 32)
      throw new Error(`convertRadix2: carry overflow pos=${a} from=${e}`);
    for (a += e; a >= t; a -= t)
      h.push((i >> a - t & s) >>> 0);
    const f = fe[a];
    if (f === void 0)
      throw new Error("invalid carry");
    i &= f - 1;
  }
  if (i = i << t - a & s, !n && a >= e)
    throw new Error("Excess padding");
  if (!n && i > 0)
    throw new Error(`Non-zero padding: ${i}`);
  return n && a > 0 && h.push(i >>> 0), h;
}
// @__NO_SIDE_EFFECTS__
function Mt(r) {
  O(r);
  const e = 2 ** 8;
  return {
    encode: (t) => {
      if (!ie(t))
        throw new Error("radix.encode input should be Uint8Array");
      return be(Array.from(t), e, r);
    },
    decode: (t) => (Me("radix.decode", t), Uint8Array.from(be(t, r, e)))
  };
}
// @__NO_SIDE_EFFECTS__
function Ct(r, e = !1) {
  if (O(r), r <= 0 || r > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ ce(8, r) > 32 || /* @__PURE__ */ ce(r, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (t) => {
      if (!ie(t))
        throw new Error("radix2.encode input should be Uint8Array");
      return ge(Array.from(t), 8, r, !e);
    },
    decode: (t) => (Me("radix2.decode", t), Uint8Array.from(ge(t, r, 8, e)))
  };
}
function $t(r, e) {
  return O(r), Ut(e), {
    encode(t) {
      if (!ie(t))
        throw new Error("checksum.encode: input should be Uint8Array");
      const n = e(t).slice(0, r), i = new Uint8Array(t.length + r);
      return i.set(t), i.set(n, t.length), i;
    },
    decode(t) {
      if (!ie(t))
        throw new Error("checksum.decode: input should be Uint8Array");
      const n = t.slice(0, -r), i = t.slice(-r), a = e(n).slice(0, r);
      for (let o = 0; o < r; o++)
        if (a[o] !== i[o])
          throw new Error("Invalid checksum");
      return n;
    }
  };
}
const te = {
  alphabet: jt,
  chain: Dt,
  checksum: $t,
  convertRadix: be,
  convertRadix2: ge,
  radix: Mt,
  radix2: Ct,
  join: Lt,
  padding: Ft
};
/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
const Bt = (r) => r[0] === "あいこくしん";
function $e(r) {
  if (typeof r != "string")
    throw new TypeError("invalid mnemonic type: " + typeof r);
  return r.normalize("NFKD");
}
function Be(r) {
  const e = $e(r), t = e.split(" ");
  if (![12, 15, 18, 21, 24].includes(t.length))
    throw new Error("Invalid mnemonic");
  return { nfkd: e, words: t };
}
function _e(r) {
  if (q(r), ![16, 20, 24, 28, 32].includes(r.length))
    throw new Error("invalid entropy length");
}
function Te(r, e = 128) {
  if (V(e), e % 32 !== 0 || e > 256)
    throw new TypeError("Invalid entropy");
  return Vt(ct(e / 8), r);
}
const _t = (r) => {
  const e = 8 - r.length / 4;
  return new Uint8Array([Pt(r)[0] >> e << e]);
};
function Ve(r) {
  if (!Array.isArray(r) || r.length !== 2048 || typeof r[0] != "string")
    throw new Error("Wordlist: expected array of 2048 strings");
  return r.forEach((e) => {
    if (typeof e != "string")
      throw new Error("wordlist: non-string element: " + e);
  }), te.chain(te.checksum(1, _t), te.radix2(11, !0), te.alphabet(r));
}
function Tt(r, e) {
  const { words: t } = Be(r), n = Ve(e).decode(t);
  return _e(n), n;
}
function Vt(r, e) {
  return _e(r), Ve(e).encode(r).join(Bt(e) ? "　" : " ");
}
function Ne(r, e) {
  try {
    Tt(r, e);
  } catch {
    return !1;
  }
  return !0;
}
const Nt = (r) => $e("mnemonic" + r);
function me(r, e = "") {
  return ut(Ht, Be(r).nfkd, Nt(e), { c: 2048, dkLen: 64 });
}
const M = [
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
if (M.length !== 2048)
  throw new Error(
    `German wordlist must contain exactly 2048 words, but has ${M.length}`
  );
const Ae = new Set(M.map((r) => r.slice(0, 4)));
if (Ae.size !== 2048)
  throw new Error(
    `First 4 characters must be unique. Have ${Ae.size} unique, need 2048`
  );
class qt {
  /**
   * @param storage - Seed storage adapter (default: IndexedDB-based SeedStorage)
   * @param cryptoAdapter - Crypto adapter (default: WebCryptoAdapter)
   */
  constructor(e, t) {
    c(this, "masterKey", null);
    c(this, "identityKeyPair", null);
    c(this, "encKeyPair", null);
    c(this, "encKeyPairPromise", null);
    c(this, "did", null);
    c(this, "storage");
    c(this, "crypto");
    this.storage = e ?? new Re(), this.crypto = t ?? new Je();
  }
  /**
   * Create a new identity with BIP39 mnemonic
   *
   * @param userPassphrase - User's passphrase for seed encryption
   * @param storeSeed - Store encrypted seed in IndexedDB (default: true)
   * @returns Mnemonic (12 words) and DID
   */
  async create(e, t = !0) {
    const n = Te(M, 128), i = me(n, "");
    return t && await this.storage.storeSeed(new Uint8Array(i.slice(0, 32)), e), await this.initFromSeed(new Uint8Array(i.slice(0, 32))), { mnemonic: n, did: this.did };
  }
  /**
   * Unlock identity from mnemonic + passphrase
   *
   * @param mnemonic - 12 word BIP39 mnemonic
   * @param passphrase - User's passphrase
   * @param storeSeed - Store encrypted seed in IndexedDB (default: false)
   */
  async unlock(e, t, n = !1) {
    if (!Ne(e, M))
      throw new Error("Invalid mnemonic");
    const i = me(e, "");
    n && await this.storage.storeSeed(new Uint8Array(i.slice(0, 32)), t), await this.initFromSeed(new Uint8Array(i.slice(0, 32)));
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
    await this.initFromSeed(t);
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
    this.masterKey = null, this.identityKeyPair = null, this.encKeyPair = null, this.did = null, await this.storage.clearSessionKey();
  }
  ensureUnlocked() {
    if (!this.did || !this.masterKey || !this.identityKeyPair)
      throw new Error("Identity not unlocked");
    return { did: this.did, masterKey: this.masterKey, keyPair: this.identityKeyPair };
  }
  getDid() {
    return this.ensureUnlocked().did;
  }
  async signJws(e) {
    return Ge(e, this.ensureUnlocked().keyPair.privateKey);
  }
  async sign(e) {
    return this.crypto.signString(e, this.ensureUnlocked().keyPair.privateKey);
  }
  async deriveFrameworkKey(e) {
    return this.crypto.deriveBits(this.ensureUnlocked().masterKey, e, 256);
  }
  async getPublicKey() {
    return this.ensureUnlocked().keyPair.publicKey;
  }
  async exportPublicKeyJwk() {
    return crypto.subtle.exportKey("jwk", this.ensureUnlocked().keyPair.publicKey);
  }
  async getPublicKeyMultibase() {
    return this.ensureUnlocked().did.replace("did:key:", "");
  }
  // --- Encryption (X25519 ECDH + AES-GCM) ---
  ensureEncKeyPair() {
    return this.ensureUnlocked(), this.encKeyPair ? Promise.resolve(this.encKeyPair) : (this.encKeyPairPromise || (this.encKeyPairPromise = (async () => {
      const e = await this.crypto.deriveBits(this.masterKey, "wot-encryption-v1", 256);
      return this.encKeyPair = await this.crypto.deriveEncryptionKeyPair(e), this.encKeyPair;
    })()), this.encKeyPairPromise);
  }
  /**
   * Get the X25519 encryption key pair (derived via separate HKDF path).
   */
  async getEncryptionKeyPair() {
    return (await this.ensureEncKeyPair()).keyPair;
  }
  /**
   * Get X25519 public key as raw bytes (32 bytes).
   */
  async getEncryptionPublicKeyBytes() {
    const e = await this.ensureEncKeyPair();
    return this.crypto.exportEncryptionPublicKey(e);
  }
  /**
   * Encrypt data for a recipient using their X25519 public key.
   * Uses ephemeral ECDH + HKDF + AES-256-GCM (ECIES-like).
   */
  async encryptForRecipient(e, t) {
    return this.ensureUnlocked(), this.crypto.encryptAsymmetric(e, t);
  }
  /**
   * Decrypt data encrypted for this identity.
   */
  async decryptForMe(e) {
    if (!e.ephemeralPublicKey) throw new Error("Missing ephemeral public key");
    const t = await this.ensureEncKeyPair();
    return this.crypto.decryptAsymmetric(e, t);
  }
  // --- Private methods ---
  /**
   * Initialize identity from a 32-byte seed.
   * Shared logic for create(), unlock(), and unlockFromStorage().
   */
  async initFromSeed(e) {
    this.masterKey = await this.crypto.importMasterKey(e);
    const t = await this.crypto.deriveBits(this.masterKey, "wot-identity-v1", 256), n = await this.crypto.deriveKeyPairFromSeed(t);
    this.identityKeyPair = n, this.did = await this.crypto.createDid(n.publicKey);
  }
}
const Ot = 64;
var R, N, J, L, G;
class Wt {
  constructor(e, t, n, i) {
    c(this, "did");
    c(this, "kid");
    c(this, "ed25519PublicKey");
    c(this, "x25519PublicKey");
    C(this, R);
    C(this, N);
    C(this, J);
    C(this, L);
    C(this, G);
    this.did = e.did, this.kid = e.kid, this.ed25519PublicKey = new Uint8Array(e.ed25519PublicKey), this.x25519PublicKey = new Uint8Array(e.x25519PublicKey), $(this, R, new Uint8Array(t)), $(this, N, new Uint8Array(e.ed25519Seed)), $(this, J, new Uint8Array(e.x25519Seed)), $(this, L, n), $(this, G, i);
  }
  getDid() {
    return this.did;
  }
  async sign(e) {
    const t = await ye(new TextEncoder().encode(e), S(this, N));
    return j(t);
  }
  async signJws(e) {
    const t = { alg: "EdDSA", typ: "JWT" }, n = j(new TextEncoder().encode(JSON.stringify(t))), i = j(new TextEncoder().encode(JSON.stringify(e))), a = `${n}.${i}`, o = await ye(new TextEncoder().encode(a), S(this, N));
    return `${a}.${j(o)}`;
  }
  async deriveFrameworkKey(e) {
    return S(this, L).hkdfSha256(S(this, R), e, 32);
  }
  async getPublicKeyMultibase() {
    return this.did.replace("did:key:", "");
  }
  async getEncryptionPublicKeyBytes() {
    return new Uint8Array(this.x25519PublicKey);
  }
  async encryptForRecipient(e, t) {
    const n = crypto.getRandomValues(new Uint8Array(32)), i = crypto.getRandomValues(new Uint8Array(12)), a = await et({
      crypto: S(this, L),
      ephemeralPrivateSeed: n,
      recipientPublicKey: t,
      nonce: i,
      plaintext: e
    });
    return {
      ciphertext: T(a.ciphertext),
      nonce: T(a.nonce),
      ephemeralPublicKey: T(a.epk)
    };
  }
  async decryptForMe(e) {
    if (!e.ephemeralPublicKey) throw new Error("Missing ephemeral public key");
    return tt({
      crypto: S(this, L),
      recipientPrivateSeed: S(this, J),
      message: {
        epk: j(e.ephemeralPublicKey),
        nonce: j(e.nonce),
        ciphertext: j(e.ciphertext)
      }
    });
  }
  async deleteStoredIdentity() {
    await S(this, G).call(this);
  }
}
R = new WeakMap(), N = new WeakMap(), J = new WeakMap(), L = new WeakMap(), G = new WeakMap();
class Rt {
  constructor(e) {
    c(this, "crypto");
    c(this, "vault");
    c(this, "createMnemonic");
    c(this, "currentIdentity", null);
    this.crypto = e.crypto, this.vault = e.vault ?? null, this.createMnemonic = e.generateMnemonic ?? (() => Te(M, 128));
  }
  async createIdentity(e) {
    const t = this.createMnemonic(), n = await this.recoverFromMnemonic(t);
    return (e.storeSeed ?? !0) && await this.requireVault().saveSeed(this.seedFromMnemonic(t), e.passphrase), this.currentIdentity = n, { mnemonic: t, identity: n };
  }
  async recoverIdentity(e) {
    const t = await this.recoverFromMnemonic(e.mnemonic);
    return (e.storeSeed ?? !1) && await this.requireVault().saveSeed(this.seedFromMnemonic(e.mnemonic), e.passphrase), this.currentIdentity = t, { identity: t };
  }
  async unlockStoredIdentity(e = {}) {
    const t = this.requireVault(), n = e.passphrase !== void 0 ? await t.loadSeed(e.passphrase) : await this.loadSeedWithSessionKey(t);
    if (!n) throw new Error(e.passphrase !== void 0 ? "No identity found in storage" : "Session expired");
    const i = await this.identityFromSeed(n);
    return this.currentIdentity = i, { identity: i };
  }
  async hasStoredIdentity() {
    return this.requireVault().hasSeed();
  }
  async hasActiveSession() {
    var e, t;
    return ((t = (e = this.requireVault()).hasActiveSession) == null ? void 0 : t.call(e)) ?? !1;
  }
  async deleteStoredIdentity() {
    await this.requireVault().deleteSeed(), this.currentIdentity = null;
  }
  lockIdentity() {
    this.currentIdentity = null;
  }
  getCurrentIdentity() {
    return this.currentIdentity;
  }
  async recoverFromMnemonic(e) {
    if (!Ne(e, M)) throw new Error("Invalid mnemonic");
    return this.identityFromSeed(this.seedFromMnemonic(e));
  }
  async identityFromSeed(e) {
    if (e.length !== Ot) throw new Error("Invalid identity seed format");
    const t = await Qe(Xe(e), this.crypto);
    return new Wt(t, e, this.crypto, () => this.deleteStoredIdentity());
  }
  async loadSeedWithSessionKey(e) {
    if (!e.loadSeedWithSessionKey) throw new Error("Session unlock is not supported");
    return e.loadSeedWithSessionKey();
  }
  seedFromMnemonic(e) {
    return me(e, "");
  }
  requireVault() {
    if (!this.vault) throw new Error("Identity seed vault is required");
    return this.vault;
  }
}
class Jt {
  constructor(e) {
    c(this, "crypto");
    c(this, "randomId");
    c(this, "now");
    this.crypto = e.crypto, this.randomId = e.randomId ?? (() => crypto.randomUUID()), this.now = e.now ?? (() => /* @__PURE__ */ new Date());
  }
  async createChallenge(e, t) {
    const n = {
      nonce: this.randomId(),
      timestamp: this.now().toISOString(),
      fromDid: e.getDid(),
      fromPublicKey: await e.getPublicKeyMultibase(),
      fromName: t
    };
    return { challenge: n, code: Ee(n) };
  }
  decodeChallenge(e) {
    return Ie(e);
  }
  prepareChallenge(e, t) {
    const n = this.decodeChallenge(e);
    if (t && n.fromDid === t) throw new Error("Cannot verify own identity");
    return n;
  }
  async createResponse(e, t, n) {
    const i = this.prepareChallenge(e, t.getDid()), a = {
      nonce: i.nonce,
      timestamp: this.now().toISOString(),
      toDid: t.getDid(),
      toPublicKey: await t.getPublicKeyMultibase(),
      toName: n,
      fromDid: i.fromDid,
      fromPublicKey: i.fromPublicKey,
      fromName: i.fromName
    };
    return { response: a, code: Ee(a) };
  }
  decodeResponse(e) {
    return Ie(e);
  }
  async completeVerification(e, t, n) {
    const i = this.decodeResponse(e);
    if (i.nonce !== n) throw new Error("Nonce mismatch");
    return this.createSignedVerification({
      identity: t,
      toDid: i.toDid,
      nonce: i.nonce,
      timestamp: i.timestamp,
      id: `urn:uuid:ver-${i.nonce}`,
      proofCreated: this.now().toISOString()
    });
  }
  async createVerificationFor(e, t, n) {
    const i = this.now().toISOString();
    return this.createSignedVerification({
      identity: e,
      toDid: t,
      nonce: n,
      timestamp: i,
      id: `urn:uuid:ver-${n}-${e.getDid().slice(-8)}`,
      proofCreated: i
    });
  }
  async verifySignature(e) {
    try {
      const t = JSON.stringify({
        from: e.from,
        to: e.to,
        timestamp: e.timestamp
      });
      return this.crypto.verifyEd25519(
        new TextEncoder().encode(t),
        T(e.proof.proofValue),
        Ze(e.from)
      );
    } catch {
      return !1;
    }
  }
  publicKeyFromDid(e) {
    if (!e.startsWith("did:key:")) throw new Error("Invalid did:key format");
    return e.slice(8);
  }
  multibaseToBytes(e) {
    return Ye(e);
  }
  base64UrlToBytes(e) {
    return T(e);
  }
  async createSignedVerification(e) {
    const t = e.identity.getDid(), n = JSON.stringify({ from: t, to: e.toDid, timestamp: e.timestamp }), i = await e.identity.sign(n);
    return {
      id: e.id,
      from: t,
      to: e.toDid,
      timestamp: e.timestamp,
      proof: {
        type: "Ed25519Signature2020",
        verificationMethod: `${t}#key-1`,
        created: e.proofCreated,
        proofPurpose: "authentication",
        proofValue: i
      }
    };
  }
}
function Ee(r) {
  const e = new TextEncoder().encode(JSON.stringify(r));
  let t = "";
  for (const n of e) t += String.fromCharCode(n);
  return btoa(t);
}
function Ie(r) {
  const e = atob(r), t = new Uint8Array(e.length);
  for (let n = 0; n < e.length; n++) t[n] = e.charCodeAt(n);
  return JSON.parse(new TextDecoder().decode(t));
}
class Gt {
  constructor(e) {
    c(this, "crypto");
    c(this, "randomId");
    c(this, "now");
    this.crypto = e.crypto, this.randomId = e.randomId ?? (() => crypto.randomUUID()), this.now = e.now ?? (() => /* @__PURE__ */ new Date());
  }
  async createAttestation(e) {
    const t = `urn:uuid:${this.randomId()}`, n = this.now().toISOString(), i = e.issuer.getDid(), a = e.subjectDid, o = await rt({
      kid: `${i}#sig-0`,
      payload: this.createVcPayload({ id: t, from: i, to: a, claim: e.claim, tags: e.tags, createdAt: n }),
      sign: async (s) => T(await e.issuer.sign(new TextDecoder().decode(s)))
    });
    return {
      id: t,
      from: i,
      to: a,
      claim: e.claim,
      ...e.tags ? { tags: e.tags } : {},
      createdAt: n,
      vcJws: o
    };
  }
  async verifyAttestation(e) {
    try {
      this.assertComplete(e);
      const t = await this.verifyAttestationVcJws(e.vcJws);
      return this.payloadMatchesAttestation(t, e);
    } catch {
      return !1;
    }
  }
  verifyAttestationVcJws(e) {
    return nt(e, { crypto: this.crypto });
  }
  exportAttestation(e) {
    return this.assertComplete(e), e.vcJws;
  }
  async importAttestation(e) {
    const t = e.trim();
    if (!Zt(t)) throw new Error("Invalid attestation format");
    try {
      const n = await this.verifyAttestationVcJws(t);
      return this.attestationFromVcPayload(n, t);
    } catch {
      throw new Error("Invalid attestation signature");
    }
  }
  createVcPayload(e) {
    const t = {
      id: e.to,
      claim: e.claim,
      ...e.tags ? { tags: e.tags } : {}
    };
    return {
      "@context": ["https://www.w3.org/ns/credentials/v2", "https://web-of-trust.de/vocab/v1"],
      id: e.id,
      type: ["VerifiableCredential", "WotAttestation"],
      issuer: e.from,
      credentialSubject: t,
      validFrom: e.createdAt,
      iss: e.from,
      sub: e.to,
      nbf: Math.floor(new Date(e.createdAt).getTime() / 1e3),
      jti: e.id,
      iat: Math.floor(new Date(e.createdAt).getTime() / 1e3)
    };
  }
  attestationFromVcPayload(e, t) {
    const n = e.credentialSubject.tags, i = e.credentialSubject.context;
    return {
      id: typeof e.jti == "string" ? e.jti : typeof e.id == "string" ? e.id : `wot:attestation:${e.iss}:${e.sub}:${e.nbf}`,
      from: e.issuer,
      to: e.credentialSubject.id,
      claim: e.credentialSubject.claim,
      ...Array.isArray(n) && n.every((o) => typeof o == "string") ? { tags: n } : {},
      ...typeof i == "string" ? { context: i } : {},
      createdAt: e.validFrom,
      vcJws: t
    };
  }
  payloadMatchesAttestation(e, t) {
    return e.issuer === t.from && e.iss === t.from && e.sub === t.to && e.credentialSubject.id === t.to && e.credentialSubject.claim === t.claim && e.validFrom === t.createdAt && (e.jti == null || e.jti === t.id) && (e.id == null || e.id === t.id);
  }
  assertComplete(e) {
    if (!e.id || !e.from || !e.to || !e.claim || !e.createdAt || !e.vcJws)
      throw new Error("Incomplete attestation");
  }
}
function Zt(r) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(r);
}
class Yt {
  constructor(e) {
    c(this, "replication");
    c(this, "memberKeys");
    c(this, "appTag");
    c(this, "createDefaultInitialDoc");
    this.replication = e.replication, this.memberKeys = e.memberKeys ?? null, this.appTag = e.appTag, this.createDefaultInitialDoc = e.defaultInitialDoc ?? (() => ({}));
  }
  watchSpaces() {
    return this.replication.watchSpaces();
  }
  listSpaces() {
    return this.replication.getSpaces();
  }
  getSpace(e) {
    return this.replication.getSpace(D(e, "spaceId"));
  }
  async createSpace(e) {
    const t = D(e.name.trim(), "space name"), n = e.appTag ?? this.appTag, i = {
      name: t,
      ...e.description !== void 0 ? { description: e.description } : {},
      ...n !== void 0 ? { appTag: n } : {}
    };
    return this.replication.createSpace(e.type ?? "shared", e.initialDoc ?? this.createDefaultInitialDoc(), i);
  }
  updateSpace(e, t) {
    return this.replication.updateSpace(D(e, "spaceId"), t);
  }
  async inviteMember(e) {
    const t = D(e.memberDid, "memberDid"), n = await this.requireMemberKeys().resolveMemberEncryptionKey(t);
    if (!n) throw new Error("NO_ENCRYPTION_KEY");
    await this.replication.addMember(D(e.spaceId, "spaceId"), t, n);
  }
  removeMember(e) {
    return this.replication.removeMember(D(e.spaceId, "spaceId"), D(e.memberDid, "memberDid"));
  }
  leaveSpace(e) {
    return this.replication.leaveSpace(D(e, "spaceId"));
  }
  requestSync(e = "__all__") {
    return this.replication.requestSync(e);
  }
  requireMemberKeys() {
    if (!this.memberKeys) throw new Error("Space member key directory is required");
    return this.memberKeys;
  }
}
function D(r, e) {
  if (!r) throw new Error(`Missing ${e}`);
  return r;
}
const ir = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  AttestationWorkflow: Gt,
  IdentityWorkflow: Rt,
  SpacesWorkflow: Yt,
  VerificationWorkflow: Jt,
  WotIdentity: qt
}, Symbol.toStringTag, { value: "Module" }));
export {
  Gt as A,
  Rt as I,
  Yt as S,
  Jt as V,
  qt as W,
  ir as i
};
