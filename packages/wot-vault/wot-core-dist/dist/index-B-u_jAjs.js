var _e = Object.defineProperty;
var Se = (t, e, n) => e in t ? _e(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : t[e] = n;
var h = (t, e, n) => Se(t, typeof e != "symbol" ? e + "" : e, n);
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function $e(t) {
  return t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array";
}
function S(t, e = "") {
  if (!Number.isSafeInteger(t) || t < 0) {
    const n = e && `"${e}" `;
    throw new Error(`${n}expected integer >= 0, got ${t}`);
  }
}
function $(t, e, n = "") {
  const o = $e(t), r = t == null ? void 0 : t.length, s = e !== void 0;
  if (!o || s && r !== e) {
    const i = n && `"${n}" `, c = s ? ` of length ${e}` : "", f = o ? `length=${r}` : `type=${typeof t}`;
    throw new Error(i + "expected Uint8Array" + c + ", got " + f);
  }
  return t;
}
function ce(t) {
  if (typeof t != "function" || typeof t.create != "function")
    throw new Error("Hash must wrapped by utils.createHasher");
  S(t.outputLen), S(t.blockLen);
}
function V(t, e = !0) {
  if (t.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (e && t.finished)
    throw new Error("Hash#digest() has already been called");
}
function Ce(t, e) {
  $(t, void 0, "digestInto() output");
  const n = e.outputLen;
  if (t.length < n)
    throw new Error('"digestInto() output" expected to be of length >=' + n);
}
function C(...t) {
  for (let e = 0; e < t.length; e++)
    t[e].fill(0);
}
function j(t) {
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
}
function m(t, e) {
  return t << 32 - e | t >>> e;
}
const Te = async () => {
};
async function De(t, e, n) {
  let o = Date.now();
  for (let r = 0; r < t; r++) {
    n(r);
    const s = Date.now() - o;
    s >= 0 && s < e || (await Te(), o += s);
  }
}
function Fe(t) {
  if (typeof t != "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(t));
}
function P(t, e = "") {
  return typeof t == "string" ? Fe(t) : $(t, void 0, e);
}
function ue(t, e) {
  if (e !== void 0 && {}.toString.call(e) !== "[object Object]")
    throw new Error("options must be object or undefined");
  return Object.assign(t, e);
}
function le(t, e = {}) {
  const n = (r, s) => t(s).update(r).digest(), o = t(void 0);
  return n.outputLen = o.outputLen, n.blockLen = o.blockLen, n.create = (r) => t(r), Object.assign(n, e), Object.freeze(n);
}
function Re(t = 32) {
  const e = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof (e == null ? void 0 : e.getRandomValues) != "function")
    throw new Error("crypto.getRandomValues must be defined");
  return e.getRandomValues(new Uint8Array(t));
}
const be = (t) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, t])
});
class xe {
  constructor(e, n) {
    h(this, "oHash");
    h(this, "iHash");
    h(this, "blockLen");
    h(this, "outputLen");
    h(this, "finished", !1);
    h(this, "destroyed", !1);
    if (ce(e), $(n, void 0, "key"), this.iHash = e.create(), typeof this.iHash.update != "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen, this.outputLen = this.iHash.outputLen;
    const o = this.blockLen, r = new Uint8Array(o);
    r.set(n.length > o ? e.create().update(n).digest() : n);
    for (let s = 0; s < r.length; s++)
      r[s] ^= 54;
    this.iHash.update(r), this.oHash = e.create();
    for (let s = 0; s < r.length; s++)
      r[s] ^= 106;
    this.oHash.update(r), C(r);
  }
  update(e) {
    return V(this), this.iHash.update(e), this;
  }
  digestInto(e) {
    V(this), $(e, this.outputLen, "output"), this.finished = !0, this.iHash.digestInto(e), this.oHash.update(e), this.oHash.digestInto(e), this.destroy();
  }
  digest() {
    const e = new Uint8Array(this.oHash.outputLen);
    return this.digestInto(e), e;
  }
  _cloneInto(e) {
    e || (e = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash: n, iHash: o, finished: r, destroyed: s, blockLen: i, outputLen: c } = this;
    return e = e, e.finished = r, e.destroyed = s, e.blockLen = i, e.outputLen = c, e.oHash = n._cloneInto(e.oHash), e.iHash = o._cloneInto(e.iHash), e;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = !0, this.oHash.destroy(), this.iHash.destroy();
  }
}
const pe = (t, e, n) => new xe(t, e).update(n).digest();
pe.create = (t, e) => new xe(t, e);
function we(t, e, n, o) {
  ce(t);
  const r = ue({ dkLen: 32, asyncTick: 10 }, o), { c: s, dkLen: i, asyncTick: c } = r;
  if (S(s, "c"), S(i, "dkLen"), S(c, "asyncTick"), s < 1)
    throw new Error("iterations (c) must be >= 1");
  const f = P(e, "password"), d = P(n, "salt"), l = new Uint8Array(i), a = pe.create(t, f), u = a._cloneInto().update(d);
  return { c: s, dkLen: i, asyncTick: c, DK: l, PRF: a, PRFSalt: u };
}
function ye(t, e, n, o, r) {
  return t.destroy(), e.destroy(), o && o.destroy(), C(r), n;
}
function je(t, e, n, o) {
  const { c: r, dkLen: s, DK: i, PRF: c, PRFSalt: f } = we(t, e, n, o);
  let d;
  const l = new Uint8Array(4), a = j(l), u = new Uint8Array(c.outputLen);
  for (let b = 1, x = 0; x < s; b++, x += c.outputLen) {
    const p = i.subarray(x, x + c.outputLen);
    a.setInt32(0, b, !1), (d = f._cloneInto(d)).update(l).digestInto(u), p.set(u.subarray(0, p.length));
    for (let y = 1; y < r; y++) {
      c._cloneInto(d).update(u).digestInto(u);
      for (let A = 0; A < p.length; A++)
        p[A] ^= u[A];
    }
  }
  return ye(c, f, i, d, u);
}
async function Ne(t, e, n, o) {
  const { c: r, dkLen: s, asyncTick: i, DK: c, PRF: f, PRFSalt: d } = we(t, e, n, o);
  let l;
  const a = new Uint8Array(4), u = j(a), b = new Uint8Array(f.outputLen);
  for (let x = 1, p = 0; p < s; x++, p += f.outputLen) {
    const y = c.subarray(p, p + f.outputLen);
    u.setInt32(0, x, !1), (l = d._cloneInto(l)).update(a).digestInto(b), y.set(b.subarray(0, y.length)), await De(r - 1, i, () => {
      f._cloneInto(l).update(b).digestInto(b);
      for (let A = 0; A < y.length; A++)
        y[A] ^= b[A];
    });
  }
  return ye(f, d, c, l, b);
}
function Ge(t, e, n) {
  return t & e ^ ~t & n;
}
function Oe(t, e, n) {
  return t & e ^ t & n ^ e & n;
}
class ge {
  constructor(e, n, o, r) {
    h(this, "blockLen");
    h(this, "outputLen");
    h(this, "padOffset");
    h(this, "isLE");
    // For partial updates less than block size
    h(this, "buffer");
    h(this, "view");
    h(this, "finished", !1);
    h(this, "length", 0);
    h(this, "pos", 0);
    h(this, "destroyed", !1);
    this.blockLen = e, this.outputLen = n, this.padOffset = o, this.isLE = r, this.buffer = new Uint8Array(e), this.view = j(this.buffer);
  }
  update(e) {
    V(this), $(e);
    const { view: n, buffer: o, blockLen: r } = this, s = e.length;
    for (let i = 0; i < s; ) {
      const c = Math.min(r - this.pos, s - i);
      if (c === r) {
        const f = j(e);
        for (; r <= s - i; i += r)
          this.process(f, i);
        continue;
      }
      o.set(e.subarray(i, i + c), this.pos), this.pos += c, i += c, this.pos === r && (this.process(n, 0), this.pos = 0);
    }
    return this.length += e.length, this.roundClean(), this;
  }
  digestInto(e) {
    V(this), Ce(e, this), this.finished = !0;
    const { buffer: n, view: o, blockLen: r, isLE: s } = this;
    let { pos: i } = this;
    n[i++] = 128, C(this.buffer.subarray(i)), this.padOffset > r - i && (this.process(o, 0), i = 0);
    for (let a = i; a < r; a++)
      n[a] = 0;
    o.setBigUint64(r - 8, BigInt(this.length * 8), s), this.process(o, 0);
    const c = j(e), f = this.outputLen;
    if (f % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const d = f / 4, l = this.get();
    if (d > l.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let a = 0; a < d; a++)
      c.setUint32(4 * a, l[a], s);
  }
  digest() {
    const { buffer: e, outputLen: n } = this;
    this.digestInto(e);
    const o = e.slice(0, n);
    return this.destroy(), o;
  }
  _cloneInto(e) {
    e || (e = new this.constructor()), e.set(...this.get());
    const { blockLen: n, buffer: o, length: r, finished: s, destroyed: i, pos: c } = this;
    return e.destroyed = i, e.finished = s, e.length = r, e.pos = c, r % n && e.buffer.set(o), e;
  }
  clone() {
    return this._cloneInto();
  }
}
const U = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), g = /* @__PURE__ */ Uint32Array.from([
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
]), O = /* @__PURE__ */ BigInt(2 ** 32 - 1), fe = /* @__PURE__ */ BigInt(32);
function Me(t, e = !1) {
  return e ? { h: Number(t & O), l: Number(t >> fe & O) } : { h: Number(t >> fe & O) | 0, l: Number(t & O) | 0 };
}
function We(t, e = !1) {
  const n = t.length;
  let o = new Uint32Array(n), r = new Uint32Array(n);
  for (let s = 0; s < n; s++) {
    const { h: i, l: c } = Me(t[s], e);
    [o[s], r[s]] = [i, c];
  }
  return [o, r];
}
const de = (t, e, n) => t >>> n, he = (t, e, n) => t << 32 - n | e >>> n, T = (t, e, n) => t >>> n | e << 32 - n, D = (t, e, n) => t << 32 - n | e >>> n, M = (t, e, n) => t << 64 - n | e >>> n - 32, W = (t, e, n) => t >>> n - 32 | e << 64 - n;
function L(t, e, n, o) {
  const r = (e >>> 0) + (o >>> 0);
  return { h: t + n + (r / 2 ** 32 | 0) | 0, l: r | 0 };
}
const Ke = (t, e, n) => (t >>> 0) + (e >>> 0) + (n >>> 0), Ve = (t, e, n, o) => e + n + o + (t / 2 ** 32 | 0) | 0, Pe = (t, e, n, o) => (t >>> 0) + (e >>> 0) + (n >>> 0) + (o >>> 0), ze = (t, e, n, o, r) => e + n + o + r + (t / 2 ** 32 | 0) | 0, Je = (t, e, n, o, r) => (t >>> 0) + (e >>> 0) + (n >>> 0) + (o >>> 0) + (r >>> 0), qe = (t, e, n, o, r, s) => e + n + o + r + s + (t / 2 ** 32 | 0) | 0, Qe = /* @__PURE__ */ Uint32Array.from([
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
]), B = /* @__PURE__ */ new Uint32Array(64);
class Xe extends ge {
  constructor(e) {
    super(64, e, 8, !1);
  }
  get() {
    const { A: e, B: n, C: o, D: r, E: s, F: i, G: c, H: f } = this;
    return [e, n, o, r, s, i, c, f];
  }
  // prettier-ignore
  set(e, n, o, r, s, i, c, f) {
    this.A = e | 0, this.B = n | 0, this.C = o | 0, this.D = r | 0, this.E = s | 0, this.F = i | 0, this.G = c | 0, this.H = f | 0;
  }
  process(e, n) {
    for (let a = 0; a < 16; a++, n += 4)
      B[a] = e.getUint32(n, !1);
    for (let a = 16; a < 64; a++) {
      const u = B[a - 15], b = B[a - 2], x = m(u, 7) ^ m(u, 18) ^ u >>> 3, p = m(b, 17) ^ m(b, 19) ^ b >>> 10;
      B[a] = p + B[a - 7] + x + B[a - 16] | 0;
    }
    let { A: o, B: r, C: s, D: i, E: c, F: f, G: d, H: l } = this;
    for (let a = 0; a < 64; a++) {
      const u = m(c, 6) ^ m(c, 11) ^ m(c, 25), b = l + u + Ge(c, f, d) + Qe[a] + B[a] | 0, p = (m(o, 2) ^ m(o, 13) ^ m(o, 22)) + Oe(o, r, s) | 0;
      l = d, d = f, f = c, c = i + b | 0, i = s, s = r, r = o, o = b + p | 0;
    }
    o = o + this.A | 0, r = r + this.B | 0, s = s + this.C | 0, i = i + this.D | 0, c = c + this.E | 0, f = f + this.F | 0, d = d + this.G | 0, l = l + this.H | 0, this.set(o, r, s, i, c, f, d, l);
  }
  roundClean() {
    C(B);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), C(this.buffer);
  }
}
class Ye extends Xe {
  constructor() {
    super(32);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    h(this, "A", U[0] | 0);
    h(this, "B", U[1] | 0);
    h(this, "C", U[2] | 0);
    h(this, "D", U[3] | 0);
    h(this, "E", U[4] | 0);
    h(this, "F", U[5] | 0);
    h(this, "G", U[6] | 0);
    h(this, "H", U[7] | 0);
  }
}
const Ae = We([
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
].map((t) => BigInt(t))), Ze = Ae[0], et = Ae[1], v = /* @__PURE__ */ new Uint32Array(80), _ = /* @__PURE__ */ new Uint32Array(80);
class tt extends ge {
  constructor(e) {
    super(128, e, 16, !1);
  }
  // prettier-ignore
  get() {
    const { Ah: e, Al: n, Bh: o, Bl: r, Ch: s, Cl: i, Dh: c, Dl: f, Eh: d, El: l, Fh: a, Fl: u, Gh: b, Gl: x, Hh: p, Hl: y } = this;
    return [e, n, o, r, s, i, c, f, d, l, a, u, b, x, p, y];
  }
  // prettier-ignore
  set(e, n, o, r, s, i, c, f, d, l, a, u, b, x, p, y) {
    this.Ah = e | 0, this.Al = n | 0, this.Bh = o | 0, this.Bl = r | 0, this.Ch = s | 0, this.Cl = i | 0, this.Dh = c | 0, this.Dl = f | 0, this.Eh = d | 0, this.El = l | 0, this.Fh = a | 0, this.Fl = u | 0, this.Gh = b | 0, this.Gl = x | 0, this.Hh = p | 0, this.Hl = y | 0;
  }
  process(e, n) {
    for (let w = 0; w < 16; w++, n += 4)
      v[w] = e.getUint32(n), _[w] = e.getUint32(n += 4);
    for (let w = 16; w < 80; w++) {
      const k = v[w - 15] | 0, I = _[w - 15] | 0, Z = T(k, I, 1) ^ T(k, I, 8) ^ de(k, I, 7), ee = D(k, I, 1) ^ D(k, I, 8) ^ he(k, I, 7), E = v[w - 2] | 0, H = _[w - 2] | 0, N = T(E, H, 19) ^ M(E, H, 61) ^ de(E, H, 6), te = D(E, H, 19) ^ W(E, H, 61) ^ he(E, H, 6), G = Pe(ee, te, _[w - 7], _[w - 16]), ne = ze(G, Z, N, v[w - 7], v[w - 16]);
      v[w] = ne | 0, _[w] = G | 0;
    }
    let { Ah: o, Al: r, Bh: s, Bl: i, Ch: c, Cl: f, Dh: d, Dl: l, Eh: a, El: u, Fh: b, Fl: x, Gh: p, Gl: y, Hh: A, Hl: R } = this;
    for (let w = 0; w < 80; w++) {
      const k = T(a, u, 14) ^ T(a, u, 18) ^ M(a, u, 41), I = D(a, u, 14) ^ D(a, u, 18) ^ W(a, u, 41), Z = a & b ^ ~a & p, ee = u & x ^ ~u & y, E = Je(R, I, ee, et[w], _[w]), H = qe(E, A, k, Z, Ze[w], v[w]), N = E | 0, te = T(o, r, 28) ^ M(o, r, 34) ^ M(o, r, 39), G = D(o, r, 28) ^ W(o, r, 34) ^ W(o, r, 39), ne = o & s ^ o & c ^ s & c, ve = r & i ^ r & f ^ i & f;
      A = p | 0, R = y | 0, p = b | 0, y = x | 0, b = a | 0, x = u | 0, { h: a, l: u } = L(d | 0, l | 0, H | 0, N | 0), d = c | 0, l = f | 0, c = s | 0, f = i | 0, s = o | 0, i = r | 0;
      const ae = Ke(N, G, ve);
      o = Ve(ae, H, te, ne), r = ae | 0;
    }
    ({ h: o, l: r } = L(this.Ah | 0, this.Al | 0, o | 0, r | 0)), { h: s, l: i } = L(this.Bh | 0, this.Bl | 0, s | 0, i | 0), { h: c, l: f } = L(this.Ch | 0, this.Cl | 0, c | 0, f | 0), { h: d, l } = L(this.Dh | 0, this.Dl | 0, d | 0, l | 0), { h: a, l: u } = L(this.Eh | 0, this.El | 0, a | 0, u | 0), { h: b, l: x } = L(this.Fh | 0, this.Fl | 0, b | 0, x | 0), { h: p, l: y } = L(this.Gh | 0, this.Gl | 0, p | 0, y | 0), { h: A, l: R } = L(this.Hh | 0, this.Hl | 0, A | 0, R | 0), this.set(o, r, s, i, c, f, d, l, a, u, b, x, p, y, A, R);
  }
  roundClean() {
    C(v, _);
  }
  destroy() {
    C(this.buffer), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}
class nt extends tt {
  constructor() {
    super(64);
    h(this, "Ah", g[0] | 0);
    h(this, "Al", g[1] | 0);
    h(this, "Bh", g[2] | 0);
    h(this, "Bl", g[3] | 0);
    h(this, "Ch", g[4] | 0);
    h(this, "Cl", g[5] | 0);
    h(this, "Dh", g[6] | 0);
    h(this, "Dl", g[7] | 0);
    h(this, "Eh", g[8] | 0);
    h(this, "El", g[9] | 0);
    h(this, "Fh", g[10] | 0);
    h(this, "Fl", g[11] | 0);
    h(this, "Gh", g[12] | 0);
    h(this, "Gl", g[13] | 0);
    h(this, "Hh", g[14] | 0);
    h(this, "Hl", g[15] | 0);
  }
}
const rt = /* @__PURE__ */ le(
  () => new Ye(),
  /* @__PURE__ */ be(1)
), me = /* @__PURE__ */ le(
  () => new nt(),
  /* @__PURE__ */ be(3)
);
function Ee() {
  const t = typeof globalThis == "object" ? globalThis.crypto : null, e = t == null ? void 0 : t.subtle;
  if (typeof e == "object" && e != null)
    return e;
  throw new Error("crypto.subtle must be defined");
}
function ot(t, e, n) {
  const o = async (r) => {
    $(r);
    const s = Ee();
    return new Uint8Array(await s.digest(t, r));
  };
  return o.webCryptoName = t, o.outputLen = n, o.blockLen = e, o.create = () => {
    throw new Error("not implemented");
  }, o;
}
function st(t) {
  if (ce(t), typeof t.webCryptoName != "string")
    throw new Error("non-web hash");
}
const ct = /* @__PURE__ */ ot("SHA-512", 128, 64);
async function it(t, e, n, o) {
  const r = Ee();
  st(t);
  const s = ue({ dkLen: 32 }, o), { c: i, dkLen: c } = s;
  S(i, "c"), S(c, "dkLen");
  const f = P(e, "password"), d = P(n, "salt"), l = await r.importKey("raw", f, "PBKDF2", !1, [
    "deriveBits"
  ]), a = { name: "PBKDF2", salt: d, iterations: i, hash: t.webCryptoName };
  return new Uint8Array(await r.deriveBits(a, l, 8 * c));
}
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function z(t) {
  return t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array";
}
function He(t, e) {
  return Array.isArray(e) ? e.length === 0 ? !0 : t ? e.every((n) => typeof n == "string") : e.every((n) => Number.isSafeInteger(n)) : !1;
}
function at(t) {
  if (typeof t != "function")
    throw new Error("function expected");
  return !0;
}
function J(t, e) {
  if (typeof e != "string")
    throw new Error(`${t}: string expected`);
  return !0;
}
function F(t) {
  if (!Number.isSafeInteger(t))
    throw new Error(`invalid integer: ${t}`);
}
function q(t) {
  if (!Array.isArray(t))
    throw new Error("array expected");
}
function Q(t, e) {
  if (!He(!0, e))
    throw new Error(`${t}: array of strings expected`);
}
function Le(t, e) {
  if (!He(!1, e))
    throw new Error(`${t}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function ft(...t) {
  const e = (s) => s, n = (s, i) => (c) => s(i(c)), o = t.map((s) => s.encode).reduceRight(n, e), r = t.map((s) => s.decode).reduce(n, e);
  return { encode: o, decode: r };
}
// @__NO_SIDE_EFFECTS__
function dt(t) {
  const e = typeof t == "string" ? t.split("") : t, n = e.length;
  Q("alphabet", e);
  const o = new Map(e.map((r, s) => [r, s]));
  return {
    encode: (r) => (q(r), r.map((s) => {
      if (!Number.isSafeInteger(s) || s < 0 || s >= n)
        throw new Error(`alphabet.encode: digit index outside alphabet "${s}". Allowed: ${t}`);
      return e[s];
    })),
    decode: (r) => (q(r), r.map((s) => {
      J("alphabet.decode", s);
      const i = o.get(s);
      if (i === void 0)
        throw new Error(`Unknown letter: "${s}". Allowed: ${t}`);
      return i;
    }))
  };
}
// @__NO_SIDE_EFFECTS__
function ht(t = "") {
  return J("join", t), {
    encode: (e) => (Q("join.decode", e), e.join(t)),
    decode: (e) => (J("join.decode", e), e.split(t))
  };
}
// @__NO_SIDE_EFFECTS__
function ut(t, e = "=") {
  return F(t), J("padding", e), {
    encode(n) {
      for (Q("padding.encode", n); n.length * t % 8; )
        n.push(e);
      return n;
    },
    decode(n) {
      Q("padding.decode", n);
      let o = n.length;
      if (o * t % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (; o > 0 && n[o - 1] === e; o--)
        if ((o - 1) * t % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      return n.slice(0, o);
    }
  };
}
function oe(t, e, n) {
  if (e < 2)
    throw new Error(`convertRadix: invalid from=${e}, base cannot be less than 2`);
  if (n < 2)
    throw new Error(`convertRadix: invalid to=${n}, base cannot be less than 2`);
  if (q(t), !t.length)
    return [];
  let o = 0;
  const r = [], s = Array.from(t, (c) => {
    if (F(c), c < 0 || c >= e)
      throw new Error(`invalid integer: ${c}`);
    return c;
  }), i = s.length;
  for (; ; ) {
    let c = 0, f = !0;
    for (let d = o; d < i; d++) {
      const l = s[d], a = e * c, u = a + l;
      if (!Number.isSafeInteger(u) || a / e !== c || u - l !== a)
        throw new Error("convertRadix: carry overflow");
      const b = u / n;
      c = u % n;
      const x = Math.floor(b);
      if (s[d] = x, !Number.isSafeInteger(x) || x * n + c !== u)
        throw new Error("convertRadix: carry overflow");
      if (f)
        x ? f = !1 : o = d;
      else continue;
    }
    if (r.push(c), f)
      break;
  }
  for (let c = 0; c < t.length - 1 && t[c] === 0; c++)
    r.push(0);
  return r.reverse();
}
const ke = (t, e) => e === 0 ? t : ke(e, t % e), X = /* @__NO_SIDE_EFFECTS__ */ (t, e) => t + (e - ke(t, e)), re = /* @__PURE__ */ (() => {
  let t = [];
  for (let e = 0; e < 40; e++)
    t.push(2 ** e);
  return t;
})();
function se(t, e, n, o) {
  if (q(t), e <= 0 || e > 32)
    throw new Error(`convertRadix2: wrong from=${e}`);
  if (n <= 0 || n > 32)
    throw new Error(`convertRadix2: wrong to=${n}`);
  if (/* @__PURE__ */ X(e, n) > 32)
    throw new Error(`convertRadix2: carry overflow from=${e} to=${n} carryBits=${/* @__PURE__ */ X(e, n)}`);
  let r = 0, s = 0;
  const i = re[e], c = re[n] - 1, f = [];
  for (const d of t) {
    if (F(d), d >= i)
      throw new Error(`convertRadix2: invalid data word=${d} from=${e}`);
    if (r = r << e | d, s + e > 32)
      throw new Error(`convertRadix2: carry overflow pos=${s} from=${e}`);
    for (s += e; s >= n; s -= n)
      f.push((r >> s - n & c) >>> 0);
    const l = re[s];
    if (l === void 0)
      throw new Error("invalid carry");
    r &= l - 1;
  }
  if (r = r << n - s & c, !o && s >= e)
    throw new Error("Excess padding");
  if (!o && r > 0)
    throw new Error(`Non-zero padding: ${r}`);
  return o && s > 0 && f.push(r >>> 0), f;
}
// @__NO_SIDE_EFFECTS__
function lt(t) {
  F(t);
  const e = 2 ** 8;
  return {
    encode: (n) => {
      if (!z(n))
        throw new Error("radix.encode input should be Uint8Array");
      return oe(Array.from(n), e, t);
    },
    decode: (n) => (Le("radix.decode", n), Uint8Array.from(oe(n, t, e)))
  };
}
// @__NO_SIDE_EFFECTS__
function bt(t, e = !1) {
  if (F(t), t <= 0 || t > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ X(8, t) > 32 || /* @__PURE__ */ X(t, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (n) => {
      if (!z(n))
        throw new Error("radix2.encode input should be Uint8Array");
      return se(Array.from(n), 8, t, !e);
    },
    decode: (n) => (Le("radix2.decode", n), Uint8Array.from(se(n, t, 8, e)))
  };
}
function xt(t, e) {
  return F(t), at(e), {
    encode(n) {
      if (!z(n))
        throw new Error("checksum.encode: input should be Uint8Array");
      const o = e(n).slice(0, t), r = new Uint8Array(n.length + t);
      return r.set(n), r.set(o, n.length), r;
    },
    decode(n) {
      if (!z(n))
        throw new Error("checksum.decode: input should be Uint8Array");
      const o = n.slice(0, -t), r = n.slice(-t), s = e(o).slice(0, t);
      for (let i = 0; i < t; i++)
        if (s[i] !== r[i])
          throw new Error("Invalid checksum");
      return o;
    }
  };
}
const K = {
  alphabet: dt,
  chain: ft,
  checksum: xt,
  convertRadix: oe,
  convertRadix2: se,
  radix: lt,
  radix2: bt,
  join: ht,
  padding: ut
};
/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
const pt = (t) => t[0] === "あいこくしん";
function Ie(t) {
  if (typeof t != "string")
    throw new TypeError("invalid mnemonic type: " + typeof t);
  return t.normalize("NFKD");
}
function Y(t) {
  const e = Ie(t), n = e.split(" ");
  if (![12, 15, 18, 21, 24].includes(n.length))
    throw new Error("Invalid mnemonic");
  return { nfkd: e, words: n };
}
function Ue(t) {
  if ($(t), ![16, 20, 24, 28, 32].includes(t.length))
    throw new Error("invalid entropy length");
}
function mt(t, e = 128) {
  if (S(e), e % 32 !== 0 || e > 256)
    throw new TypeError("Invalid entropy");
  return gt(Re(e / 8), t);
}
const wt = (t) => {
  const e = 8 - t.length / 4;
  return new Uint8Array([rt(t)[0] >> e << e]);
};
function Be(t) {
  if (!Array.isArray(t) || t.length !== 2048 || typeof t[0] != "string")
    throw new Error("Wordlist: expected array of 2048 strings");
  return t.forEach((e) => {
    if (typeof e != "string")
      throw new Error("wordlist: non-string element: " + e);
  }), K.chain(K.checksum(1, wt), K.radix2(11, !0), K.alphabet(t));
}
function yt(t, e) {
  const { words: n } = Y(t), o = Be(e).decode(n);
  return Ue(o), o;
}
function gt(t, e) {
  return Ue(t), Be(e).encode(t).join(pt(e) ? "　" : " ");
}
function Et(t, e) {
  try {
    yt(t, e);
  } catch {
    return !1;
  }
  return !0;
}
const ie = (t) => Ie("mnemonic" + t);
function Ht(t, e = "") {
  return Ne(me, Y(t).nfkd, ie(e), { c: 2048, dkLen: 64 });
}
function Lt(t, e = "") {
  return je(me, Y(t).nfkd, ie(e), { c: 2048, dkLen: 64 });
}
function kt(t, e = "") {
  return it(ct, Y(t).nfkd, ie(e), { c: 2048, dkLen: 64 });
}
export {
  gt as entropyToMnemonic,
  mt as generateMnemonic,
  yt as mnemonicToEntropy,
  Ht as mnemonicToSeed,
  Lt as mnemonicToSeedSync,
  kt as mnemonicToSeedWebcrypto,
  Et as validateMnemonic
};
