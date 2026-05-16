var Tt = Object.defineProperty;
var Bt = (t, e, n) => e in t ? Tt(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : t[e] = n;
var x = (t, e, n) => Bt(t, typeof e != "symbol" ? e + "" : e, n);
import { p as Ct, e as k, d as Pt } from "./broker-error-B2k9KKx_.js";
function _t(t) {
  if (t.length % 2 !== 0) throw new Error("Invalid hex string");
  const e = new Uint8Array(t.length / 2);
  for (let n = 0; n < e.length; n++) e[n] = Number.parseInt(t.slice(n * 2, n * 2 + 2), 16);
  return e;
}
function ie(t) {
  return Array.from(t, (e) => e.toString(16).padStart(2, "0")).join("");
}
/*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
const ot = {
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
}, { p, n: K, Gx: tt, Gy: et, a: M, d: R, h: vt } = ot, $ = 32, D = 64, Zt = (...t) => {
  "captureStackTrace" in Error && typeof Error.captureStackTrace == "function" && Error.captureStackTrace(...t);
}, h = (t = "") => {
  const e = new Error(t);
  throw Zt(e, h), e;
}, Yt = (t) => typeof t == "bigint", Nt = (t) => typeof t == "string", Xt = (t) => t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array", C = (t, e, n = "") => {
  const s = Xt(t), o = t == null ? void 0 : t.length, r = e !== void 0;
  if (!s || r && o !== e) {
    const i = n && `"${n}" `, f = r ? ` of length ${e}` : "", a = s ? `length=${o}` : `type=${typeof t}`;
    h(i + "expected Uint8Array" + f + ", got " + a);
  }
  return t;
}, j = (t) => new Uint8Array(t), it = (t) => Uint8Array.from(t), at = (t, e) => t.toString(16).padStart(e, "0"), ft = (t) => Array.from(C(t)).map((e) => at(e, 2)).join(""), S = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 }, nt = (t) => {
  if (t >= S._0 && t <= S._9)
    return t - S._0;
  if (t >= S.A && t <= S.F)
    return t - (S.A - 10);
  if (t >= S.a && t <= S.f)
    return t - (S.a - 10);
}, lt = (t) => {
  const e = "hex invalid";
  if (!Nt(t))
    return h(e);
  const n = t.length, s = n / 2;
  if (n % 2)
    return h(e);
  const o = j(s);
  for (let r = 0, i = 0; r < s; r++, i += 2) {
    const f = nt(t.charCodeAt(i)), a = nt(t.charCodeAt(i + 1));
    if (f === void 0 || a === void 0)
      return h(e);
    o[r] = f * 16 + a;
  }
  return o;
}, kt = () => globalThis == null ? void 0 : globalThis.crypto, Kt = () => {
  var t;
  return ((t = kt()) == null ? void 0 : t.subtle) ?? h("crypto.subtle must be defined, consider polyfill");
}, F = (...t) => {
  const e = j(t.reduce((s, o) => s + C(o).length, 0));
  let n = 0;
  return t.forEach((s) => {
    e.set(s, n), n += s.length;
  }), e;
}, G = BigInt, I = (t, e, n, s = "bad number: out of range") => Yt(t) && e <= t && t < n ? t : h(s), c = (t, e = p) => {
  const n = t % e;
  return n >= 0n ? n : e + n;
}, dt = (t) => c(t, K), $t = (t, e) => {
  (t === 0n || e <= 0n) && h("no inverse n=" + t + " mod=" + e);
  let n = c(t, e), s = e, o = 0n, r = 1n;
  for (; n !== 0n; ) {
    const i = s / n, f = s % n, a = o - r * i;
    s = n, n = f, o = r, r = a;
  }
  return s === 1n ? c(o, e) : h("no inverse");
}, U = (t) => t instanceof T ? t : h("Point expected"), H = 2n ** 256n, g = class g {
  constructor(e, n, s, o) {
    x(this, "X");
    x(this, "Y");
    x(this, "Z");
    x(this, "T");
    const r = H;
    this.X = I(e, 0n, r), this.Y = I(n, 0n, r), this.Z = I(s, 1n, r), this.T = I(o, 0n, r), Object.freeze(this);
  }
  static CURVE() {
    return ot;
  }
  static fromAffine(e) {
    return new g(e.x, e.y, 1n, c(e.x * e.y));
  }
  /** RFC8032 5.1.3: Uint8Array to Point. */
  static fromBytes(e, n = !1) {
    const s = R, o = it(C(e, $)), r = e[31];
    o[31] = r & -129;
    const i = yt(o);
    I(i, 0n, n ? H : p);
    const a = c(i * i), l = c(a - 1n), d = c(s * a + 1n);
    let { isValid: u, value: y } = Gt(l, d);
    u || h("bad point: y not sqrt");
    const b = (y & 1n) === 1n, w = (r & 128) !== 0;
    return !n && y === 0n && w && h("bad point: x==0, isLastByteOdd"), w !== b && (y = c(-y)), new g(y, i, 1n, c(y * i));
  }
  static fromHex(e, n) {
    return g.fromBytes(lt(e), n);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const e = M, n = R, s = this;
    if (s.is0())
      return h("bad point: ZERO");
    const { X: o, Y: r, Z: i, T: f } = s, a = c(o * o), l = c(r * r), d = c(i * i), u = c(d * d), y = c(a * e), b = c(d * c(y + l)), w = c(u + c(n * c(a * l)));
    if (b !== w)
      return h("bad point: equation left != right (1)");
    const P = c(o * r), _ = c(i * f);
    return P !== _ ? h("bad point: equation left != right (2)") : this;
  }
  /** Equality check: compare points P&Q. */
  equals(e) {
    const { X: n, Y: s, Z: o } = this, { X: r, Y: i, Z: f } = U(e), a = c(n * f), l = c(r * o), d = c(s * f), u = c(i * o);
    return a === l && d === u;
  }
  is0() {
    return this.equals(v);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new g(c(-this.X), this.Y, this.Z, c(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: e, Y: n, Z: s } = this, o = M, r = c(e * e), i = c(n * n), f = c(2n * c(s * s)), a = c(o * r), l = e + n, d = c(c(l * l) - r - i), u = a + i, y = u - f, b = a - i, w = c(d * y), P = c(u * b), _ = c(d * b), N = c(y * u);
    return new g(w, P, N, _);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(e) {
    const { X: n, Y: s, Z: o, T: r } = this, { X: i, Y: f, Z: a, T: l } = U(e), d = M, u = R, y = c(n * i), b = c(s * f), w = c(r * u * l), P = c(o * a), _ = c((n + s) * (i + f) - y - b), N = c(P - w), J = c(P + w), Q = c(b - d * y), St = c(_ * N), xt = c(J * Q), It = c(_ * Q), At = c(N * J);
    return new g(St, xt, At, It);
  }
  subtract(e) {
    return this.add(U(e).negate());
  }
  /**
   * Point-by-scalar multiplication. Scalar must be in range 1 <= n < CURVE.n.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n scalar by which point is multiplied
   * @param safe safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(e, n = !0) {
    if (!n && (e === 0n || this.is0()))
      return v;
    if (I(e, 1n, K), e === 1n)
      return this;
    if (this.equals(B))
      return Vt(e).p;
    let s = v, o = B;
    for (let r = this; e > 0n; r = r.double(), e >>= 1n)
      e & 1n ? s = s.add(r) : n && (o = o.add(r));
    return s;
  }
  multiplyUnsafe(e) {
    return this.multiply(e, !1);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X: e, Y: n, Z: s } = this;
    if (this.equals(v))
      return { x: 0n, y: 1n };
    const o = $t(s, p);
    c(s * o) !== 1n && h("invalid inverse");
    const r = c(e * o), i = c(n * o);
    return { x: r, y: i };
  }
  toBytes() {
    const { x: e, y: n } = this.assertValidity().toAffine(), s = ut(n);
    return s[31] |= e & 1n ? 128 : 0, s;
  }
  toHex() {
    return ft(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(G(vt), !1);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let e = this.multiply(K / 2n, !1).double();
    return K % 2n && (e = e.add(this)), e.is0();
  }
};
x(g, "BASE"), x(g, "ZERO");
let T = g;
const B = new T(tt, et, 1n, c(tt * et)), v = new T(0n, 1n, 1n, 0n);
T.BASE = B;
T.ZERO = v;
const ut = (t) => lt(at(I(t, 0n, H), D)).reverse(), yt = (t) => G("0x" + ft(it(C(t)).reverse())), m = (t, e) => {
  let n = t;
  for (; e-- > 0n; )
    n *= n, n %= p;
  return n;
}, Ft = (t) => {
  const n = t * t % p * t % p, s = m(n, 2n) * n % p, o = m(s, 1n) * t % p, r = m(o, 5n) * o % p, i = m(r, 10n) * r % p, f = m(i, 20n) * i % p, a = m(f, 40n) * f % p, l = m(a, 80n) * a % p, d = m(l, 80n) * a % p, u = m(d, 10n) * r % p;
  return { pow_p_5_8: m(u, 2n) * t % p, b2: n };
}, st = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n, Gt = (t, e) => {
  const n = c(e * e * e), s = c(n * n * e), o = Ft(t * s).pow_p_5_8;
  let r = c(t * n * o);
  const i = c(e * r * r), f = r, a = c(r * st), l = i === t, d = i === c(-t), u = i === c(-t * st);
  return l && (r = f), (d || u) && (r = a), (c(r) & 1n) === 1n && (r = c(-r)), { isValid: l || d, value: r };
}, q = (t) => dt(yt(t)), z = (...t) => Ot.sha512Async(F(...t)), Lt = (t) => {
  const e = t.slice(0, $);
  e[0] &= 248, e[31] &= 127, e[31] |= 64;
  const n = t.slice($, D), s = q(e), o = B.multiply(s), r = o.toBytes();
  return { head: e, prefix: n, scalar: s, point: o, pointBytes: r };
}, ht = (t) => z(C(t, $)).then(Lt), Mt = (t) => ht(t).then((e) => e.pointBytes), Rt = (t) => z(t.hashable).then(t.finish), Ut = (t, e, n) => {
  const { pointBytes: s, scalar: o } = t, r = q(e), i = B.multiply(r).toBytes();
  return { hashable: F(i, s, n), finish: (l) => {
    const d = dt(r + q(l) * o);
    return C(F(i, ut(d)), D);
  } };
}, ae = async (t, e) => {
  const n = C(t), s = await ht(e), o = await z(s.prefix, n);
  return Rt(Ut(s, o, n));
}, Ot = {
  sha512Async: async (t) => {
    const e = Kt(), n = F(t);
    return j(await e.digest("SHA-512", n.buffer));
  },
  sha512: void 0
}, L = 8, Ht = 256, pt = Math.ceil(Ht / L) + 1, V = 2 ** (L - 1), qt = () => {
  const t = [];
  let e = B, n = e;
  for (let s = 0; s < pt; s++) {
    n = e, t.push(n);
    for (let o = 1; o < V; o++)
      n = n.add(e), t.push(n);
    e = n.double();
  }
  return t;
};
let rt;
const ct = (t, e) => {
  const n = e.negate();
  return t ? n : e;
}, Vt = (t) => {
  const e = rt || (rt = qt());
  let n = v, s = B;
  const o = 2 ** L, r = o, i = G(o - 1), f = G(L);
  for (let a = 0; a < pt; a++) {
    let l = Number(t & i);
    t >>= f, l > V && (l -= r, t += 1n);
    const d = a * V, u = d, y = d + Math.abs(l) - 1, b = a % 2 !== 0, w = l < 0;
    l === 0 ? s = s.add(ct(b, e[u])) : n = n.add(ct(w, e[y]));
  }
  return t !== 0n && h("invalid wnaf"), { p: n, f: s };
}, Dt = "wot/identity/ed25519/v1", jt = "wot/encryption/x25519/v1", zt = "", Wt = /^[0-9a-fA-F]*$/;
let X;
async function fe(t, e) {
  if (t.length % 2 !== 0 || !Wt.test(t))
    throw new Error("Invalid BIP39 seed hex");
  const n = _t(t);
  return Et(n, e);
}
async function Et(t, e) {
  if (t.length !== 64) throw new Error("Expected 64-byte BIP39 seed");
  const n = await e.hkdfSha256(t, Dt, 32), s = new Uint8Array(await Mt(n)), o = await e.hkdfSha256(t, jt, 32), r = await e.x25519PublicFromSeed(o), i = Ct(s);
  return { ed25519Seed: n, ed25519PublicKey: s, x25519Seed: o, x25519PublicKey: r, did: i, kid: `${i}#sig-0` };
}
async function Jt(t) {
  const { mnemonicToSeed: e, validateMnemonic: n, englishWordlist: s } = await Qt();
  if (!n(t, s)) throw new Error("Invalid BIP39 mnemonic");
  return e(t, zt);
}
async function le(t, e) {
  const n = await Jt(t);
  return Et(n, e);
}
function Qt() {
  return X || (X = Promise.all([
    import("./index-B-u_jAjs.js"),
    import("./english-YcmYGosR.js")
  ]).then(([t, e]) => ({
    mnemonicToSeed: t.mnemonicToSeed,
    validateMnemonic: t.validateMnemonic,
    englishWordlist: e.wordlist
  })).catch((t) => {
    throw X = void 0, t;
  })), X;
}
const bt = "wot/ecies/v1", Z = 12, A = 32, Y = 32, wt = 16;
async function te(t) {
  E(t.ephemeralPrivateSeed, A, "ECIES ephemeral private seed"), E(t.recipientPublicKey, A, "ECIES recipient public key");
  const e = await t.crypto.x25519PublicFromSeed(t.ephemeralPrivateSeed);
  E(e, A, "ECIES ephemeral public key");
  const n = await t.crypto.x25519SharedSecret(t.ephemeralPrivateSeed, t.recipientPublicKey);
  E(n, A, "ECIES shared secret"), mt(n, "ECIES shared secret");
  const s = await t.crypto.hkdfSha256(n, bt, Y);
  return E(s, Y, "ECIES AES key"), { ephemeralPublicKey: e, sharedSecret: n, aesKey: s };
}
async function de(t) {
  E(t.nonce, Z, "ECIES nonce"), gt(t.plaintext, "ECIES plaintext");
  const e = await te(t), n = await t.crypto.aes256GcmEncrypt(e.aesKey, t.nonce, t.plaintext);
  return W(n, "ECIES ciphertext"), {
    epk: k(e.ephemeralPublicKey),
    nonce: k(t.nonce),
    ciphertext: k(n)
  };
}
async function ue(t) {
  E(t.recipientPrivateSeed, A, "ECIES recipient private seed"), se(t.message);
  const e = O(t.message.epk, "ECIES ephemeral public key"), n = O(t.message.nonce, "ECIES nonce"), s = O(t.message.ciphertext, "ECIES ciphertext");
  E(e, A, "ECIES ephemeral public key"), E(n, Z, "ECIES nonce"), W(s, "ECIES ciphertext");
  const o = await t.crypto.x25519SharedSecret(t.recipientPrivateSeed, e);
  E(o, A, "ECIES shared secret"), mt(o, "ECIES shared secret");
  const r = await t.crypto.hkdfSha256(o, bt, Y);
  return E(r, Y, "ECIES AES key"), t.crypto.aes256GcmDecrypt(r, n, s);
}
async function ee(t, e, n) {
  if (!e) throw new Error("Missing deviceId");
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid seq");
  return (await t.sha256(new TextEncoder().encode(`${e}|${n}`))).slice(0, Z);
}
async function ye(t) {
  E(t.spaceContentKey, Y, "Space content key"), gt(t.plaintext, "Log payload plaintext");
  const e = await ee(t.crypto, t.deviceId, t.seq), n = await t.crypto.aes256GcmEncrypt(t.spaceContentKey, e, t.plaintext);
  W(n, "Encrypted log payload ciphertext");
  const s = ne(e, n);
  return { nonce: e, ciphertextTag: n, blob: s, blobBase64Url: k(s) };
}
async function he(t) {
  E(t.spaceContentKey, Y, "Space content key"), re(t.blob, "encrypted log payload blob");
  const e = t.blob.slice(0, Z), n = t.blob.slice(Z);
  return t.crypto.aes256GcmDecrypt(t.spaceContentKey, e, n);
}
function ne(t, e) {
  const n = new Uint8Array(t.length + e.length);
  return n.set(t), n.set(e, t.length), n;
}
function E(t, e, n) {
  if (t.length !== e) throw new Error(`${n} must be ${e} bytes`);
}
function mt(t, e) {
  let n = 0;
  for (const s of t) n |= s;
  if (n === 0) throw new Error(`${e} must not be all zero bytes`);
}
function se(t) {
  if (typeof t != "object" || t === null || Array.isArray(t)) throw new Error("Invalid ECIES message");
  const e = t;
  if (typeof e.epk != "string" || typeof e.nonce != "string" || typeof e.ciphertext != "string")
    throw new Error("Invalid ECIES message");
}
function gt(t, e) {
  if (t.length === 0) throw new Error(`${e} must not be empty`);
}
function W(t, e) {
  if (t.length <= wt) throw new Error(`${e} must include ciphertext and authentication tag`);
}
function re(t, e) {
  if (t.length <= Z + wt) throw new Error(`Invalid ${e}`);
}
function O(t, e) {
  if (typeof t != "string" || t.length === 0) throw new Error(`${e} must be a non-empty base64url string`);
  if (!/^[A-Za-z0-9_-]+$/.test(t)) throw new Error(`${e} must be a valid base64url string`);
  try {
    return Pt(t);
  } catch {
    throw new Error(`${e} must be a valid base64url string`);
  }
}
export {
  ue as a,
  ie as b,
  he as c,
  fe as d,
  de as e,
  Jt as f,
  Mt as g,
  _t as h,
  te as i,
  ee as j,
  le as k,
  ye as l,
  ae as s
};
