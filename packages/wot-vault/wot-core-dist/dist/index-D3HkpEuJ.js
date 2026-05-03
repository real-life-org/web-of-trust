var lt = Object.defineProperty;
var ht = (t, n, s) => n in t ? lt(t, n, { enumerable: !0, configurable: !0, writable: !0, value: s }) : t[n] = s;
var A = (t, n, s) => ht(t, typeof n != "symbol" ? n + "" : n, s);
/*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
const J = {
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
}, { p, n: S, Gx: P, Gy: j, a: G, d: O, h: yt } = J, L = 32, H = 64, pt = (...t) => {
  "captureStackTrace" in Error && typeof Error.captureStackTrace == "function" && Error.captureStackTrace(...t);
}, y = (t = "") => {
  const n = new Error(t);
  throw pt(n, y), n;
}, bt = (t) => typeof t == "bigint", xt = (t) => typeof t == "string", wt = (t) => t instanceof Uint8Array || ArrayBuffer.isView(t) && t.constructor.name === "Uint8Array", T = (t, n, s = "") => {
  const e = wt(t), f = t == null ? void 0 : t.length, c = n !== void 0;
  if (!e || c && f !== n) {
    const r = s && `"${s}" `, a = c ? ` of length ${n}` : "", i = e ? `length=${f}` : `type=${typeof t}`;
    y(r + "expected Uint8Array" + a + ", got " + i);
  }
  return t;
}, k = (t) => new Uint8Array(t), Q = (t) => Uint8Array.from(t), tt = (t, n) => t.toString(16).padStart(n, "0"), nt = (t) => Array.from(T(t)).map((n) => tt(n, 2)).join(""), m = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 }, z = (t) => {
  if (t >= m._0 && t <= m._9)
    return t - m._0;
  if (t >= m.A && t <= m.F)
    return t - (m.A - 10);
  if (t >= m.a && t <= m.f)
    return t - (m.a - 10);
}, st = (t) => {
  const n = "hex invalid";
  if (!xt(t))
    return y(n);
  const s = t.length, e = s / 2;
  if (s % 2)
    return y(n);
  const f = k(e);
  for (let c = 0, r = 0; c < e; c++, r += 2) {
    const a = z(t.charCodeAt(r)), i = z(t.charCodeAt(r + 1));
    if (a === void 0 || i === void 0)
      return y(n);
    f[c] = a * 16 + i;
  }
  return f;
}, gt = () => globalThis == null ? void 0 : globalThis.crypto, mt = () => {
  var t;
  return ((t = gt()) == null ? void 0 : t.subtle) ?? y("crypto.subtle must be defined, consider polyfill");
}, C = (...t) => {
  const n = k(t.reduce((e, f) => e + T(f).length, 0));
  let s = 0;
  return t.forEach((e) => {
    n.set(e, s), s += e.length;
  }), n;
}, q = BigInt, Z = (t, n, s, e = "bad number: out of range") => bt(t) && n <= t && t < s ? t : y(e), o = (t, n = p) => {
  const s = t % n;
  return s >= 0n ? s : n + s;
}, ot = (t) => o(t, S), At = (t, n) => {
  (t === 0n || n <= 0n) && y("no inverse n=" + t + " mod=" + n);
  let s = o(t, n), e = n, f = 0n, c = 1n;
  for (; s !== 0n; ) {
    const r = e / s, a = e % s, i = f - c * r;
    e = s, s = a, f = c, c = i;
  }
  return e === 1n ? o(f, n) : y("no inverse");
}, U = (t) => t instanceof B ? t : y("Point expected"), N = 2n ** 256n, g = class g {
  constructor(n, s, e, f) {
    A(this, "X");
    A(this, "Y");
    A(this, "Z");
    A(this, "T");
    const c = N;
    this.X = Z(n, 0n, c), this.Y = Z(s, 0n, c), this.Z = Z(e, 1n, c), this.T = Z(f, 0n, c), Object.freeze(this);
  }
  static CURVE() {
    return J;
  }
  static fromAffine(n) {
    return new g(n.x, n.y, 1n, o(n.x * n.y));
  }
  /** RFC8032 5.1.3: Uint8Array to Point. */
  static fromBytes(n, s = !1) {
    const e = O, f = Q(T(n, L)), c = n[31];
    f[31] = c & -129;
    const r = ct(f);
    Z(r, 0n, s ? N : p);
    const i = o(r * r), d = o(i - 1n), u = o(e * i + 1n);
    let { isValid: l, value: h } = Bt(d, u);
    l || y("bad point: y not sqrt");
    const b = (h & 1n) === 1n, x = (c & 128) !== 0;
    return !s && h === 0n && x && y("bad point: x==0, isLastByteOdd"), x !== b && (h = o(-h)), new g(h, r, 1n, o(h * r));
  }
  static fromHex(n, s) {
    return g.fromBytes(st(n), s);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const n = G, s = O, e = this;
    if (e.is0())
      return y("bad point: ZERO");
    const { X: f, Y: c, Z: r, T: a } = e, i = o(f * f), d = o(c * c), u = o(r * r), l = o(u * u), h = o(i * n), b = o(u * o(h + d)), x = o(l + o(s * o(i * d)));
    if (b !== x)
      return y("bad point: equation left != right (1)");
    const Y = o(f * c), E = o(r * a);
    return Y !== E ? y("bad point: equation left != right (2)") : this;
  }
  /** Equality check: compare points P&Q. */
  equals(n) {
    const { X: s, Y: e, Z: f } = this, { X: c, Y: r, Z: a } = U(n), i = o(s * a), d = o(c * f), u = o(e * a), l = o(r * f);
    return i === d && u === l;
  }
  is0() {
    return this.equals(_);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new g(o(-this.X), this.Y, this.Z, o(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: n, Y: s, Z: e } = this, f = G, c = o(n * n), r = o(s * s), a = o(2n * o(e * e)), i = o(f * c), d = n + s, u = o(o(d * d) - c - r), l = i + r, h = l - a, b = i - r, x = o(u * h), Y = o(l * b), E = o(u * b), R = o(h * l);
    return new g(x, Y, R, E);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(n) {
    const { X: s, Y: e, Z: f, T: c } = this, { X: r, Y: a, Z: i, T: d } = U(n), u = G, l = O, h = o(s * r), b = o(e * a), x = o(c * l * d), Y = o(f * i), E = o((s + e) * (r + a) - h - b), R = o(Y - x), $ = o(Y + x), K = o(b - u * h), it = o(E * R), at = o($ * K), dt = o(E * K), ut = o(R * $);
    return new g(it, at, ut, dt);
  }
  subtract(n) {
    return this.add(U(n).negate());
  }
  /**
   * Point-by-scalar multiplication. Scalar must be in range 1 <= n < CURVE.n.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n scalar by which point is multiplied
   * @param safe safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(n, s = !0) {
    if (!s && (n === 0n || this.is0()))
      return _;
    if (Z(n, 1n, S), n === 1n)
      return this;
    if (this.equals(X))
      return St(n).p;
    let e = _, f = X;
    for (let c = this; n > 0n; c = c.double(), n >>= 1n)
      n & 1n ? e = e.add(c) : s && (f = f.add(c));
    return e;
  }
  multiplyUnsafe(n) {
    return this.multiply(n, !1);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X: n, Y: s, Z: e } = this;
    if (this.equals(_))
      return { x: 0n, y: 1n };
    const f = At(e, p);
    o(e * f) !== 1n && y("invalid inverse");
    const c = o(n * f), r = o(s * f);
    return { x: c, y: r };
  }
  toBytes() {
    const { x: n, y: s } = this.assertValidity().toAffine(), e = et(s);
    return e[31] |= n & 1n ? 128 : 0, e;
  }
  toHex() {
    return nt(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(q(yt), !1);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let n = this.multiply(S / 2n, !1).double();
    return S % 2n && (n = n.add(this)), n.is0();
  }
};
A(g, "BASE"), A(g, "ZERO");
let B = g;
const X = new B(P, j, 1n, o(P * j)), _ = new B(0n, 1n, 1n, 0n);
B.BASE = X;
B.ZERO = _;
const et = (t) => st(tt(Z(t, 0n, N), H)).reverse(), ct = (t) => q("0x" + nt(Q(T(t)).reverse())), w = (t, n) => {
  let s = t;
  for (; n-- > 0n; )
    s *= s, s %= p;
  return s;
}, Zt = (t) => {
  const s = t * t % p * t % p, e = w(s, 2n) * s % p, f = w(e, 1n) * t % p, c = w(f, 5n) * f % p, r = w(c, 10n) * c % p, a = w(r, 20n) * r % p, i = w(a, 40n) * a % p, d = w(i, 80n) * i % p, u = w(d, 80n) * i % p, l = w(u, 10n) * c % p;
  return { pow_p_5_8: w(l, 2n) * t % p, b2: s };
}, D = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n, Bt = (t, n) => {
  const s = o(n * n * n), e = o(s * s * n), f = Zt(t * e).pow_p_5_8;
  let c = o(t * s * f);
  const r = o(n * c * c), a = c, i = o(c * D), d = r === t, u = r === o(-t), l = r === o(-t * D);
  return d && (c = a), (u || l) && (c = i), (o(c) & 1n) === 1n && (c = o(-c)), { isValid: d || u, value: c };
}, V = (t) => ot(ct(t)), M = (...t) => Et.sha512Async(C(...t)), Xt = (t) => {
  const n = t.slice(0, L);
  n[0] &= 248, n[31] &= 127, n[31] |= 64;
  const s = t.slice(L, H), e = V(n), f = X.multiply(e), c = f.toBytes();
  return { head: n, prefix: s, scalar: e, point: f, pointBytes: c };
}, ft = (t) => M(T(t, L)).then(Xt), Ct = (t) => ft(t).then((n) => n.pointBytes), Tt = (t) => M(t.hashable).then(t.finish), Yt = (t, n, s) => {
  const { pointBytes: e, scalar: f } = t, c = V(n), r = X.multiply(c).toBytes();
  return { hashable: C(r, e, s), finish: (d) => {
    const u = ot(c + V(d) * f);
    return T(C(r, et(u)), H);
  } };
}, qt = async (t, n) => {
  const s = T(t), e = await ft(n), f = await M(e.prefix, s);
  return Tt(Yt(e, f, s));
}, Et = {
  sha512Async: async (t) => {
    const n = mt(), s = C(t);
    return k(await n.digest("SHA-512", s.buffer));
  },
  sha512: void 0
}, F = 8, _t = 256, rt = Math.ceil(_t / F) + 1, v = 2 ** (F - 1), Rt = () => {
  const t = [];
  let n = X, s = n;
  for (let e = 0; e < rt; e++) {
    s = n, t.push(s);
    for (let f = 1; f < v; f++)
      s = s.add(n), t.push(s);
    n = s.double();
  }
  return t;
};
let I;
const W = (t, n) => {
  const s = n.negate();
  return t ? s : n;
}, St = (t) => {
  const n = I || (I = Rt());
  let s = _, e = X;
  const f = 2 ** F, c = f, r = q(f - 1), a = q(F);
  for (let i = 0; i < rt; i++) {
    let d = Number(t & r);
    t >>= a, d > v && (d -= c, t += 1n);
    const u = i * v, l = u, h = u + Math.abs(d) - 1, b = i % 2 !== 0, x = d < 0;
    d === 0 ? e = e.add(W(b, n[l])) : s = s.add(W(x, n[h]));
  }
  return t !== 0n && y("invalid wnaf"), { p: s, f: e };
};
export {
  Ct as g,
  qt as s
};
