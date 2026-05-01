var en = Object.defineProperty;
var Bt = (n) => {
  throw TypeError(n);
};
var tn = (n, e, t) => e in n ? en(n, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : n[e] = t;
var c = (n, e, t) => tn(n, typeof e != "symbol" ? e + "" : e, t), _t = (n, e, t) => e.has(n) || Bt("Cannot " + t);
var j = (n, e, t) => (_t(n, e, "read from private field"), t ? t.call(n) : e.get(n)), ce = (n, e, t) => e.has(n) ? Bt("Cannot add the same private member more than once") : e instanceof WeakSet ? e.add(n) : e.set(n, t), le = (n, e, t, r) => (_t(n, e, "write to private field"), r ? r.call(n, t) : e.set(n, t), t);
import { openDB as nr } from "idb";
const rn = /* @__PURE__ */ new Set([
  "attestation",
  "verification",
  "contact",
  "space",
  "item"
]);
function nn(n, e, t) {
  return t ? `wot:${n}:${e}/${t}` : `wot:${n}:${e}`;
}
function gi(n) {
  if (!n.startsWith("wot:"))
    throw new Error(`Invalid ResourceRef: must start with "wot:" — got "${n}"`);
  const e = n.slice(4), t = e.indexOf(":");
  if (t === -1)
    throw new Error(`Invalid ResourceRef: missing type — got "${n}"`);
  const r = e.slice(0, t);
  if (!rn.has(r))
    throw new Error(`Invalid ResourceRef: unknown type "${r}" — got "${n}"`);
  const s = e.slice(t + 1);
  if (!s)
    throw new Error(`Invalid ResourceRef: missing id — got "${n}"`);
  const i = s.indexOf("/");
  if (i === -1)
    return { type: r, id: s };
  const a = s.slice(0, i), o = s.slice(i + 1);
  return { type: r, id: a, subPath: o };
}
function bi(n) {
  return {
    getValue: () => n.getValue(),
    subscribe: (e) => {
      let t = !0;
      return n.subscribe((r) => {
        if (t) {
          t = !1;
          return;
        }
        e(r);
      });
    }
  };
}
const Le = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function sn(n) {
  const e = [0];
  for (const r of n) {
    let s = r;
    for (let i = 0; i < e.length; i++)
      s += e[i] << 8, e[i] = s % 58, s = s / 58 | 0;
    for (; s > 0; )
      e.push(s % 58), s = s / 58 | 0;
  }
  let t = "";
  for (const r of n)
    if (r === 0) t += Le[0];
    else break;
  for (let r = e.length - 1; r >= 0; r--)
    t += Le[e[r]];
  return t;
}
function an(n) {
  const e = [0];
  for (const t of n) {
    const r = Le.indexOf(t);
    if (r < 0) throw new Error(`Invalid base58 character: ${t}`);
    let s = r;
    for (let i = 0; i < e.length; i++)
      s += e[i] * 58, e[i] = s & 255, s >>= 8;
    for (; s > 0; )
      e.push(s & 255), s >>= 8;
  }
  for (const t of n)
    if (t === Le[0]) e.push(0);
    else break;
  return new Uint8Array(e.reverse());
}
function C(n) {
  let e = "";
  for (let t = 0; t < n.length; t++)
    e += String.fromCharCode(n[t]);
  return btoa(e).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function I(n) {
  const e = n.replace(/-/g, "+").replace(/_/g, "/"), t = (4 - e.length % 4) % 4, r = e + "=".repeat(t), s = atob(r);
  return Uint8Array.from(s, (i) => i.charCodeAt(0));
}
function on(n) {
  let e = "";
  for (let t = 0; t < n.length; t++)
    e += String.fromCharCode(n[t]);
  return btoa(e);
}
function mi(n) {
  const e = atob(n);
  return Uint8Array.from(e, (t) => t.charCodeAt(0));
}
function k(n) {
  return n.buffer.slice(n.byteOffset, n.byteOffset + n.byteLength);
}
const fe = new Uint8Array([237, 1]);
function cn(n) {
  const e = new Uint8Array(fe.length + n.length);
  return e.set(fe), e.set(n, fe.length), `did:key:${"z" + sn(e)}`;
}
function we(n) {
  if (!n.startsWith("did:key:z"))
    throw new Error("Invalid did:key format");
  const e = n.slice(9), t = an(e);
  if (t[0] !== fe[0] || t[1] !== fe[1])
    throw new Error("Invalid multicodec prefix for Ed25519");
  return t.slice(fe.length);
}
function wi(n) {
  try {
    return n.startsWith("did:key:z") ? (we(n), !0) : !1;
  } catch {
    return !1;
  }
}
function Si(n) {
  return n ? `User-${n.slice(-6)}` : "User";
}
async function ln(n, e) {
  const t = {
    alg: "EdDSA",
    typ: "JWT"
  }, r = C(
    new TextEncoder().encode(JSON.stringify(t))
  ), s = C(
    new TextEncoder().encode(JSON.stringify(n))
  ), i = `${r}.${s}`, a = new TextEncoder().encode(i), o = await crypto.subtle.sign(
    "Ed25519",
    e,
    a
  ), l = new Uint8Array(o), u = C(l);
  return `${i}.${u}`;
}
async function wt(n, e) {
  try {
    const t = n.split(".");
    if (t.length !== 3)
      return { valid: !1, error: "Invalid JWS format" };
    const [r, s, i] = t, a = I(r), o = JSON.parse(new TextDecoder().decode(a));
    if (o.alg !== "EdDSA")
      return { valid: !1, error: `Unsupported algorithm: ${o.alg}` };
    const l = I(s), u = JSON.parse(new TextDecoder().decode(l)), h = I(i), d = `${r}.${s}`, f = new TextEncoder().encode(d);
    return { valid: await crypto.subtle.verify(
      "Ed25519",
      e,
      k(h),
      f
    ), payload: u };
  } catch (t) {
    return {
      valid: !1,
      error: t instanceof Error ? t.message : "Verification failed"
    };
  }
}
function Fe(n) {
  try {
    const e = n.split(".");
    if (e.length !== 3) return null;
    const t = I(e[1]);
    return JSON.parse(new TextDecoder().decode(t));
  } catch {
    return null;
  }
}
const Ve = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function Mt(n) {
  const e = [0];
  for (const r of n) {
    let s = r;
    for (let i = 0; i < e.length; i++)
      s += e[i] << 8, e[i] = s % 58, s = s / 58 | 0;
    for (; s > 0; )
      e.push(s % 58), s = s / 58 | 0;
  }
  let t = "";
  for (const r of n)
    if (r === 0) t += Ve[0];
    else break;
  for (let r = e.length - 1; r >= 0; r--) t += Ve[e[r]];
  return t;
}
function Kt(n) {
  const e = [0];
  for (const t of n) {
    const r = Ve.indexOf(t);
    if (r < 0) throw new Error(`Invalid base58 character: ${t}`);
    let s = r;
    for (let i = 0; i < e.length; i++)
      s += e[i] * 58, e[i] = s & 255, s >>= 8;
    for (; s > 0; )
      e.push(s & 255), s >>= 8;
  }
  for (const t of n)
    if (t === Ve[0]) e.push(0);
    else break;
  return new Uint8Array(e.reverse());
}
function x(n) {
  let e = "";
  for (let t = 0; t < n.length; t++) e += String.fromCharCode(n[t]);
  return btoa(e).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function K(n) {
  const e = n.replace(/-/g, "+").replace(/_/g, "/"), t = e + "=".repeat((4 - e.length % 4) % 4), r = atob(t);
  return Uint8Array.from(r, (s) => s.charCodeAt(0));
}
function it(n) {
  if (n.length % 2 !== 0) throw new Error("Invalid hex string");
  const e = new Uint8Array(n.length / 2);
  for (let t = 0; t < e.length; t++) e[t] = Number.parseInt(n.slice(t * 2, t * 2 + 2), 16);
  return e;
}
function sr(n) {
  return Array.from(n, (e) => e.toString(16).padStart(2, "0")).join("");
}
function Je(n) {
  if (n === null) return "null";
  if (typeof n == "boolean") return n ? "true" : "false";
  if (typeof n == "number") {
    if (!Number.isFinite(n)) throw new Error("JCS does not support non-finite numbers");
    return JSON.stringify(Object.is(n, -0) ? 0 : n);
  }
  return typeof n == "string" ? JSON.stringify(n) : Array.isArray(n) ? `[${n.map((t) => Je(t)).join(",")}]` : `{${Object.keys(n).sort().map((t) => `${JSON.stringify(t)}:${Je(n[t])}`).join(",")}}`;
}
function We(n) {
  return new TextEncoder().encode(Je(n));
}
/*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
const ir = {
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
}, { p: M, n: Re, Gx: Nt, Gy: jt, a: ut, d: dt, h: un } = ir, qe = 32, Pt = 64, dn = (...n) => {
  "captureStackTrace" in Error && typeof Error.captureStackTrace == "function" && Error.captureStackTrace(...n);
}, A = (n = "") => {
  const e = new Error(n);
  throw dn(e, A), e;
}, hn = (n) => typeof n == "bigint", fn = (n) => typeof n == "string", yn = (n) => n instanceof Uint8Array || ArrayBuffer.isView(n) && n.constructor.name === "Uint8Array", ie = (n, e, t = "") => {
  const r = yn(n), s = n == null ? void 0 : n.length, i = e !== void 0;
  if (!r || i && s !== e) {
    const a = t && `"${t}" `, o = i ? ` of length ${e}` : "", l = r ? `length=${s}` : `type=${typeof n}`;
    A(a + "expected Uint8Array" + o + ", got " + l);
  }
  return n;
}, Tt = (n) => new Uint8Array(n), ar = (n) => Uint8Array.from(n), or = (n, e) => n.toString(16).padStart(e, "0"), cr = (n) => Array.from(ie(n)).map((e) => or(e, 2)).join(""), R = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 }, Rt = (n) => {
  if (n >= R._0 && n <= R._9)
    return n - R._0;
  if (n >= R.A && n <= R.F)
    return n - (R.A - 10);
  if (n >= R.a && n <= R.f)
    return n - (R.a - 10);
}, lr = (n) => {
  const e = "hex invalid";
  if (!fn(n))
    return A(e);
  const t = n.length, r = t / 2;
  if (t % 2)
    return A(e);
  const s = Tt(r);
  for (let i = 0, a = 0; i < r; i++, a += 2) {
    const o = Rt(n.charCodeAt(a)), l = Rt(n.charCodeAt(a + 1));
    if (o === void 0 || l === void 0)
      return A(e);
    s[i] = o * 16 + l;
  }
  return s;
}, pn = () => globalThis == null ? void 0 : globalThis.crypto, gn = () => {
  var n;
  return ((n = pn()) == null ? void 0 : n.subtle) ?? A("crypto.subtle must be defined, consider polyfill");
}, Ge = (...n) => {
  const e = Tt(n.reduce((r, s) => r + ie(s).length, 0));
  let t = 0;
  return n.forEach((r) => {
    e.set(r, t), t += r.length;
  }), e;
}, Xe = BigInt, Q = (n, e, t, r = "bad number: out of range") => hn(n) && e <= n && n < t ? n : A(r), y = (n, e = M) => {
  const t = n % e;
  return t >= 0n ? t : e + t;
}, ur = (n) => y(n, Re), bn = (n, e) => {
  (n === 0n || e <= 0n) && A("no inverse n=" + n + " mod=" + e);
  let t = y(n, e), r = e, s = 0n, i = 1n;
  for (; t !== 0n; ) {
    const a = r / t, o = r % t, l = s - i * a;
    r = t, t = o, s = i, i = l;
  }
  return r === 1n ? y(s, e) : A("no inverse");
}, ht = (n) => n instanceof te ? n : A("Point expected"), St = 2n ** 256n, B = class B {
  constructor(e, t, r, s) {
    c(this, "X");
    c(this, "Y");
    c(this, "Z");
    c(this, "T");
    const i = St;
    this.X = Q(e, 0n, i), this.Y = Q(t, 0n, i), this.Z = Q(r, 1n, i), this.T = Q(s, 0n, i), Object.freeze(this);
  }
  static CURVE() {
    return ir;
  }
  static fromAffine(e) {
    return new B(e.x, e.y, 1n, y(e.x * e.y));
  }
  /** RFC8032 5.1.3: Uint8Array to Point. */
  static fromBytes(e, t = !1) {
    const r = dt, s = ar(ie(e, qe)), i = e[31];
    s[31] = i & -129;
    const a = hr(s);
    Q(a, 0n, t ? St : M);
    const l = y(a * a), u = y(l - 1n), h = y(r * l + 1n);
    let { isValid: d, value: f } = wn(u, h);
    d || A("bad point: y not sqrt");
    const g = (f & 1n) === 1n, p = (i & 128) !== 0;
    return !t && f === 0n && p && A("bad point: x==0, isLastByteOdd"), p !== g && (f = y(-f)), new B(f, a, 1n, y(f * a));
  }
  static fromHex(e, t) {
    return B.fromBytes(lr(e), t);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const e = ut, t = dt, r = this;
    if (r.is0())
      return A("bad point: ZERO");
    const { X: s, Y: i, Z: a, T: o } = r, l = y(s * s), u = y(i * i), h = y(a * a), d = y(h * h), f = y(l * e), g = y(h * y(f + u)), p = y(d + y(t * y(l * u)));
    if (g !== p)
      return A("bad point: equation left != right (1)");
    const w = y(s * i), v = y(a * o);
    return w !== v ? A("bad point: equation left != right (2)") : this;
  }
  /** Equality check: compare points P&Q. */
  equals(e) {
    const { X: t, Y: r, Z: s } = this, { X: i, Y: a, Z: o } = ht(e), l = y(t * o), u = y(i * s), h = y(r * o), d = y(a * s);
    return l === u && h === d;
  }
  is0() {
    return this.equals(he);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new B(y(-this.X), this.Y, this.Z, y(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: e, Y: t, Z: r } = this, s = ut, i = y(e * e), a = y(t * t), o = y(2n * y(r * r)), l = y(s * i), u = e + t, h = y(y(u * u) - i - a), d = l + a, f = d - o, g = l - a, p = y(h * f), w = y(d * g), v = y(h * g), P = y(f * d);
    return new B(p, w, P, v);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(e) {
    const { X: t, Y: r, Z: s, T: i } = this, { X: a, Y: o, Z: l, T: u } = ht(e), h = ut, d = dt, f = y(t * a), g = y(r * o), p = y(i * d * u), w = y(s * l), v = y((t + r) * (a + o) - f - g), P = y(w - p), F = y(w + p), m = y(g - h * f), $ = y(v * P), z = y(F * m), xe = y(v * m), Ae = y(P * F);
    return new B($, z, Ae, xe);
  }
  subtract(e) {
    return this.add(ht(e).negate());
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
      return he;
    if (Q(e, 1n, Re), e === 1n)
      return this;
    if (this.equals(re))
      return Dn(e).p;
    let r = he, s = re;
    for (let i = this; e > 0n; i = i.double(), e >>= 1n)
      e & 1n ? r = r.add(i) : t && (s = s.add(i));
    return r;
  }
  multiplyUnsafe(e) {
    return this.multiply(e, !1);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X: e, Y: t, Z: r } = this;
    if (this.equals(he))
      return { x: 0n, y: 1n };
    const s = bn(r, M);
    y(r * s) !== 1n && A("invalid inverse");
    const i = y(e * s), a = y(t * s);
    return { x: i, y: a };
  }
  toBytes() {
    const { x: e, y: t } = this.assertValidity().toAffine(), r = dr(t);
    return r[31] |= e & 1n ? 128 : 0, r;
  }
  toHex() {
    return cr(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(Xe(un), !1);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let e = this.multiply(Re / 2n, !1).double();
    return Re % 2n && (e = e.add(this)), e.is0();
  }
};
c(B, "BASE"), c(B, "ZERO");
let te = B;
const re = new te(Nt, jt, 1n, y(Nt * jt)), he = new te(0n, 1n, 1n, 0n);
te.BASE = re;
te.ZERO = he;
const dr = (n) => lr(or(Q(n, 0n, St), Pt)).reverse(), hr = (n) => Xe("0x" + cr(ar(ie(n)).reverse())), U = (n, e) => {
  let t = n;
  for (; e-- > 0n; )
    t *= t, t %= M;
  return t;
}, mn = (n) => {
  const t = n * n % M * n % M, r = U(t, 2n) * t % M, s = U(r, 1n) * n % M, i = U(s, 5n) * s % M, a = U(i, 10n) * i % M, o = U(a, 20n) * a % M, l = U(o, 40n) * o % M, u = U(l, 80n) * l % M, h = U(u, 80n) * l % M, d = U(h, 10n) * i % M;
  return { pow_p_5_8: U(d, 2n) * n % M, b2: t };
}, Ht = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n, wn = (n, e) => {
  const t = y(e * e * e), r = y(t * t * e), s = mn(n * r).pow_p_5_8;
  let i = y(n * t * s);
  const a = y(e * i * i), o = i, l = y(i * Ht), u = a === n, h = a === y(-n), d = a === y(-n * Ht);
  return u && (i = o), (h || d) && (i = l), (y(i) & 1n) === 1n && (i = y(-i)), { isValid: u || h, value: i };
}, kt = (n) => ur(hr(n)), Ct = (...n) => En.sha512Async(Ge(...n)), Sn = (n) => {
  const e = n.slice(0, qe);
  e[0] &= 248, e[31] &= 127, e[31] |= 64;
  const t = n.slice(qe, Pt), r = kt(e), s = re.multiply(r), i = s.toBytes();
  return { head: e, prefix: t, scalar: r, point: s, pointBytes: i };
}, fr = (n) => Ct(ie(n, qe)).then(Sn), It = (n) => fr(n).then((e) => e.pointBytes), kn = (n) => Ct(n.hashable).then(n.finish), vn = (n, e, t) => {
  const { pointBytes: r, scalar: s } = n, i = kt(e), a = re.multiply(i).toBytes();
  return { hashable: Ge(a, r, t), finish: (u) => {
    const h = ur(i + kt(u) * s);
    return ie(Ge(a, dr(h)), Pt);
  } };
}, vt = async (n, e) => {
  const t = ie(n), r = await fr(e), s = await Ct(r.prefix, t);
  return kn(vn(r, s, t));
}, En = {
  sha512Async: async (n) => {
    const e = gn(), t = Ge(n);
    return Tt(await e.digest("SHA-512", t.buffer));
  },
  sha512: void 0
}, Ye = 8, xn = 256, yr = Math.ceil(xn / Ye) + 1, Et = 2 ** (Ye - 1), An = () => {
  const n = [];
  let e = re, t = e;
  for (let r = 0; r < yr; r++) {
    t = e, n.push(t);
    for (let s = 1; s < Et; s++)
      t = t.add(e), n.push(t);
    e = t.double();
  }
  return n;
};
let Lt;
const Ft = (n, e) => {
  const t = e.negate();
  return n ? t : e;
}, Dn = (n) => {
  const e = Lt || (Lt = An());
  let t = he, r = re;
  const s = 2 ** Ye, i = s, a = Xe(s - 1), o = Xe(Ye);
  for (let l = 0; l < yr; l++) {
    let u = Number(n & a);
    n >>= o, u > Et && (u -= i, n += 1n);
    const h = l * Et, d = h, f = h + Math.abs(u) - 1, g = l % 2 !== 0, p = u < 0;
    u === 0 ? r = r.add(Ft(g, e[d])) : t = t.add(Ft(p, e[f]));
  }
  return n !== 0n && A("invalid wnaf"), { p: t, f: r };
};
function ae(n) {
  const e = n.split(".");
  if (e.length !== 3) throw new Error("Invalid JWS compact serialization");
  const [t, r, s] = e;
  return {
    header: JSON.parse(new TextDecoder().decode(K(t))),
    payload: JSON.parse(new TextDecoder().decode(K(r))),
    signingInput: new TextEncoder().encode(`${t}.${r}`),
    signature: K(s)
  };
}
async function ke(n, e, t) {
  if (t.length !== 32) throw new Error("Expected Ed25519 signing seed");
  return Ce(n, e, (r) => vt(r, t));
}
async function Ce(n, e, t) {
  if (n.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  const r = x(We(n)), s = x(We(e)), i = new TextEncoder().encode(`${r}.${s}`), a = await t(i);
  return `${r}.${s}.${x(a)}`;
}
async function oe(n, e) {
  const t = ae(n);
  if (t.header.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  if (!await e.crypto.verifyEd25519(t.signingInput, t.signature, e.publicKey)) throw new Error("Invalid JWS signature");
  return t;
}
const ye = new Uint8Array([237, 1]), pe = new Uint8Array([236, 1]);
function $t(n) {
  return `did:key:${at(n)}`;
}
function at(n) {
  const e = new Uint8Array(ye.length + n.length);
  return e.set(ye), e.set(n, ye.length), `z${Mt(e)}`;
}
function pr(n) {
  const e = new Uint8Array(pe.length + n.length);
  return e.set(pe), e.set(n, pe.length), `z${Mt(e)}`;
}
function ve(n) {
  return n.split("#", 1)[0];
}
function L(n) {
  const e = ve(n);
  if (!e.startsWith("did:key:z")) throw new Error("Expected did:key");
  return zt(`z${e.slice(9)}`);
}
function zt(n) {
  if (!n.startsWith("z")) throw new Error("Expected base58btc multibase key");
  const e = Kt(n.slice(1));
  if (e[0] !== ye[0] || e[1] !== ye[1])
    throw new Error("Expected Ed25519 multibase key");
  return e.slice(ye.length);
}
function Mn(n) {
  if (!n.startsWith("z")) throw new Error("Expected base58btc multibase key");
  const e = Kt(n.slice(1));
  if (e[0] !== pe[0] || e[1] !== pe[1])
    throw new Error("Expected X25519 multibase key");
  return e.slice(pe.length);
}
function gr(n, e = {}) {
  const t = at(L(n)), r = {
    id: n,
    verificationMethod: [
      {
        id: "#sig-0",
        type: "Ed25519VerificationKey2020",
        controller: n,
        publicKeyMultibase: t
      }
    ],
    authentication: ["#sig-0"],
    assertionMethod: ["#sig-0"],
    keyAgreement: e.keyAgreement ?? []
  };
  return e.service && (r.service = e.service), r;
}
async function Kn(n) {
  if (n.payload.iss !== ve(n.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return Ut(n.payload), ke(
    { alg: "EdDSA", kid: n.issuerKid, typ: "wot-device-key-binding+jwt" },
    n.payload,
    n.signingSeed
  );
}
async function Pn(n) {
  if (n.payload.iss !== ve(n.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return Ut(n.payload), Ce(
    { alg: "EdDSA", kid: n.issuerKid, typ: "wot-device-key-binding+jwt" },
    n.payload,
    n.sign
  );
}
async function br(n, e) {
  const { header: t, payload: r } = ae(n);
  if (t.alg !== "EdDSA") throw new Error("Invalid DeviceKeyBinding alg");
  if (t.typ !== "wot-device-key-binding+jwt") throw new Error("Invalid DeviceKeyBinding typ");
  if (!t.kid) throw new Error("Missing DeviceKeyBinding kid");
  if (r.type !== "device-key-binding") throw new Error("Invalid DeviceKeyBinding type");
  if (r.iss !== ve(t.kid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return await oe(n, {
    publicKey: L(t.kid),
    crypto: e.crypto
  }), Ut(r), r;
}
function Ut(n) {
  if (n.sub !== n.deviceKid) throw new Error("DeviceKeyBinding sub/deviceKid mismatch");
  const e = L(n.deviceKid);
  if (n.devicePublicKeyMultibase !== at(e))
    throw new Error("DeviceKeyBinding public key mismatch");
}
const Tn = "wot/identity/ed25519/v1", Cn = "wot/encryption/x25519/v1";
async function mr(n, e) {
  const t = it(n), r = await e.hkdfSha256(t, Tn, 32), s = new Uint8Array(await It(r)), i = await e.hkdfSha256(t, Cn, 32), a = await e.x25519PublicFromSeed(i), o = $t(s);
  return { ed25519Seed: r, ed25519PublicKey: s, x25519Seed: i, x25519PublicKey: a, did: o, kid: `${o}#sig-0` };
}
async function In(n, e, t) {
  if (!e) throw new Error("Missing spaceId");
  const r = it(n), s = `wot/space-admin/${e}/v1`, i = await t.hkdfSha256(r, s, 32), a = new Uint8Array(await It(i));
  return { hkdfInfo: s, ed25519Seed: i, ed25519PublicKey: a, did: $t(a) };
}
const wr = "wot/ecies/v1", ge = 12;
async function Sr(n) {
  const e = await n.crypto.x25519PublicFromSeed(n.ephemeralPrivateSeed), t = await n.crypto.x25519SharedSecret(n.ephemeralPrivateSeed, n.recipientPublicKey), r = await n.crypto.hkdfSha256(t, wr, 32);
  return { ephemeralPublicKey: e, sharedSecret: t, aesKey: r };
}
async function kr(n) {
  ot(n.nonce, ge, "ECIES nonce");
  const e = await Sr(n), t = await n.crypto.aes256GcmEncrypt(e.aesKey, n.nonce, n.plaintext);
  return {
    epk: x(e.ephemeralPublicKey),
    nonce: x(n.nonce),
    ciphertext: x(t)
  };
}
async function vr(n) {
  const e = K(n.message.epk), t = K(n.message.nonce), r = K(n.message.ciphertext);
  ot(t, ge, "ECIES nonce");
  const s = await n.crypto.x25519SharedSecret(n.recipientPrivateSeed, e), i = await n.crypto.hkdfSha256(s, wr, 32);
  return n.crypto.aes256GcmDecrypt(i, t, r);
}
async function Er(n, e, t) {
  if (!e) throw new Error("Missing deviceId");
  if (!Number.isInteger(t) || t < 0) throw new Error("Invalid seq");
  return (await n.sha256(new TextEncoder().encode(`${e}|${t}`))).slice(0, ge);
}
async function $n(n) {
  ot(n.spaceContentKey, 32, "Space content key");
  const e = await Er(n.crypto, n.deviceId, n.seq), t = await n.crypto.aes256GcmEncrypt(n.spaceContentKey, e, n.plaintext), r = Un(e, t);
  return { nonce: e, ciphertextTag: t, blob: r, blobBase64Url: x(r) };
}
async function zn(n) {
  if (ot(n.spaceContentKey, 32, "Space content key"), n.blob.length <= ge) throw new Error("Invalid encrypted log payload blob");
  const e = n.blob.slice(0, ge), t = n.blob.slice(ge);
  return n.crypto.aes256GcmDecrypt(n.spaceContentKey, e, t);
}
function Un(n, e) {
  const t = new Uint8Array(n.length + e.length);
  return t.set(n), t.set(e, n.length), t;
}
function ot(n, e, t) {
  if (n.length !== e) throw new Error(`${t} must be ${e} bytes`);
}
async function On(n) {
  return ke(
    { alg: "EdDSA", kid: n.payload.authorKid },
    n.payload,
    n.signingSeed
  );
}
async function Bn(n, e) {
  const { header: t, payload: r } = ae(n);
  if (t.alg !== "EdDSA") throw new Error("Invalid log entry alg");
  if (!t.kid) throw new Error("Missing log entry kid");
  if (r.authorKid !== t.kid) throw new Error("Log entry authorKid mismatch");
  return await oe(n, {
    publicKey: L(r.authorKid),
    crypto: e.crypto
  }), _n(r), r;
}
function _n(n) {
  if (!Number.isInteger(n.seq) || n.seq < 0) throw new Error("Invalid log entry seq");
  if (!n.deviceId) throw new Error("Missing log entry deviceId");
  if (!n.docId) throw new Error("Missing log entry docId");
  if (!n.authorKid) throw new Error("Missing log entry authorKid");
  if (!Number.isInteger(n.keyGeneration) || n.keyGeneration < 0)
    throw new Error("Invalid log entry keyGeneration");
  if (!n.data) throw new Error("Missing log entry data");
  if (Number.isNaN(Date.parse(n.timestamp))) throw new Error("Invalid log entry timestamp");
}
const Vt = "wot/personal-doc/v1";
async function Nn(n, e) {
  const t = it(n), r = await e.hkdfSha256(t, Vt, 32);
  return { hkdfInfo: Vt, key: r, docId: xr(r) };
}
function xr(n) {
  if (n.length < 16) throw new Error("Personal Doc key must be at least 16 bytes");
  const e = n.slice(0, 16);
  return [
    De(e.slice(0, 4)),
    De(e.slice(4, 6)),
    De(e.slice(6, 8)),
    De(e.slice(8, 10)),
    De(e.slice(10, 16))
  ].join("-");
}
function De(n) {
  return Array.from(n, (e) => e.toString(16).padStart(2, "0")).join("");
}
async function jn(n) {
  return ke(
    { alg: "EdDSA", kid: Ar(n.payload), typ: "wot-capability+jwt" },
    n.payload,
    n.signingSeed
  );
}
async function Rn(n, e) {
  const { header: t, payload: r } = ae(n);
  if (t.alg !== "EdDSA") throw new Error("Invalid capability alg");
  if (t.typ !== "wot-capability+jwt") throw new Error("Invalid capability typ");
  if (t.kid !== Ar(r)) throw new Error("Capability kid mismatch");
  return await oe(n, {
    publicKey: e.publicKey,
    crypto: e.crypto
  }), Hn(r, e), r;
}
function Ar(n) {
  return `wot:space:${n.spaceId}#cap-${n.generation}`;
}
function Hn(n, e) {
  if (n.type !== "capability") throw new Error("Invalid capability type");
  if (!n.spaceId) throw new Error("Missing capability spaceId");
  if (!n.audience) throw new Error("Missing capability audience");
  if (!Array.isArray(n.permissions) || n.permissions.length === 0)
    throw new Error("Missing capability permissions");
  if (!Number.isInteger(n.generation) || n.generation < 0) throw new Error("Invalid capability generation");
  if (Number.isNaN(Date.parse(n.issuedAt))) throw new Error("Invalid capability issuedAt");
  if (Number.isNaN(Date.parse(n.validUntil))) throw new Error("Invalid capability validUntil");
  if (e.expectedSpaceId !== void 0 && n.spaceId !== e.expectedSpaceId)
    throw new Error("Capability spaceId mismatch");
  if (e.expectedAudience !== void 0 && n.audience !== e.expectedAudience)
    throw new Error("Capability audience mismatch");
  if (e.expectedGeneration !== void 0 && n.generation !== e.expectedGeneration)
    throw new Error("Capability generation mismatch");
  if (e.now && e.now.getTime() >= Date.parse(n.validUntil)) throw new Error("Capability expired");
}
async function Ln(n) {
  return ke(
    { alg: "EdDSA", kid: n.kid, typ: "vc+jwt" },
    n.payload,
    n.signingSeed
  );
}
async function Dr(n) {
  return Ce(
    { alg: "EdDSA", kid: n.kid, typ: "vc+jwt" },
    n.payload,
    n.sign
  );
}
async function Mr(n, e) {
  const t = await oe(n, {
    publicKey: L(Fn(n)),
    crypto: e.crypto
  }), r = t.payload, s = t.header;
  if (s.typ !== "vc+jwt") throw new Error("Invalid attestation JWS typ");
  if (r.issuer !== r.iss) throw new Error("Attestation issuer and iss differ");
  if (r.iss !== ve(s.kid ?? "")) throw new Error("Attestation iss does not match kid DID");
  if (!r.type.includes("WotAttestation")) throw new Error("Missing WotAttestation type");
  if (r.credentialSubject.id !== r.sub) throw new Error("Attestation subject mismatch");
  return r;
}
function Fn(n) {
  const e = n.split(".")[0];
  if (!e) throw new Error("Invalid JWS");
  const t = JSON.parse(new TextDecoder().decode(K(e)));
  if (!t.kid) throw new Error("Missing JWS kid");
  return t.kid;
}
async function Vn(n) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await ke(
      { alg: "EdDSA", kid: n.deviceKid, typ: "vc+jwt" },
      n.attestationPayload,
      n.deviceSigningSeed
    ),
    deviceKeyBindingJws: n.deviceKeyBindingJws
  };
}
async function Jn(n) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await Ce(
      { alg: "EdDSA", kid: n.deviceKid, typ: "vc+jwt" },
      n.attestationPayload,
      n.sign
    ),
    deviceKeyBindingJws: n.deviceKeyBindingJws
  };
}
async function Wn(n, e) {
  if (n.type !== "wot-delegated-attestation-bundle/v1") throw new Error("Invalid delegated attestation bundle type");
  const t = e.requiredCapability ?? "sign-attestation", r = await br(n.deviceKeyBindingJws, { crypto: e.crypto }), { header: s, payload: i } = ae(n.attestationJws);
  if (s.alg !== "EdDSA") throw new Error("Invalid attestation alg");
  if (s.kid !== r.deviceKid) throw new Error("Attestation kid does not match deviceKid");
  if (await oe(n.attestationJws, {
    publicKey: L(r.deviceKid),
    crypto: e.crypto
  }), i.issuer !== r.iss || i.iss !== r.iss)
    throw new Error("Delegated attestation issuer mismatch");
  if (!r.capabilities.includes(t)) throw new Error("Missing required device capability");
  if (typeof i.iat != "number") throw new Error("Delegated attestation requires iat");
  const a = Date.parse(r.validFrom) / 1e3, o = Date.parse(r.validUntil) / 1e3;
  if (!(a <= i.iat && i.iat <= o))
    throw new Error("Attestation iat outside delegation window");
  return { attestationPayload: i, bindingPayload: r };
}
function Kr(n) {
  return x(We(n));
}
async function Pr(n, e) {
  return x(await e.sha256(new TextEncoder().encode(n)));
}
function qn(n, e) {
  return `${n}~${e.map(Kr).join("~")}~`;
}
async function Gn(n, e) {
  const t = n.split("~");
  if (t.length < 2 || t[t.length - 1] !== "") throw new Error("Invalid SD-JWT compact serialization");
  const r = t[0], s = t.slice(1, -1), i = ae(r);
  if (!i.header.kid) throw new Error("Missing SD-JWT issuer kid");
  const a = await oe(r, {
    publicKey: L(i.header.kid),
    crypto: e.crypto
  }), o = await Promise.all(
    s.map((l) => Pr(l, e.crypto))
  );
  return Yn(a.payload, o), {
    issuerPayload: a.payload,
    disclosures: s.map(Xn),
    disclosureDigests: o
  };
}
function Xn(n) {
  return JSON.parse(new TextDecoder().decode(K(n)));
}
function Yn(n, e) {
  const t = JSON.stringify(n);
  for (const r of e)
    if (!t.includes(`"${r}"`)) throw new Error("SD-JWT disclosure digest not present");
}
const ki = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  bytesToHex: sr,
  canonicalize: Je,
  canonicalizeToBytes: We,
  createAttestationVcJws: Ln,
  createAttestationVcJwsWithSigner: Dr,
  createDelegatedAttestationBundle: Vn,
  createDelegatedAttestationBundleWithSigner: Jn,
  createDeviceKeyBindingJws: Kn,
  createDeviceKeyBindingJwsWithSigner: Pn,
  createJcsEd25519Jws: ke,
  createJcsEd25519JwsWithSigner: Ce,
  createLogEntryJws: On,
  createSdJwtVcCompact: qn,
  createSpaceCapabilityJws: jn,
  decodeBase58: Kt,
  decodeBase64Url: K,
  decodeJws: ae,
  decryptEcies: vr,
  decryptLogPayload: zn,
  deriveEciesMaterial: Sr,
  deriveLogPayloadNonce: Er,
  derivePersonalDocFromSeedHex: Nn,
  deriveProtocolIdentityFromSeedHex: mr,
  deriveSpaceAdminKeyFromSeedHex: In,
  didKeyToPublicKeyBytes: L,
  didOrKidToDid: ve,
  digestSdJwtDisclosure: Pr,
  ed25519MultibaseToPublicKeyBytes: zt,
  ed25519PublicKeyToMultibase: at,
  encodeBase58: Mt,
  encodeBase64Url: x,
  encodeSdJwtDisclosure: Kr,
  encryptEcies: kr,
  encryptLogPayload: $n,
  hexToBytes: it,
  personalDocIdFromKey: xr,
  publicKeyToDidKey: $t,
  resolveDidKey: gr,
  verifyAttestationVcJws: Mr,
  verifyDelegatedAttestationBundle: Wn,
  verifyDeviceKeyBindingJws: br,
  verifyJwsWithPublicKey: oe,
  verifyLogEntryJws: Bn,
  verifySdJwtVc: Gn,
  verifySpaceCapabilityJws: Rn,
  x25519MultibaseToPublicKeyBytes: Mn,
  x25519PublicKeyToMultibase: pr
}, Symbol.toStringTag, { value: "Module" }));
function T(n) {
  return n.buffer.slice(n.byteOffset, n.byteOffset + n.byteLength);
}
function Jt(n) {
  const e = new Uint8Array([
    48,
    46,
    2,
    1,
    0,
    48,
    5,
    6,
    3,
    43,
    101,
    110,
    4,
    34,
    4,
    32
  ]), t = new Uint8Array(e.length + n.length);
  return t.set(e), t.set(n, e.length), t;
}
class Zn {
  async verifyEd25519(e, t, r) {
    const s = await crypto.subtle.importKey("raw", T(r), { name: "Ed25519" }, !1, ["verify"]);
    return crypto.subtle.verify("Ed25519", s, T(t), T(e));
  }
  async sha256(e) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", T(e)));
  }
  async hkdfSha256(e, t, r) {
    const s = await crypto.subtle.importKey("raw", T(e), "HKDF", !1, ["deriveBits"]), i = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(t)
      },
      s,
      r * 8
    );
    return new Uint8Array(i);
  }
  async x25519PublicFromSeed(e) {
    const t = await crypto.subtle.importKey("pkcs8", T(Jt(e)), { name: "X25519" }, !0, ["deriveBits"]), r = await crypto.subtle.exportKey("jwk", t);
    if (!r.x) throw new Error("X25519 public key export failed");
    const s = atob(r.x.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (i) => i.charCodeAt(0));
  }
  async x25519SharedSecret(e, t) {
    const r = await crypto.subtle.importKey(
      "pkcs8",
      T(Jt(e)),
      { name: "X25519" },
      !1,
      ["deriveBits"]
    ), s = await crypto.subtle.importKey("raw", T(t), { name: "X25519" }, !1, []), i = await crypto.subtle.deriveBits({ name: "X25519", public: s }, r, 256);
    return new Uint8Array(i);
  }
  async aes256GcmEncrypt(e, t, r) {
    const s = await crypto.subtle.importKey("raw", T(e), { name: "AES-GCM" }, !1, ["encrypt"]), i = await crypto.subtle.encrypt({ name: "AES-GCM", iv: T(t), tagLength: 128 }, s, T(r));
    return new Uint8Array(i);
  }
  async aes256GcmDecrypt(e, t, r) {
    const s = await crypto.subtle.importKey("raw", T(e), { name: "AES-GCM" }, !1, ["decrypt"]), i = await crypto.subtle.decrypt({ name: "AES-GCM", iv: T(t), tagLength: 128 }, s, T(r));
    return new Uint8Array(i);
  }
}
const vi = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  WebCryptoProtocolCryptoAdapter: Zn
}, Symbol.toStringTag, { value: "Module" }));
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function Qn(n) {
  return n instanceof Uint8Array || ArrayBuffer.isView(n) && n.constructor.name === "Uint8Array";
}
function be(n, e = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    const t = e && `"${e}" `;
    throw new Error(`${t}expected integer >= 0, got ${n}`);
  }
}
function Se(n, e, t = "") {
  const r = Qn(n), s = n == null ? void 0 : n.length, i = e !== void 0;
  if (!r || i && s !== e) {
    const a = t && `"${t}" `, o = i ? ` of length ${e}` : "", l = r ? `length=${s}` : `type=${typeof n}`;
    throw new Error(a + "expected Uint8Array" + o + ", got " + l);
  }
  return n;
}
function Tr(n) {
  if (typeof n != "function" || typeof n.create != "function")
    throw new Error("Hash must wrapped by utils.createHasher");
  be(n.outputLen), be(n.blockLen);
}
function Ze(n, e = !0) {
  if (n.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (e && n.finished)
    throw new Error("Hash#digest() has already been called");
}
function es(n, e) {
  Se(n, void 0, "digestInto() output");
  const t = e.outputLen;
  if (n.length < t)
    throw new Error('"digestInto() output" expected to be of length >=' + t);
}
function ne(...n) {
  for (let e = 0; e < n.length; e++)
    n[e].fill(0);
}
function He(n) {
  return new DataView(n.buffer, n.byteOffset, n.byteLength);
}
function O(n, e) {
  return n << 32 - e | n >>> e;
}
function ts(n) {
  if (typeof n != "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(n));
}
function Wt(n, e = "") {
  return typeof n == "string" ? ts(n) : Se(n, void 0, e);
}
function rs(n, e) {
  if (e !== void 0 && {}.toString.call(e) !== "[object Object]")
    throw new Error("options must be object or undefined");
  return Object.assign(n, e);
}
function Cr(n, e = {}) {
  const t = (s, i) => n(i).update(s).digest(), r = n(void 0);
  return t.outputLen = r.outputLen, t.blockLen = r.blockLen, t.create = (s) => n(s), Object.assign(t, e), Object.freeze(t);
}
function ns(n = 32) {
  const e = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof (e == null ? void 0 : e.getRandomValues) != "function")
    throw new Error("crypto.getRandomValues must be defined");
  return e.getRandomValues(new Uint8Array(n));
}
const Ir = (n) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, n])
});
class $r {
  constructor(e, t) {
    c(this, "oHash");
    c(this, "iHash");
    c(this, "blockLen");
    c(this, "outputLen");
    c(this, "finished", !1);
    c(this, "destroyed", !1);
    if (Tr(e), Se(t, void 0, "key"), this.iHash = e.create(), typeof this.iHash.update != "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen, this.outputLen = this.iHash.outputLen;
    const r = this.blockLen, s = new Uint8Array(r);
    s.set(t.length > r ? e.create().update(t).digest() : t);
    for (let i = 0; i < s.length; i++)
      s[i] ^= 54;
    this.iHash.update(s), this.oHash = e.create();
    for (let i = 0; i < s.length; i++)
      s[i] ^= 106;
    this.oHash.update(s), ne(s);
  }
  update(e) {
    return Ze(this), this.iHash.update(e), this;
  }
  digestInto(e) {
    Ze(this), Se(e, this.outputLen, "output"), this.finished = !0, this.iHash.digestInto(e), this.oHash.update(e), this.oHash.digestInto(e), this.destroy();
  }
  digest() {
    const e = new Uint8Array(this.oHash.outputLen);
    return this.digestInto(e), e;
  }
  _cloneInto(e) {
    e || (e = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash: t, iHash: r, finished: s, destroyed: i, blockLen: a, outputLen: o } = this;
    return e = e, e.finished = s, e.destroyed = i, e.blockLen = a, e.outputLen = o, e.oHash = t._cloneInto(e.oHash), e.iHash = r._cloneInto(e.iHash), e;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = !0, this.oHash.destroy(), this.iHash.destroy();
  }
}
const zr = (n, e, t) => new $r(n, e).update(t).digest();
zr.create = (n, e) => new $r(n, e);
function ss(n, e, t, r) {
  Tr(n);
  const s = rs({ dkLen: 32, asyncTick: 10 }, r), { c: i, dkLen: a, asyncTick: o } = s;
  if (be(i, "c"), be(a, "dkLen"), be(o, "asyncTick"), i < 1)
    throw new Error("iterations (c) must be >= 1");
  const l = Wt(e, "password"), u = Wt(t, "salt"), h = new Uint8Array(a), d = zr.create(n, l), f = d._cloneInto().update(u);
  return { c: i, dkLen: a, asyncTick: o, DK: h, PRF: d, PRFSalt: f };
}
function is(n, e, t, r, s) {
  return n.destroy(), e.destroy(), r && r.destroy(), ne(s), t;
}
function as(n, e, t, r) {
  const { c: s, dkLen: i, DK: a, PRF: o, PRFSalt: l } = ss(n, e, t, r);
  let u;
  const h = new Uint8Array(4), d = He(h), f = new Uint8Array(o.outputLen);
  for (let g = 1, p = 0; p < i; g++, p += o.outputLen) {
    const w = a.subarray(p, p + o.outputLen);
    d.setInt32(0, g, !1), (u = l._cloneInto(u)).update(h).digestInto(f), w.set(f.subarray(0, w.length));
    for (let v = 1; v < s; v++) {
      o._cloneInto(u).update(f).digestInto(f);
      for (let P = 0; P < w.length; P++)
        w[P] ^= f[P];
    }
  }
  return is(o, l, a, u, f);
}
function os(n, e, t) {
  return n & e ^ ~n & t;
}
function cs(n, e, t) {
  return n & e ^ n & t ^ e & t;
}
class Ur {
  constructor(e, t, r, s) {
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
    this.blockLen = e, this.outputLen = t, this.padOffset = r, this.isLE = s, this.buffer = new Uint8Array(e), this.view = He(this.buffer);
  }
  update(e) {
    Ze(this), Se(e);
    const { view: t, buffer: r, blockLen: s } = this, i = e.length;
    for (let a = 0; a < i; ) {
      const o = Math.min(s - this.pos, i - a);
      if (o === s) {
        const l = He(e);
        for (; s <= i - a; a += s)
          this.process(l, a);
        continue;
      }
      r.set(e.subarray(a, a + o), this.pos), this.pos += o, a += o, this.pos === s && (this.process(t, 0), this.pos = 0);
    }
    return this.length += e.length, this.roundClean(), this;
  }
  digestInto(e) {
    Ze(this), es(e, this), this.finished = !0;
    const { buffer: t, view: r, blockLen: s, isLE: i } = this;
    let { pos: a } = this;
    t[a++] = 128, ne(this.buffer.subarray(a)), this.padOffset > s - a && (this.process(r, 0), a = 0);
    for (let d = a; d < s; d++)
      t[d] = 0;
    r.setBigUint64(s - 8, BigInt(this.length * 8), i), this.process(r, 0);
    const o = He(e), l = this.outputLen;
    if (l % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const u = l / 4, h = this.get();
    if (u > h.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let d = 0; d < u; d++)
      o.setUint32(4 * d, h[d], i);
  }
  digest() {
    const { buffer: e, outputLen: t } = this;
    this.digestInto(e);
    const r = e.slice(0, t);
    return this.destroy(), r;
  }
  _cloneInto(e) {
    e || (e = new this.constructor()), e.set(...this.get());
    const { blockLen: t, buffer: r, length: s, finished: i, destroyed: a, pos: o } = this;
    return e.destroyed = a, e.finished = i, e.length = s, e.pos = o, s % t && e.buffer.set(r), e;
  }
  clone() {
    return this._cloneInto();
  }
}
const V = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), D = /* @__PURE__ */ Uint32Array.from([
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
]), ze = /* @__PURE__ */ BigInt(2 ** 32 - 1), qt = /* @__PURE__ */ BigInt(32);
function ls(n, e = !1) {
  return e ? { h: Number(n & ze), l: Number(n >> qt & ze) } : { h: Number(n >> qt & ze) | 0, l: Number(n & ze) | 0 };
}
function us(n, e = !1) {
  const t = n.length;
  let r = new Uint32Array(t), s = new Uint32Array(t);
  for (let i = 0; i < t; i++) {
    const { h: a, l: o } = ls(n[i], e);
    [r[i], s[i]] = [a, o];
  }
  return [r, s];
}
const Gt = (n, e, t) => n >>> t, Xt = (n, e, t) => n << 32 - t | e >>> t, ue = (n, e, t) => n >>> t | e << 32 - t, de = (n, e, t) => n << 32 - t | e >>> t, Ue = (n, e, t) => n << 64 - t | e >>> t - 32, Oe = (n, e, t) => n >>> t - 32 | e << 64 - t;
function H(n, e, t, r) {
  const s = (e >>> 0) + (r >>> 0);
  return { h: n + t + (s / 2 ** 32 | 0) | 0, l: s | 0 };
}
const ds = (n, e, t) => (n >>> 0) + (e >>> 0) + (t >>> 0), hs = (n, e, t, r) => e + t + r + (n / 2 ** 32 | 0) | 0, fs = (n, e, t, r) => (n >>> 0) + (e >>> 0) + (t >>> 0) + (r >>> 0), ys = (n, e, t, r, s) => e + t + r + s + (n / 2 ** 32 | 0) | 0, ps = (n, e, t, r, s) => (n >>> 0) + (e >>> 0) + (t >>> 0) + (r >>> 0) + (s >>> 0), gs = (n, e, t, r, s, i) => e + t + r + s + i + (n / 2 ** 32 | 0) | 0, bs = /* @__PURE__ */ Uint32Array.from([
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
]), J = /* @__PURE__ */ new Uint32Array(64);
class ms extends Ur {
  constructor(e) {
    super(64, e, 8, !1);
  }
  get() {
    const { A: e, B: t, C: r, D: s, E: i, F: a, G: o, H: l } = this;
    return [e, t, r, s, i, a, o, l];
  }
  // prettier-ignore
  set(e, t, r, s, i, a, o, l) {
    this.A = e | 0, this.B = t | 0, this.C = r | 0, this.D = s | 0, this.E = i | 0, this.F = a | 0, this.G = o | 0, this.H = l | 0;
  }
  process(e, t) {
    for (let d = 0; d < 16; d++, t += 4)
      J[d] = e.getUint32(t, !1);
    for (let d = 16; d < 64; d++) {
      const f = J[d - 15], g = J[d - 2], p = O(f, 7) ^ O(f, 18) ^ f >>> 3, w = O(g, 17) ^ O(g, 19) ^ g >>> 10;
      J[d] = w + J[d - 7] + p + J[d - 16] | 0;
    }
    let { A: r, B: s, C: i, D: a, E: o, F: l, G: u, H: h } = this;
    for (let d = 0; d < 64; d++) {
      const f = O(o, 6) ^ O(o, 11) ^ O(o, 25), g = h + f + os(o, l, u) + bs[d] + J[d] | 0, w = (O(r, 2) ^ O(r, 13) ^ O(r, 22)) + cs(r, s, i) | 0;
      h = u, u = l, l = o, o = a + g | 0, a = i, i = s, s = r, r = g + w | 0;
    }
    r = r + this.A | 0, s = s + this.B | 0, i = i + this.C | 0, a = a + this.D | 0, o = o + this.E | 0, l = l + this.F | 0, u = u + this.G | 0, h = h + this.H | 0, this.set(r, s, i, a, o, l, u, h);
  }
  roundClean() {
    ne(J);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), ne(this.buffer);
  }
}
class ws extends ms {
  constructor() {
    super(32);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    c(this, "A", V[0] | 0);
    c(this, "B", V[1] | 0);
    c(this, "C", V[2] | 0);
    c(this, "D", V[3] | 0);
    c(this, "E", V[4] | 0);
    c(this, "F", V[5] | 0);
    c(this, "G", V[6] | 0);
    c(this, "H", V[7] | 0);
  }
}
const Or = us([
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
].map((n) => BigInt(n))), Ss = Or[0], ks = Or[1], W = /* @__PURE__ */ new Uint32Array(80), q = /* @__PURE__ */ new Uint32Array(80);
class vs extends Ur {
  constructor(e) {
    super(128, e, 16, !1);
  }
  // prettier-ignore
  get() {
    const { Ah: e, Al: t, Bh: r, Bl: s, Ch: i, Cl: a, Dh: o, Dl: l, Eh: u, El: h, Fh: d, Fl: f, Gh: g, Gl: p, Hh: w, Hl: v } = this;
    return [e, t, r, s, i, a, o, l, u, h, d, f, g, p, w, v];
  }
  // prettier-ignore
  set(e, t, r, s, i, a, o, l, u, h, d, f, g, p, w, v) {
    this.Ah = e | 0, this.Al = t | 0, this.Bh = r | 0, this.Bl = s | 0, this.Ch = i | 0, this.Cl = a | 0, this.Dh = o | 0, this.Dl = l | 0, this.Eh = u | 0, this.El = h | 0, this.Fh = d | 0, this.Fl = f | 0, this.Gh = g | 0, this.Gl = p | 0, this.Hh = w | 0, this.Hl = v | 0;
  }
  process(e, t) {
    for (let m = 0; m < 16; m++, t += 4)
      W[m] = e.getUint32(t), q[m] = e.getUint32(t += 4);
    for (let m = 16; m < 80; m++) {
      const $ = W[m - 15] | 0, z = q[m - 15] | 0, xe = ue($, z, 1) ^ ue($, z, 8) ^ Gt($, z, 7), Ae = de($, z, 1) ^ de($, z, 8) ^ Xt($, z, 7), _ = W[m - 2] | 0, N = q[m - 2] | 0, Ie = ue(_, N, 19) ^ Ue(_, N, 61) ^ Gt(_, N, 6), ct = de(_, N, 19) ^ Oe(_, N, 61) ^ Xt(_, N, 6), $e = fs(Ae, ct, q[m - 7], q[m - 16]), lt = ys($e, xe, Ie, W[m - 7], W[m - 16]);
      W[m] = lt | 0, q[m] = $e | 0;
    }
    let { Ah: r, Al: s, Bh: i, Bl: a, Ch: o, Cl: l, Dh: u, Dl: h, Eh: d, El: f, Fh: g, Fl: p, Gh: w, Gl: v, Hh: P, Hl: F } = this;
    for (let m = 0; m < 80; m++) {
      const $ = ue(d, f, 14) ^ ue(d, f, 18) ^ Ue(d, f, 41), z = de(d, f, 14) ^ de(d, f, 18) ^ Oe(d, f, 41), xe = d & g ^ ~d & w, Ae = f & p ^ ~f & v, _ = ps(F, z, Ae, ks[m], q[m]), N = gs(_, P, $, xe, Ss[m], W[m]), Ie = _ | 0, ct = ue(r, s, 28) ^ Ue(r, s, 34) ^ Ue(r, s, 39), $e = de(r, s, 28) ^ Oe(r, s, 34) ^ Oe(r, s, 39), lt = r & i ^ r & o ^ i & o, Qr = s & a ^ s & l ^ a & l;
      P = w | 0, F = v | 0, w = g | 0, v = p | 0, g = d | 0, p = f | 0, { h: d, l: f } = H(u | 0, h | 0, N | 0, Ie | 0), u = o | 0, h = l | 0, o = i | 0, l = a | 0, i = r | 0, a = s | 0;
      const Ot = ds(Ie, $e, Qr);
      r = hs(Ot, N, ct, lt), s = Ot | 0;
    }
    ({ h: r, l: s } = H(this.Ah | 0, this.Al | 0, r | 0, s | 0)), { h: i, l: a } = H(this.Bh | 0, this.Bl | 0, i | 0, a | 0), { h: o, l } = H(this.Ch | 0, this.Cl | 0, o | 0, l | 0), { h: u, l: h } = H(this.Dh | 0, this.Dl | 0, u | 0, h | 0), { h: d, l: f } = H(this.Eh | 0, this.El | 0, d | 0, f | 0), { h: g, l: p } = H(this.Fh | 0, this.Fl | 0, g | 0, p | 0), { h: w, l: v } = H(this.Gh | 0, this.Gl | 0, w | 0, v | 0), { h: P, l: F } = H(this.Hh | 0, this.Hl | 0, P | 0, F | 0), this.set(r, s, i, a, o, l, u, h, d, f, g, p, w, v, P, F);
  }
  roundClean() {
    ne(W, q);
  }
  destroy() {
    ne(this.buffer), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}
class Es extends vs {
  constructor() {
    super(64);
    c(this, "Ah", D[0] | 0);
    c(this, "Al", D[1] | 0);
    c(this, "Bh", D[2] | 0);
    c(this, "Bl", D[3] | 0);
    c(this, "Ch", D[4] | 0);
    c(this, "Cl", D[5] | 0);
    c(this, "Dh", D[6] | 0);
    c(this, "Dl", D[7] | 0);
    c(this, "Eh", D[8] | 0);
    c(this, "El", D[9] | 0);
    c(this, "Fh", D[10] | 0);
    c(this, "Fl", D[11] | 0);
    c(this, "Gh", D[12] | 0);
    c(this, "Gl", D[13] | 0);
    c(this, "Hh", D[14] | 0);
    c(this, "Hl", D[15] | 0);
  }
}
const xs = /* @__PURE__ */ Cr(
  () => new ws(),
  /* @__PURE__ */ Ir(1)
), As = /* @__PURE__ */ Cr(
  () => new Es(),
  /* @__PURE__ */ Ir(3)
);
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function Qe(n) {
  return n instanceof Uint8Array || ArrayBuffer.isView(n) && n.constructor.name === "Uint8Array";
}
function Br(n, e) {
  return Array.isArray(e) ? e.length === 0 ? !0 : n ? e.every((t) => typeof t == "string") : e.every((t) => Number.isSafeInteger(t)) : !1;
}
function Ds(n) {
  if (typeof n != "function")
    throw new Error("function expected");
  return !0;
}
function et(n, e) {
  if (typeof e != "string")
    throw new Error(`${n}: string expected`);
  return !0;
}
function Ee(n) {
  if (!Number.isSafeInteger(n))
    throw new Error(`invalid integer: ${n}`);
}
function tt(n) {
  if (!Array.isArray(n))
    throw new Error("array expected");
}
function rt(n, e) {
  if (!Br(!0, e))
    throw new Error(`${n}: array of strings expected`);
}
function _r(n, e) {
  if (!Br(!1, e))
    throw new Error(`${n}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function Ms(...n) {
  const e = (i) => i, t = (i, a) => (o) => i(a(o)), r = n.map((i) => i.encode).reduceRight(t, e), s = n.map((i) => i.decode).reduce(t, e);
  return { encode: r, decode: s };
}
// @__NO_SIDE_EFFECTS__
function Ks(n) {
  const e = typeof n == "string" ? n.split("") : n, t = e.length;
  rt("alphabet", e);
  const r = new Map(e.map((s, i) => [s, i]));
  return {
    encode: (s) => (tt(s), s.map((i) => {
      if (!Number.isSafeInteger(i) || i < 0 || i >= t)
        throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${n}`);
      return e[i];
    })),
    decode: (s) => (tt(s), s.map((i) => {
      et("alphabet.decode", i);
      const a = r.get(i);
      if (a === void 0)
        throw new Error(`Unknown letter: "${i}". Allowed: ${n}`);
      return a;
    }))
  };
}
// @__NO_SIDE_EFFECTS__
function Ps(n = "") {
  return et("join", n), {
    encode: (e) => (rt("join.decode", e), e.join(n)),
    decode: (e) => (et("join.decode", e), e.split(n))
  };
}
// @__NO_SIDE_EFFECTS__
function Ts(n, e = "=") {
  return Ee(n), et("padding", e), {
    encode(t) {
      for (rt("padding.encode", t); t.length * n % 8; )
        t.push(e);
      return t;
    },
    decode(t) {
      rt("padding.decode", t);
      let r = t.length;
      if (r * n % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (; r > 0 && t[r - 1] === e; r--)
        if ((r - 1) * n % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      return t.slice(0, r);
    }
  };
}
function xt(n, e, t) {
  if (e < 2)
    throw new Error(`convertRadix: invalid from=${e}, base cannot be less than 2`);
  if (t < 2)
    throw new Error(`convertRadix: invalid to=${t}, base cannot be less than 2`);
  if (tt(n), !n.length)
    return [];
  let r = 0;
  const s = [], i = Array.from(n, (o) => {
    if (Ee(o), o < 0 || o >= e)
      throw new Error(`invalid integer: ${o}`);
    return o;
  }), a = i.length;
  for (; ; ) {
    let o = 0, l = !0;
    for (let u = r; u < a; u++) {
      const h = i[u], d = e * o, f = d + h;
      if (!Number.isSafeInteger(f) || d / e !== o || f - h !== d)
        throw new Error("convertRadix: carry overflow");
      const g = f / t;
      o = f % t;
      const p = Math.floor(g);
      if (i[u] = p, !Number.isSafeInteger(p) || p * t + o !== f)
        throw new Error("convertRadix: carry overflow");
      if (l)
        p ? l = !1 : r = u;
      else continue;
    }
    if (s.push(o), l)
      break;
  }
  for (let o = 0; o < n.length - 1 && n[o] === 0; o++)
    s.push(0);
  return s.reverse();
}
const Nr = (n, e) => e === 0 ? n : Nr(e, n % e), nt = /* @__NO_SIDE_EFFECTS__ */ (n, e) => n + (e - Nr(n, e)), ft = /* @__PURE__ */ (() => {
  let n = [];
  for (let e = 0; e < 40; e++)
    n.push(2 ** e);
  return n;
})();
function At(n, e, t, r) {
  if (tt(n), e <= 0 || e > 32)
    throw new Error(`convertRadix2: wrong from=${e}`);
  if (t <= 0 || t > 32)
    throw new Error(`convertRadix2: wrong to=${t}`);
  if (/* @__PURE__ */ nt(e, t) > 32)
    throw new Error(`convertRadix2: carry overflow from=${e} to=${t} carryBits=${/* @__PURE__ */ nt(e, t)}`);
  let s = 0, i = 0;
  const a = ft[e], o = ft[t] - 1, l = [];
  for (const u of n) {
    if (Ee(u), u >= a)
      throw new Error(`convertRadix2: invalid data word=${u} from=${e}`);
    if (s = s << e | u, i + e > 32)
      throw new Error(`convertRadix2: carry overflow pos=${i} from=${e}`);
    for (i += e; i >= t; i -= t)
      l.push((s >> i - t & o) >>> 0);
    const h = ft[i];
    if (h === void 0)
      throw new Error("invalid carry");
    s &= h - 1;
  }
  if (s = s << t - i & o, !r && i >= e)
    throw new Error("Excess padding");
  if (!r && s > 0)
    throw new Error(`Non-zero padding: ${s}`);
  return r && i > 0 && l.push(s >>> 0), l;
}
// @__NO_SIDE_EFFECTS__
function Cs(n) {
  Ee(n);
  const e = 2 ** 8;
  return {
    encode: (t) => {
      if (!Qe(t))
        throw new Error("radix.encode input should be Uint8Array");
      return xt(Array.from(t), e, n);
    },
    decode: (t) => (_r("radix.decode", t), Uint8Array.from(xt(t, n, e)))
  };
}
// @__NO_SIDE_EFFECTS__
function Is(n, e = !1) {
  if (Ee(n), n <= 0 || n > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ nt(8, n) > 32 || /* @__PURE__ */ nt(n, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (t) => {
      if (!Qe(t))
        throw new Error("radix2.encode input should be Uint8Array");
      return At(Array.from(t), 8, n, !e);
    },
    decode: (t) => (_r("radix2.decode", t), Uint8Array.from(At(t, n, 8, e)))
  };
}
function $s(n, e) {
  return Ee(n), Ds(e), {
    encode(t) {
      if (!Qe(t))
        throw new Error("checksum.encode: input should be Uint8Array");
      const r = e(t).slice(0, n), s = new Uint8Array(t.length + n);
      return s.set(t), s.set(r, t.length), s;
    },
    decode(t) {
      if (!Qe(t))
        throw new Error("checksum.decode: input should be Uint8Array");
      const r = t.slice(0, -n), s = t.slice(-n), i = e(r).slice(0, n);
      for (let a = 0; a < n; a++)
        if (i[a] !== s[a])
          throw new Error("Invalid checksum");
      return r;
    }
  };
}
const Be = {
  alphabet: Ks,
  chain: Ms,
  checksum: $s,
  convertRadix: xt,
  convertRadix2: At,
  radix: Cs,
  radix2: Is,
  join: Ps,
  padding: Ts
};
/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
const zs = (n) => n[0] === "あいこくしん";
function jr(n) {
  if (typeof n != "string")
    throw new TypeError("invalid mnemonic type: " + typeof n);
  return n.normalize("NFKD");
}
function Rr(n) {
  const e = jr(n), t = e.split(" ");
  if (![12, 15, 18, 21, 24].includes(t.length))
    throw new Error("Invalid mnemonic");
  return { nfkd: e, words: t };
}
function Hr(n) {
  if (Se(n), ![16, 20, 24, 28, 32].includes(n.length))
    throw new Error("invalid entropy length");
}
function Lr(n, e = 128) {
  if (be(e), e % 32 !== 0 || e > 256)
    throw new TypeError("Invalid entropy");
  return Bs(ns(e / 8), n);
}
const Us = (n) => {
  const e = 8 - n.length / 4;
  return new Uint8Array([xs(n)[0] >> e << e]);
};
function Fr(n) {
  if (!Array.isArray(n) || n.length !== 2048 || typeof n[0] != "string")
    throw new Error("Wordlist: expected array of 2048 strings");
  return n.forEach((e) => {
    if (typeof e != "string")
      throw new Error("wordlist: non-string element: " + e);
  }), Be.chain(Be.checksum(1, Us), Be.radix2(11, !0), Be.alphabet(n));
}
function Os(n, e) {
  const { words: t } = Rr(n), r = Fr(e).decode(t);
  return Hr(r), r;
}
function Bs(n, e) {
  return Hr(n), Fr(e).encode(n).join(zs(e) ? "　" : " ");
}
function Vr(n, e) {
  try {
    Os(n, e);
  } catch {
    return !1;
  }
  return !0;
}
const _s = (n) => jr("mnemonic" + n);
function Dt(n, e = "") {
  return as(As, Rr(n).nfkd, _s(e), { c: 2048, dkLen: 64 });
}
const se = [
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
if (se.length !== 2048)
  throw new Error(
    `German wordlist must contain exactly 2048 words, but has ${se.length}`
  );
const Yt = new Set(se.map((n) => n.slice(0, 4)));
if (Yt.size !== 2048)
  throw new Error(
    `First 4 characters must be unique. Have ${Yt.size} unique, need 2048`
  );
const Ns = 64;
var Ke, me, Pe, ee, Te;
class js {
  constructor(e, t, r, s) {
    c(this, "did");
    c(this, "kid");
    c(this, "ed25519PublicKey");
    c(this, "x25519PublicKey");
    ce(this, Ke);
    ce(this, me);
    ce(this, Pe);
    ce(this, ee);
    ce(this, Te);
    this.did = e.did, this.kid = e.kid, this.ed25519PublicKey = new Uint8Array(e.ed25519PublicKey), this.x25519PublicKey = new Uint8Array(e.x25519PublicKey), le(this, Ke, new Uint8Array(t)), le(this, me, new Uint8Array(e.ed25519Seed)), le(this, Pe, new Uint8Array(e.x25519Seed)), le(this, ee, r), le(this, Te, s);
  }
  getDid() {
    return this.did;
  }
  async sign(e) {
    const t = await vt(new TextEncoder().encode(e), j(this, me));
    return x(t);
  }
  async signJws(e) {
    const t = { alg: "EdDSA", typ: "JWT" }, r = x(new TextEncoder().encode(JSON.stringify(t))), s = x(new TextEncoder().encode(JSON.stringify(e))), i = `${r}.${s}`, a = await vt(new TextEncoder().encode(i), j(this, me));
    return `${i}.${x(a)}`;
  }
  async deriveFrameworkKey(e) {
    return j(this, ee).hkdfSha256(j(this, Ke), e, 32);
  }
  async getPublicKeyMultibase() {
    return this.did.replace("did:key:", "");
  }
  async getEncryptionPublicKeyBytes() {
    return new Uint8Array(this.x25519PublicKey);
  }
  async encryptForRecipient(e, t) {
    const r = crypto.getRandomValues(new Uint8Array(32)), s = crypto.getRandomValues(new Uint8Array(12)), i = await kr({
      crypto: j(this, ee),
      ephemeralPrivateSeed: r,
      recipientPublicKey: t,
      nonce: s,
      plaintext: e
    });
    return {
      ciphertext: K(i.ciphertext),
      nonce: K(i.nonce),
      ephemeralPublicKey: K(i.epk)
    };
  }
  async decryptForMe(e) {
    if (!e.ephemeralPublicKey) throw new Error("Missing ephemeral public key");
    return vr({
      crypto: j(this, ee),
      recipientPrivateSeed: j(this, Pe),
      message: {
        epk: x(e.ephemeralPublicKey),
        nonce: x(e.nonce),
        ciphertext: x(e.ciphertext)
      }
    });
  }
  async deleteStoredIdentity() {
    await j(this, Te).call(this);
  }
}
Ke = new WeakMap(), me = new WeakMap(), Pe = new WeakMap(), ee = new WeakMap(), Te = new WeakMap();
class Rs {
  constructor(e) {
    c(this, "crypto");
    c(this, "vault");
    c(this, "createMnemonic");
    c(this, "currentIdentity", null);
    this.crypto = e.crypto, this.vault = e.vault ?? null, this.createMnemonic = e.generateMnemonic ?? (() => Lr(se, 128));
  }
  async createIdentity(e) {
    const t = this.createMnemonic(), r = await this.recoverFromMnemonic(t);
    return (e.storeSeed ?? !0) && await this.requireVault().saveSeed(this.seedFromMnemonic(t), e.passphrase), this.currentIdentity = r, { mnemonic: t, identity: r };
  }
  async recoverIdentity(e) {
    const t = await this.recoverFromMnemonic(e.mnemonic);
    return (e.storeSeed ?? !1) && await this.requireVault().saveSeed(this.seedFromMnemonic(e.mnemonic), e.passphrase), this.currentIdentity = t, { identity: t };
  }
  async unlockStoredIdentity(e = {}) {
    const t = this.requireVault(), r = e.passphrase !== void 0 ? await t.loadSeed(e.passphrase) : await this.loadSeedWithSessionKey(t);
    if (!r) throw new Error(e.passphrase !== void 0 ? "No identity found in storage" : "Session expired");
    const s = await this.identityFromSeed(r);
    return this.currentIdentity = s, { identity: s };
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
    if (!Vr(e, se)) throw new Error("Invalid mnemonic");
    return this.identityFromSeed(this.seedFromMnemonic(e));
  }
  async identityFromSeed(e) {
    if (e.length !== Ns) throw new Error("Invalid identity seed format");
    const t = await mr(sr(e), this.crypto);
    return new js(t, e, this.crypto, () => this.deleteStoredIdentity());
  }
  async loadSeedWithSessionKey(e) {
    if (!e.loadSeedWithSessionKey) throw new Error("Session unlock is not supported");
    return e.loadSeedWithSessionKey();
  }
  seedFromMnemonic(e) {
    return Dt(e, "");
  }
  requireVault() {
    if (!this.vault) throw new Error("Identity seed vault is required");
    return this.vault;
  }
}
class Hs {
  constructor(e) {
    c(this, "crypto");
    c(this, "randomId");
    c(this, "now");
    this.crypto = e.crypto, this.randomId = e.randomId ?? (() => crypto.randomUUID()), this.now = e.now ?? (() => /* @__PURE__ */ new Date());
  }
  async createChallenge(e, t) {
    const r = {
      nonce: this.randomId(),
      timestamp: this.now().toISOString(),
      fromDid: e.getDid(),
      fromPublicKey: await e.getPublicKeyMultibase(),
      fromName: t
    };
    return { challenge: r, code: Zt(r) };
  }
  decodeChallenge(e) {
    return Qt(e);
  }
  prepareChallenge(e, t) {
    const r = this.decodeChallenge(e);
    if (t && r.fromDid === t) throw new Error("Cannot verify own identity");
    return r;
  }
  async createResponse(e, t, r) {
    const s = this.prepareChallenge(e, t.getDid()), i = {
      nonce: s.nonce,
      timestamp: this.now().toISOString(),
      toDid: t.getDid(),
      toPublicKey: await t.getPublicKeyMultibase(),
      toName: r,
      fromDid: s.fromDid,
      fromPublicKey: s.fromPublicKey,
      fromName: s.fromName
    };
    return { response: i, code: Zt(i) };
  }
  decodeResponse(e) {
    return Qt(e);
  }
  async completeVerification(e, t, r) {
    const s = this.decodeResponse(e);
    if (s.nonce !== r) throw new Error("Nonce mismatch");
    return this.createSignedVerification({
      identity: t,
      toDid: s.toDid,
      nonce: s.nonce,
      timestamp: s.timestamp,
      id: `urn:uuid:ver-${s.nonce}`,
      proofCreated: this.now().toISOString()
    });
  }
  async createVerificationFor(e, t, r) {
    const s = this.now().toISOString();
    return this.createSignedVerification({
      identity: e,
      toDid: t,
      nonce: r,
      timestamp: s,
      id: `urn:uuid:ver-${r}-${e.getDid().slice(-8)}`,
      proofCreated: s
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
        K(e.proof.proofValue),
        L(e.from)
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
    return zt(e);
  }
  base64UrlToBytes(e) {
    return K(e);
  }
  async createSignedVerification(e) {
    const t = e.identity.getDid(), r = JSON.stringify({ from: t, to: e.toDid, timestamp: e.timestamp }), s = await e.identity.sign(r);
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
        proofValue: s
      }
    };
  }
}
function Zt(n) {
  const e = new TextEncoder().encode(JSON.stringify(n));
  let t = "";
  for (const r of e) t += String.fromCharCode(r);
  return btoa(t);
}
function Qt(n) {
  const e = atob(n), t = new Uint8Array(e.length);
  for (let r = 0; r < e.length; r++) t[r] = e.charCodeAt(r);
  return JSON.parse(new TextDecoder().decode(t));
}
class Ls {
  constructor(e) {
    c(this, "crypto");
    c(this, "randomId");
    c(this, "now");
    this.crypto = e.crypto, this.randomId = e.randomId ?? (() => crypto.randomUUID()), this.now = e.now ?? (() => /* @__PURE__ */ new Date());
  }
  async createAttestation(e) {
    const t = `urn:uuid:${this.randomId()}`, r = this.now().toISOString(), s = e.issuer.getDid(), i = e.subjectDid, a = await Dr({
      kid: `${s}#sig-0`,
      payload: this.createVcPayload({ id: t, from: s, to: i, claim: e.claim, tags: e.tags, createdAt: r }),
      sign: async (o) => K(await e.issuer.sign(new TextDecoder().decode(o)))
    });
    return {
      id: t,
      from: s,
      to: i,
      claim: e.claim,
      ...e.tags ? { tags: e.tags } : {},
      createdAt: r,
      vcJws: a
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
    return Mr(e, { crypto: this.crypto });
  }
  exportAttestation(e) {
    return this.assertComplete(e), e.vcJws;
  }
  async importAttestation(e) {
    const t = e.trim();
    if (!Fs(t)) throw new Error("Invalid attestation format");
    try {
      const r = await this.verifyAttestationVcJws(t);
      return this.attestationFromVcPayload(r, t);
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
    const r = e.credentialSubject.tags, s = e.credentialSubject.context;
    return {
      id: typeof e.jti == "string" ? e.jti : typeof e.id == "string" ? e.id : `wot:attestation:${e.iss}:${e.sub}:${e.nbf}`,
      from: e.issuer,
      to: e.credentialSubject.id,
      claim: e.credentialSubject.claim,
      ...Array.isArray(r) && r.every((a) => typeof a == "string") ? { tags: r } : {},
      ...typeof s == "string" ? { context: s } : {},
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
function Fs(n) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(n);
}
class Vs {
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
    return this.replication.getSpace(G(e, "spaceId"));
  }
  async createSpace(e) {
    const t = G(e.name.trim(), "space name"), r = e.appTag ?? this.appTag, s = {
      name: t,
      ...e.description !== void 0 ? { description: e.description } : {},
      ...r !== void 0 ? { appTag: r } : {}
    };
    return this.replication.createSpace(e.type ?? "shared", e.initialDoc ?? this.createDefaultInitialDoc(), s);
  }
  updateSpace(e, t) {
    return this.replication.updateSpace(G(e, "spaceId"), t);
  }
  async inviteMember(e) {
    const t = G(e.memberDid, "memberDid"), r = await this.requireMemberKeys().resolveMemberEncryptionKey(t);
    if (!r) throw new Error("NO_ENCRYPTION_KEY");
    await this.replication.addMember(G(e.spaceId, "spaceId"), t, r);
  }
  removeMember(e) {
    return this.replication.removeMember(G(e.spaceId, "spaceId"), G(e.memberDid, "memberDid"));
  }
  leaveSpace(e) {
    return this.replication.leaveSpace(G(e, "spaceId"));
  }
  requestSync(e = "__all__") {
    return this.replication.requestSync(e);
  }
  requireMemberKeys() {
    if (!this.memberKeys) throw new Error("Space member key directory is required");
    return this.memberKeys;
  }
}
function G(n, e) {
  if (!n) throw new Error(`Missing ${e}`);
  return n;
}
const Ei = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  AttestationWorkflow: Ls,
  IdentityWorkflow: Rs,
  SpacesWorkflow: Vs,
  VerificationWorkflow: Hs
}, Symbol.toStringTag, { value: "Module" })), xi = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null
}, Symbol.toStringTag, { value: "Module" }));
async function Jr(n, e) {
  const t = {
    id: crypto.randomUUID(),
    issuer: n.issuer,
    audience: n.audience,
    resource: n.resource,
    permissions: [...n.permissions].sort(),
    expiration: n.expiration
  };
  return e(t);
}
async function Wr(n, e) {
  const t = e ?? /* @__PURE__ */ new Date(), r = Fe(n);
  if (!r || typeof r != "object")
    return { valid: !1, error: "Invalid capability: cannot extract payload" };
  const s = r, i = Ws(s);
  if (i)
    return { valid: !1, error: i };
  const a = new Date(s.expiration);
  if (isNaN(a.getTime()))
    return { valid: !1, error: "Invalid expiration date" };
  if (t >= a)
    return { valid: !1, error: "Capability has expired" };
  let o;
  try {
    const h = we(s.issuer);
    o = await crypto.subtle.importKey(
      "raw",
      h,
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  } catch {
    return { valid: !1, error: `Cannot resolve issuer DID: ${s.issuer}` };
  }
  const l = await wt(n, o);
  if (!l.valid)
    return { valid: !1, error: `Invalid signature: ${l.error}` };
  const u = [];
  if (s.proof) {
    const h = await Wr(s.proof, e);
    if (!h.valid)
      return { valid: !1, error: `Invalid delegation chain: ${h.error}` };
    const d = h.capability;
    if (d.audience !== s.issuer)
      return {
        valid: !1,
        error: `Delegation chain broken: parent audience (${d.audience}) !== child issuer (${s.issuer})`
      };
    if (d.resource !== s.resource)
      return {
        valid: !1,
        error: `Delegation resource mismatch: parent (${d.resource}) !== child (${s.resource})`
      };
    const f = new Set(d.permissions);
    for (const p of s.permissions)
      if (!f.has(p))
        return {
          valid: !1,
          error: `Permission escalation: "${p}" not in parent permissions [${d.permissions.join(", ")}]`
        };
    const g = new Date(d.expiration);
    if (a > g)
      return {
        valid: !1,
        error: "Delegated capability expires after parent"
      };
    if (!d.permissions.includes("delegate"))
      return {
        valid: !1,
        error: 'Parent capability does not include "delegate" permission'
      };
    u.push(...h.chain, d);
  }
  return { valid: !0, capability: s, chain: u };
}
function Me(n) {
  const e = Fe(n);
  return !e || typeof e != "object" ? null : e;
}
async function Js(n, e, t) {
  const r = Me(n);
  if (!r)
    throw new Error("Invalid parent capability");
  if (!r.permissions.includes("delegate"))
    throw new Error('Parent capability does not include "delegate" permission');
  const s = new Set(r.permissions);
  for (const l of e.permissions)
    if (!s.has(l))
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
    proof: n
  };
  return t(o);
}
function Ws(n) {
  if (!n.id) return "Missing field: id";
  if (!n.issuer) return "Missing field: issuer";
  if (!n.audience) return "Missing field: audience";
  if (!n.resource) return "Missing field: resource";
  if (!n.permissions || !Array.isArray(n.permissions) || n.permissions.length === 0)
    return "Missing or empty field: permissions";
  if (!n.expiration) return "Missing field: expiration";
  const e = /* @__PURE__ */ new Set(["read", "write", "delete", "delegate"]);
  for (const t of n.permissions)
    if (!e.has(t))
      return `Invalid permission: "${t}"`;
  return null;
}
function qr(n) {
  return `${n.v}|${n.id}|${n.type}|${n.fromDid}|${n.toDid}|${n.createdAt}|${n.payload}`;
}
async function Ai(n, e) {
  const t = qr(n);
  return n.signature = await e(t), n;
}
async function qs(n, e, t) {
  const r = we(t), s = await crypto.subtle.importKey(
    "raw",
    r,
    { name: "Ed25519" },
    !0,
    ["verify"]
  ), i = new TextEncoder().encode(n), a = I(e);
  return crypto.subtle.verify(
    "Ed25519",
    s,
    k(a),
    i
  );
}
async function Di(n, e = qs) {
  try {
    if (!n.signature) return !1;
    const t = qr(n);
    return await e(t, n.signature, n.fromDid);
  } catch {
    return !1;
  }
}
const S = class S {
  constructor() {
    // 30 minutes
    c(this, "db", null);
  }
  /**
   * Initialize IndexedDB
   */
  async init() {
    return new Promise((e, t) => {
      const r = indexedDB.open(S.DB_NAME, 2);
      r.onerror = () => t(r.error), r.onsuccess = () => {
        this.db = r.result, e();
      }, r.onupgradeneeded = (s) => {
        const i = s.target.result;
        i.objectStoreNames.contains(S.STORE_NAME) || i.createObjectStore(S.STORE_NAME), i.objectStoreNames.contains(S.SESSION_STORE_NAME) || i.createObjectStore(S.SESSION_STORE_NAME);
      };
    });
  }
  /**
   * Store encrypted seed
   *
   * @param seed - Master seed bytes; the caller owns the seed format/version.
   * @param passphrase - User's passphrase
   */
  async storeSeed(e, t) {
    this.db || await this.init();
    const r = crypto.getRandomValues(new Uint8Array(16)), s = await this.deriveEncryptionKey(t, r), i = crypto.getRandomValues(new Uint8Array(12)), a = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: i },
      s,
      e
    ), o = {
      ciphertext: C(new Uint8Array(a)),
      salt: C(r),
      iv: C(i)
    };
    return new Promise((l, u) => {
      const f = this.db.transaction([S.STORE_NAME], "readwrite").objectStore(S.STORE_NAME).put(o, "master-seed");
      f.onerror = () => u(f.error), f.onsuccess = () => l();
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
      const r = I(t.salt), s = await this.deriveEncryptionKey(e, r), i = I(t.iv), a = I(t.ciphertext), o = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: i },
        s,
        a
      );
      return await this.storeSessionKey(s), new Uint8Array(o);
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
      const r = I(t.iv), s = I(t.ciphertext), i = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: r },
        e.key,
        s
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
      const i = this.db.transaction([S.STORE_NAME], "readwrite").objectStore(S.STORE_NAME).delete("master-seed");
      i.onerror = () => t(i.error), i.onsuccess = () => e();
    });
  }
  /**
   * Clear the cached session key
   */
  async clearSessionKey() {
    return this.db || await this.init(), new Promise((e, t) => {
      const i = this.db.transaction([S.SESSION_STORE_NAME], "readwrite").objectStore(S.SESSION_STORE_NAME).delete("session-key");
      i.onerror = () => t(i.error), i.onsuccess = () => e();
    });
  }
  // Private methods
  async storeSessionKey(e, t = S.DEFAULT_SESSION_TTL) {
    const r = {
      key: e,
      expiresAt: Date.now() + t
    };
    return new Promise((s, i) => {
      const l = this.db.transaction([S.SESSION_STORE_NAME], "readwrite").objectStore(S.SESSION_STORE_NAME).put(r, "session-key");
      l.onerror = () => i(l.error), l.onsuccess = () => s();
    });
  }
  async getSessionEntry() {
    return new Promise((e, t) => {
      const i = this.db.transaction([S.SESSION_STORE_NAME], "readonly").objectStore(S.SESSION_STORE_NAME).get("session-key");
      i.onerror = () => t(i.error), i.onsuccess = () => e(i.result || null);
    });
  }
  async getEncryptedSeed() {
    return new Promise((e, t) => {
      const i = this.db.transaction([S.STORE_NAME], "readonly").objectStore(S.STORE_NAME).get("master-seed");
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
        iterations: S.PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      r,
      { name: "AES-GCM", length: 256 },
      !1,
      // non-extractable
      ["encrypt", "decrypt"]
    );
  }
};
c(S, "DB_NAME", "wot-identity"), c(S, "STORE_NAME", "seeds"), c(S, "SESSION_STORE_NAME", "session"), c(S, "PBKDF2_ITERATIONS", 1e5), c(S, "DEFAULT_SESSION_TTL", 1800 * 1e3);
let st = S;
class Gs {
  constructor(e) {
    c(this, "_brand", "MasterKeyHandle");
    this.key = e;
  }
}
class Xs {
  constructor(e) {
    c(this, "_brand", "EncryptionKeyPair");
    this.keyPair = e;
  }
}
function Ys(n) {
  const e = new Uint8Array([
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
    // OCTET STRING (32 bytes)
  ]), t = new Uint8Array(e.length + n.length);
  return t.set(e), t.set(n, e.length), t;
}
class Zs {
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
      publicKey: C(new Uint8Array(t)),
      privateKey: C(new Uint8Array(r))
    };
  }
  async importKeyPair(e) {
    const t = I(e.publicKey), r = I(e.privateKey), [s, i] = await Promise.all([
      crypto.subtle.importKey(
        "raw",
        k(t),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ),
      crypto.subtle.importKey(
        "pkcs8",
        k(r),
        { name: "Ed25519" },
        !0,
        ["sign"]
      )
    ]);
    return { publicKey: s, privateKey: i };
  }
  async exportPublicKey(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return C(new Uint8Array(t));
  }
  async importPublicKey(e) {
    const t = I(e);
    return crypto.subtle.importKey(
      "raw",
      k(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  async createDid(e) {
    const t = await crypto.subtle.exportKey("raw", e);
    return cn(new Uint8Array(t));
  }
  async didToPublicKey(e) {
    const t = we(e);
    return crypto.subtle.importKey(
      "raw",
      k(t),
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  }
  async sign(e, t) {
    const r = await crypto.subtle.sign(
      { name: "Ed25519" },
      t,
      k(e)
    );
    return new Uint8Array(r);
  }
  async verify(e, t, r) {
    return crypto.subtle.verify(
      { name: "Ed25519" },
      r,
      k(t),
      k(e)
    );
  }
  async signString(e, t) {
    const r = new TextEncoder(), s = await this.sign(r.encode(e), t);
    return C(s);
  }
  async verifyString(e, t, r) {
    const s = new TextEncoder();
    return this.verify(s.encode(e), I(t), r);
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
    const r = crypto.getRandomValues(new Uint8Array(12)), s = await crypto.subtle.importKey(
      "raw",
      k(t),
      { name: "AES-GCM" },
      !1,
      ["encrypt"]
    ), i = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: r },
      s,
      k(e)
    );
    return { ciphertext: new Uint8Array(i), nonce: r };
  }
  async decryptSymmetric(e, t, r) {
    const s = await crypto.subtle.importKey(
      "raw",
      k(r),
      { name: "AES-GCM" },
      !1,
      ["decrypt"]
    ), i = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: t },
      s,
      k(e)
    );
    return new Uint8Array(i);
  }
  generateNonce() {
    const e = new Uint8Array(32);
    return crypto.getRandomValues(e), C(e);
  }
  async hashData(e) {
    const t = await crypto.subtle.digest("SHA-256", k(e));
    return new Uint8Array(t);
  }
  // --- Deterministic Key Derivation ---
  async importMasterKey(e) {
    const t = await crypto.subtle.importKey(
      "raw",
      k(e),
      { name: "HKDF" },
      !1,
      ["deriveKey", "deriveBits"]
    );
    return new Gs(t);
  }
  async deriveBits(e, t, r) {
    const s = e, i = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode(t)
      },
      s.key,
      r
    );
    return new Uint8Array(i);
  }
  async deriveKeyPairFromSeed(e) {
    const t = await It(e), r = {
      kty: "OKP",
      crv: "Ed25519",
      x: C(new Uint8Array(t.buffer)),
      d: C(new Uint8Array(e.buffer)),
      ext: !1,
      key_ops: ["sign"]
    }, s = {
      kty: "OKP",
      crv: "Ed25519",
      x: C(new Uint8Array(t.buffer)),
      ext: !0,
      key_ops: ["verify"]
    }, [i, a] = await Promise.all([
      crypto.subtle.importKey("jwk", r, "Ed25519", !1, ["sign"]),
      crypto.subtle.importKey("jwk", s, "Ed25519", !0, ["verify"])
    ]);
    return { publicKey: a, privateKey: i };
  }
  // --- Asymmetric Encryption (ECIES) ---
  async deriveEncryptionKeyPair(e) {
    const t = Ys(e), r = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !1,
      ["deriveBits"]
    ), s = await crypto.subtle.importKey(
      "pkcs8",
      t,
      { name: "X25519" },
      !0,
      ["deriveBits"]
    ), i = await crypto.subtle.exportKey("jwk", s), a = await crypto.subtle.importKey(
      "jwk",
      { kty: i.kty, crv: i.crv, x: i.x },
      { name: "X25519" },
      !0,
      []
    );
    return new Xs({ privateKey: r, publicKey: a });
  }
  async deriveEciesKey(e, t) {
    const r = await crypto.subtle.importKey(
      "raw",
      e,
      { name: "HKDF" },
      !1,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode("wot-ecies-v1")
      },
      r,
      { name: "AES-GCM", length: 256 },
      !1,
      [t]
    );
  }
  async exportEncryptionPublicKey(e) {
    const t = e, r = await crypto.subtle.exportKey("raw", t.keyPair.publicKey);
    return new Uint8Array(r);
  }
  async encryptAsymmetric(e, t) {
    const r = await crypto.subtle.generateKey(
      { name: "X25519" },
      !0,
      ["deriveBits"]
    ), s = await crypto.subtle.importKey(
      "raw",
      k(t),
      { name: "X25519" },
      !0,
      []
    ), i = await crypto.subtle.deriveBits(
      { name: "X25519", public: s },
      r.privateKey,
      256
    ), a = await this.deriveEciesKey(i, "encrypt"), o = crypto.getRandomValues(new Uint8Array(12)), l = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: o },
      a,
      k(e)
    ), u = new Uint8Array(
      await crypto.subtle.exportKey("raw", r.publicKey)
    );
    return {
      ciphertext: new Uint8Array(l),
      nonce: o,
      ephemeralPublicKey: u
    };
  }
  async decryptAsymmetric(e, t) {
    const r = t;
    if (!e.ephemeralPublicKey)
      throw new Error("Missing ephemeral public key");
    const s = await crypto.subtle.importKey(
      "raw",
      k(e.ephemeralPublicKey),
      { name: "X25519" },
      !0,
      []
    ), i = await crypto.subtle.deriveBits(
      { name: "X25519", public: s },
      r.keyPair.privateKey,
      256
    ), a = await this.deriveEciesKey(i, "decrypt"), o = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: e.nonce },
      a,
      k(e.ciphertext)
    );
    return new Uint8Array(o);
  }
  // --- Utilities ---
  randomBytes(e) {
    return crypto.getRandomValues(new Uint8Array(e));
  }
}
class Mi {
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
    this.storage = e ?? new st(), this.crypto = t ?? new Zs();
  }
  /**
   * Create a new identity with BIP39 mnemonic
   *
   * @param userPassphrase - User's passphrase for seed encryption
   * @param storeSeed - Store encrypted seed in IndexedDB (default: true)
   * @returns Mnemonic (12 words) and DID
   */
  async create(e, t = !0) {
    const r = Lr(se, 128), s = Dt(r, "");
    return t && await this.storage.storeSeed(new Uint8Array(s.slice(0, 32)), e), await this.initFromSeed(new Uint8Array(s.slice(0, 32))), { mnemonic: r, did: this.did };
  }
  /**
   * Unlock identity from mnemonic + passphrase
   *
   * @param mnemonic - 12 word BIP39 mnemonic
   * @param passphrase - User's passphrase
   * @param storeSeed - Store encrypted seed in IndexedDB (default: false)
   */
  async unlock(e, t, r = !1) {
    if (!Vr(e, se))
      throw new Error("Invalid mnemonic");
    const s = Dt(e, "");
    r && await this.storage.storeSeed(new Uint8Array(s.slice(0, 32)), t), await this.initFromSeed(new Uint8Array(s.slice(0, 32)));
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
    return ln(e, this.ensureUnlocked().keyPair.privateKey);
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
    const t = await this.crypto.deriveBits(this.masterKey, "wot-identity-v1", 256);
    this.identityKeyPair = await this.crypto.deriveKeyPairFromSeed(t), this.did = await this.crypto.createDid(this.identityKeyPair.publicKey);
  }
}
class _e {
  static async createProfileDocument(e, t, r = Date.now()) {
    if (e.did !== t.getDid()) throw new Error("Profile DID does not match identity");
    const s = await t.getEncryptionPublicKeyBytes(), i = gr(e.did, {
      keyAgreement: [
        {
          id: "#enc-0",
          type: "X25519KeyAgreementKey2020",
          controller: e.did,
          publicKeyMultibase: pr(s)
        }
      ]
    });
    return {
      did: e.did,
      version: r,
      didDocument: i,
      profile: Qs(e),
      updatedAt: e.updatedAt
    };
  }
  /**
   * Sign a public profile as JWS using the identity's private key
   */
  static async signProfile(e, t, r = {}) {
    return t.signJws(await this.createProfileDocument(e, t, r.version));
  }
  static async verifySignedPayload(e) {
    try {
      const t = Fe(e);
      if (!yt(t)) return { valid: !1, error: "Invalid JWS payload" };
      if (typeof t.did != "string" || !t.did.startsWith("did:key:z"))
        return { valid: !1, error: "Missing or invalid DID in payload" };
      const r = we(t.did), s = await crypto.subtle.importKey(
        "raw",
        k(r),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ), i = await wt(e, s);
      return i.valid ? { valid: !0, payload: i.payload } : { valid: !1, error: i.error ?? "Signature verification failed" };
    } catch (t) {
      return { valid: !1, error: t instanceof Error ? t.message : "Verification failed" };
    }
  }
  /**
   * Verify a JWS-signed profile.
   * Extracts the DID from the payload, resolves the public key,
   * and verifies the signature.
   */
  static async verifyProfile(e) {
    try {
      const t = Fe(e);
      if (!t || typeof t != "object")
        return { valid: !1, error: "Invalid JWS payload" };
      const r = t;
      if (!r.did || !r.did.startsWith("did:key:z"))
        return { valid: !1, error: "Missing or invalid DID in profile" };
      if (!Number.isInteger(r.version) || r.version < 0)
        return { valid: !1, error: "Missing or invalid profile version" };
      if (!yt(r.didDocument) || r.didDocument.id !== r.did)
        return { valid: !1, error: "Missing or invalid DID document" };
      if (!yt(r.profile) || typeof r.profile.name != "string" || r.profile.name.length === 0)
        return { valid: !1, error: "Missing or invalid profile metadata" };
      if ("encryptionPublicKey" in r.profile)
        return { valid: !1, error: "Profile metadata must not contain encryptionPublicKey" };
      if (typeof r.updatedAt != "string")
        return { valid: !1, error: "Missing or invalid updatedAt" };
      const s = we(r.did), i = await crypto.subtle.importKey(
        "raw",
        k(s),
        { name: "Ed25519" },
        !0,
        ["verify"]
      ), a = await wt(e, i);
      if (!a.valid)
        return { valid: !1, error: a.error ?? "Signature verification failed" };
      const o = a.payload;
      return {
        valid: !0,
        profile: ei(o),
        didDocument: o.didDocument,
        version: o.version
      };
    } catch (t) {
      return {
        valid: !1,
        error: t instanceof Error ? t.message : "Verification failed"
      };
    }
  }
}
function Qs(n) {
  var e, t, r;
  return {
    name: n.name,
    ...n.bio ? { bio: n.bio } : {},
    ...n.avatar ? { avatar: n.avatar } : {},
    ...(e = n.offers) != null && e.length ? { offers: n.offers } : {},
    ...(t = n.needs) != null && t.length ? { needs: n.needs } : {},
    ...(r = n.protocols) != null && r.length ? { protocols: n.protocols } : {}
  };
}
function ei(n) {
  var e, t, r;
  return {
    did: n.did,
    name: n.profile.name,
    ...n.profile.bio ? { bio: n.profile.bio } : {},
    ...n.profile.avatar ? { avatar: n.profile.avatar } : {},
    ...(e = n.profile.offers) != null && e.length ? { offers: n.profile.offers } : {},
    ...(t = n.profile.needs) != null && t.length ? { needs: n.profile.needs } : {},
    ...(r = n.profile.protocols) != null && r.length ? { protocols: n.profile.protocols } : {},
    updatedAt: n.updatedAt
  };
}
function yt(n) {
  return typeof n == "object" && n !== null && !Array.isArray(n);
}
const er = /* @__PURE__ */ new Map();
function ti(n, e) {
  let t = "";
  for (let r = 0; r < n.length; r++) t += n[r].toString(16).padStart(2, "0");
  return `${t}:${e}`;
}
async function tr(n, e) {
  const t = ti(n, e);
  let r = er.get(t);
  return r || (r = await crypto.subtle.importKey(
    "raw",
    n,
    { name: "AES-GCM" },
    !1,
    [e]
  ), er.set(t, r)), r;
}
class Ki {
  /**
   * Encrypt a CRDT change with a group key.
   */
  static async encryptChange(e, t, r, s, i) {
    const a = await tr(t, "encrypt"), o = crypto.getRandomValues(new Uint8Array(12)), l = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: o },
      a,
      e
    );
    return {
      ciphertext: new Uint8Array(l),
      nonce: o,
      spaceId: r,
      generation: s,
      fromDid: i
    };
  }
  /**
   * Decrypt a CRDT change with a group key.
   */
  static async decryptChange(e, t) {
    const r = await tr(t, "decrypt"), s = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: e.nonce },
      r,
      e.ciphertext
    );
    return new Uint8Array(s);
  }
}
class Pi {
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
    let s = this.spaces.get(e);
    for (s || (s = { keys: [] }, this.spaces.set(e, s)); s.keys.length <= r; )
      s.keys.push(new Uint8Array(0));
    s.keys[r] = t;
  }
  /**
   * Apply a key-rotation message only if it is exactly the next generation.
   */
  importRotationKey(e, t, r) {
    const s = this.getCurrentGeneration(e);
    return r <= s ? "stale" : r > s + 1 ? "future" : (this.importKey(e, t, r), "applied");
  }
}
class Ti {
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
      const [t, r, s] = await Promise.all([
        this.discovery.resolveProfile(e),
        this.discovery.resolveVerifications(e),
        this.discovery.resolveAttestations(e)
      ]);
      return await this.store.cacheEntry(e, t.profile, r, s), this.store.getEntry(e);
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
    const t = await this.store.getEntries(e), r = e.filter((s) => {
      const i = t.get(s);
      return !i || this.isStale(i);
    });
    if (r.length !== 0)
      for (let s = 0; s < r.length; s += this.concurrency) {
        const i = r.slice(s, s + this.concurrency);
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
class Ci {
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
    for (const [r, s] of e)
      t.includes(s) && this.deliveryStatus.set(r, s);
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
    (t = this.receiptUnsubscribe) == null || t.call(this), (r = this.messageUnsubscribe) == null || r.call(this), this.receiptUnsubscribe = e.onReceipt((s) => {
      this.deliveryStatus.has(s.messageId) && (s.status === "delivered" ? this.setStatus(s.messageId, "delivered") : s.status === "failed" && this.setStatus(s.messageId, "failed"));
    }), this.messageUnsubscribe = e.onMessage((s) => {
      if (s.type === "attestation-ack")
        try {
          const { attestationId: i } = JSON.parse(s.payload);
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
    for (const s of t)
      s.envelope.type === "attestation" && (r.add(s.envelope.id), this.setStatus(s.envelope.id, "queued"));
    for (const [s, i] of this.deliveryStatus)
      i === "sending" && !r.has(s) && this.setStatus(s, "failed");
  }
  // --- Private ---
  notifySubscribers() {
    for (const e of this.statusSubscribers)
      e(this.deliveryStatus);
  }
}
const Ne = 1e3, ri = "wot-trace-log", X = "traces", ni = 500;
class si {
  constructor() {
    c(this, "entries", []);
    c(this, "nextId", 1);
    c(this, "subscribers", /* @__PURE__ */ new Set());
    c(this, "db", null);
    c(this, "pendingWrites", []);
    c(this, "flushTimer", null);
    c(this, "initialized", !1);
  }
  async init() {
    if (!this.initialized && (this.initialized = !0, !(typeof indexedDB > "u")))
      try {
        this.db = await this.openDb();
        const e = await this.loadFromDb();
        e.length > 0 && (this.entries = e.slice(-Ne), this.nextId = Math.max(...this.entries.map((t) => t.id)) + 1), this.startFlushTimer();
      } catch (e) {
        console.warn("[TraceLog] IndexedDB init failed, running in-memory only:", e);
      }
  }
  log(e) {
    const t = {
      ...e,
      id: this.nextId++,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    return this.entries.push(t), this.entries.length > Ne && this.entries.shift(), this.pendingWrites.push(t), this.notifySubscribers(t), t;
  }
  getAll(e) {
    let t = [...this.entries];
    return e != null && e.store && (t = t.filter((r) => r.store === e.store)), e != null && e.operation && (t = t.filter((r) => r.operation === e.operation)), (e == null ? void 0 : e.success) !== void 0 && (t = t.filter((r) => r.success === e.success)), e != null && e.since && (t = t.filter((r) => r.timestamp >= e.since)), e != null && e.limit && (t = t.slice(-e.limit)), t;
  }
  getLatest(e = 50) {
    return this.entries.slice(-e);
  }
  getErrors(e = 20) {
    return this.entries.filter((t) => !t.success).slice(-e);
  }
  getByStore(e) {
    return this.entries.filter((t) => t.store === e);
  }
  getPerformanceSummary() {
    const e = /* @__PURE__ */ new Map();
    for (const r of this.entries) {
      if (!r.success) continue;
      const s = `${r.store}:${r.operation}`;
      let i = e.get(s);
      i || (i = [], e.set(s, i)), i.push(r.durationMs);
    }
    const t = {};
    for (const [r, s] of e) {
      const i = [...s].sort((h, d) => h - d), a = i.length, o = Math.round(i.reduce((h, d) => h + d, 0) / a), l = i[Math.floor(a * 0.95)] ?? i[a - 1], u = i[a - 1];
      t[r] = { count: a, avgMs: o, p95Ms: l, maxMs: u };
    }
    return t;
  }
  subscribe(e) {
    return this.subscribers.add(e), () => this.subscribers.delete(e);
  }
  clear() {
    if (this.entries = [], this.pendingWrites = [], this.db)
      try {
        this.db.transaction(X, "readwrite").objectStore(X).clear();
      } catch {
      }
  }
  get size() {
    return this.entries.length;
  }
  // --- Private ---
  notifySubscribers(e) {
    for (const t of this.subscribers)
      try {
        t(e);
      } catch {
      }
  }
  startFlushTimer() {
    this.flushTimer || (this.flushTimer = setTimeout(() => {
      this.flushTimer = null, this.flushToDb().finally(() => {
        this.pendingWrites.length > 0 && this.startFlushTimer();
      });
    }, ni));
  }
  async flushToDb() {
    if (!this.db || this.pendingWrites.length === 0) return;
    const e = this.pendingWrites.splice(0);
    try {
      const r = this.db.transaction(X, "readwrite").objectStore(X);
      for (const i of e)
        r.put(i);
      const s = r.count();
      s.onsuccess = () => {
        const i = s.result;
        if (i > Ne) {
          const a = i - Ne, o = r.openCursor();
          let l = 0;
          o.onsuccess = () => {
            const u = o.result;
            u && l < a && (u.delete(), l++, u.continue());
          };
        }
      };
    } catch (t) {
      console.warn("[TraceLog] flush to IDB failed:", t);
    }
  }
  openDb() {
    return new Promise((e, t) => {
      const r = indexedDB.open(ri, 1);
      r.onupgradeneeded = () => {
        const s = r.result;
        s.objectStoreNames.contains(X) || s.createObjectStore(X, { keyPath: "id" });
      }, r.onsuccess = () => e(r.result), r.onerror = () => t(r.error);
    });
  }
  loadFromDb() {
    return new Promise((e, t) => {
      if (!this.db) return e([]);
      try {
        const i = this.db.transaction(X, "readonly").objectStore(X).getAll();
        i.onsuccess = () => e(i.result ?? []), i.onerror = () => t(i.error);
      } catch {
        e([]);
      }
    });
  }
}
let pt = null;
function b() {
  return pt || (pt = new si()), pt;
}
async function ii(n, e, t, r, s) {
  const i = b(), a = performance.now();
  try {
    const o = await r(), l = Math.round(performance.now() - a), u = o instanceof Uint8Array ? o.byteLength : void 0;
    return i.log({ store: n, operation: e, label: t, durationMs: l, sizeBytes: u, success: !0, meta: s }), o;
  } catch (o) {
    const l = Math.round(performance.now() - a);
    throw i.log({
      store: n,
      operation: e,
      label: t,
      durationMs: l,
      success: !1,
      error: o instanceof Error ? o.message : String(o),
      meta: s
    }), o;
  }
}
function Ii(n, e, t, r, s) {
  return ii(n, (r == null ? void 0 : r.method) === "GET" ? "read" : "write", e, async () => {
    const i = await fetch(t, r);
    if (!i.ok)
      throw new Error(`HTTP ${i.status} ${i.statusText}`);
    return i;
  }, { url: t, method: (r == null ? void 0 : r.method) ?? "GET", ...s });
}
function ai(n) {
  typeof window < "u" && (window.wotTrace = (e) => n.getAll(e), window.wotTracePerf = () => n.getPerformanceSummary(), window.wotTraceClear = () => n.clear());
}
class $i {
  constructor(e, t) {
    c(this, "vaultUrl");
    c(this, "identity");
    c(this, "capabilityCache", /* @__PURE__ */ new Map());
    c(this, "bearerToken", null);
    this.vaultUrl = e.replace(/\/$/, ""), this.identity = t;
  }
  /**
   * Push an encrypted change to the vault.
   * @returns The assigned sequence number.
   */
  async pushChange(e, t) {
    const r = b(), s = performance.now();
    try {
      const i = await this.authHeaders(e, ["read", "write"]), a = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}/changes`, {
        method: "POST",
        headers: i,
        body: t
      });
      if (!a.ok) {
        const l = await a.text().catch(() => "");
        throw new Error(`Vault pushChange failed: ${a.status} ${l}`);
      }
      const o = await a.json();
      return r.log({ store: "vault", operation: "write", label: `pushChange ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), sizeBytes: t.byteLength, success: !0, meta: { docId: e, seq: o.seq } }), o.seq;
    } catch (i) {
      throw r.log({ store: "vault", operation: "write", label: `pushChange ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), sizeBytes: t.byteLength, success: !1, error: i instanceof Error ? i.message : String(i), meta: { docId: e } }), i;
    }
  }
  /**
   * Get all changes (and optional snapshot) for a document.
   */
  async getChanges(e, t = 0) {
    var i;
    const r = b(), s = performance.now();
    try {
      const a = await this.authHeaders(e, ["read"]), o = `${this.vaultUrl}/docs/${encodeURIComponent(e)}/changes${t > 0 ? `?since=${t}` : ""}`, l = await fetch(o, { headers: a });
      if (l.status === 404)
        return r.log({ store: "vault", operation: "read", label: `getChanges ${e.slice(0, 12)}… (not found)`, durationMs: Math.round(performance.now() - s), success: !0, meta: { docId: e, since: t, changes: 0 } }), { docId: e, snapshot: null, changes: [] };
      if (!l.ok) {
        const h = await l.text().catch(() => "");
        throw new Error(`Vault getChanges failed: ${l.status} ${h}`);
      }
      const u = await l.json();
      return r.log({ store: "vault", operation: "read", label: `getChanges ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { docId: e, since: t, changes: ((i = u.changes) == null ? void 0 : i.length) ?? 0, hasSnapshot: !!u.snapshot } }), u;
    } catch (a) {
      throw r.log({ store: "vault", operation: "read", label: `getChanges ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: a instanceof Error ? a.message : String(a), meta: { docId: e, since: t } }), a;
    }
  }
  /**
   * Store a compacted snapshot (replaces changes up to upToSeq).
   */
  async putSnapshot(e, t, r, s) {
    const i = b(), a = performance.now(), o = 1 + r.length + t.length;
    try {
      const l = await this.authHeaders(e, ["read", "write"]);
      l["Content-Type"] = "application/json";
      const u = new Uint8Array(o);
      u[0] = r.length, u.set(r, 1), u.set(t, 1 + r.length);
      const h = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}/snapshot`, {
        method: "PUT",
        headers: l,
        body: JSON.stringify({
          data: on(u),
          upToSeq: s
        })
      });
      if (!h.ok) {
        const d = await h.text().catch(() => "");
        throw new Error(`Vault putSnapshot failed: ${h.status} ${d}`);
      }
      i.log({ store: "vault", operation: "write", label: `putSnapshot ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - a), sizeBytes: o, success: !0, meta: { docId: e, upToSeq: s } });
    } catch (l) {
      throw i.log({ store: "vault", operation: "write", label: `putSnapshot ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - a), sizeBytes: o, success: !1, error: l instanceof Error ? l.message : String(l), meta: { docId: e, upToSeq: s } }), l;
    }
  }
  /**
   * Get document info (seq, change count).
   */
  async getDocInfo(e) {
    const t = b(), r = performance.now();
    try {
      const s = await this.authHeaders(e, ["read"]), i = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}/info`, { headers: s });
      if (i.status === 404)
        return t.log({ store: "vault", operation: "read", label: `getDocInfo ${e.slice(0, 12)}… (not found)`, durationMs: Math.round(performance.now() - r), success: !0, meta: { docId: e } }), null;
      if (!i.ok) {
        const o = await i.text().catch(() => "");
        throw new Error(`Vault getDocInfo failed: ${i.status} ${o}`);
      }
      const a = await i.json();
      return t.log({ store: "vault", operation: "read", label: `getDocInfo ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { docId: e, ...a } }), a;
    } catch (s) {
      throw t.log({ store: "vault", operation: "read", label: `getDocInfo ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: s instanceof Error ? s.message : String(s), meta: { docId: e } }), s;
    }
  }
  /**
   * Delete a document from the vault.
   */
  async deleteDoc(e) {
    const t = b(), r = performance.now();
    try {
      const s = await this.authHeaders(e, ["read", "write", "delete"]), i = await fetch(`${this.vaultUrl}/docs/${encodeURIComponent(e)}`, {
        method: "DELETE",
        headers: s
      });
      if (!i.ok && i.status !== 404) {
        const a = await i.text().catch(() => "");
        throw new Error(`Vault deleteDoc failed: ${i.status} ${a}`);
      }
      t.log({ store: "vault", operation: "delete", label: `deleteDoc ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { docId: e } });
    } catch (s) {
      throw t.log({ store: "vault", operation: "delete", label: `deleteDoc ${e.slice(0, 12)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: s instanceof Error ? s.message : String(s), meta: { docId: e } }), s;
    }
  }
  // --- Auth ---
  async authHeaders(e, t) {
    const r = await this.getOrCreateBearerToken(), s = await this.getOrCreateCapability(e, t);
    return {
      Authorization: `Bearer ${r}`,
      "X-Capability": s
    };
  }
  async getOrCreateBearerToken() {
    if (this.bearerToken && this.bearerToken.expiresAt > Date.now())
      return this.bearerToken.jws;
    const e = await this.identity.signJws({
      did: this.identity.getDid(),
      iat: Math.floor(Date.now() / 1e3)
    });
    return this.bearerToken = { jws: e, expiresAt: Date.now() + 240 * 1e3 }, e;
  }
  async getOrCreateCapability(e, t) {
    const r = `${e}:${t.sort().join(",")}`, s = this.capabilityCache.get(r);
    if (s && s.expiresAt > Date.now())
      return s.jws;
    const i = new Date(Date.now() + 3600 * 1e3).toISOString(), a = await Jr(
      {
        issuer: this.identity.getDid(),
        audience: this.identity.getDid(),
        resource: nn("space", e),
        permissions: t,
        expiration: i
      },
      (o) => this.identity.signJws(o)
    );
    if (this.capabilityCache.size > 50) {
      const o = Date.now();
      for (const [l, u] of this.capabilityCache)
        u.expiresAt <= o && this.capabilityCache.delete(l);
    }
    return this.capabilityCache.set(r, {
      jws: a,
      expiresAt: Date.now() + 3300 * 1e3
    }), a;
  }
}
class zi {
  constructor(e) {
    c(this, "pushFn");
    c(this, "getHeadsFn");
    c(this, "debounceMs");
    c(this, "lastPushedHeads", null);
    c(this, "debounceTimer", null);
    c(this, "pushing", !1);
    c(this, "pendingAfterPush", !1);
    c(this, "destroyed", !1);
    c(this, "onVisibilityChange", null);
    c(this, "onBeforeUnload", null);
    this.pushFn = e.pushFn, this.getHeadsFn = e.getHeadsFn, this.debounceMs = e.debounceMs ?? 5e3, typeof document < "u" && (this.onVisibilityChange = () => {
      document.visibilityState === "hidden" && this.flush();
    }, document.addEventListener("visibilitychange", this.onVisibilityChange)), typeof window < "u" && (this.onBeforeUnload = () => {
      this.flush();
    }, window.addEventListener("beforeunload", this.onBeforeUnload));
  }
  /** Set initial heads (e.g. after loading from vault — vault already has this state). */
  setLastPushedHeads(e) {
    this.lastPushedHeads = e;
  }
  /** Explicit user action — push immediately (deduplicated). */
  pushImmediate() {
    this.destroyed || (this.clearDebounce(), this.schedulePush());
  }
  /** Streaming / remote sync — push after debounce delay. */
  pushDebounced() {
    this.destroyed || (this.clearDebounce(), this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null, this.schedulePush();
    }, this.debounceMs));
  }
  /** Flush any pending debounced push immediately (lifecycle events). */
  flush() {
    this.destroyed || this.debounceTimer && (this.clearDebounce(), this.schedulePush());
  }
  /** Clean up timers and lifecycle handlers. */
  destroy() {
    this.destroyed = !0, this.clearDebounce(), this.onVisibilityChange && typeof document < "u" && (document.removeEventListener("visibilitychange", this.onVisibilityChange), this.onVisibilityChange = null), this.onBeforeUnload && typeof window < "u" && (window.removeEventListener("beforeunload", this.onBeforeUnload), this.onBeforeUnload = null);
  }
  // --- Private ---
  clearDebounce() {
    this.debounceTimer && (clearTimeout(this.debounceTimer), this.debounceTimer = null);
  }
  schedulePush() {
    if (this.pushing) {
      this.pendingAfterPush = !0;
      return;
    }
    const e = this.getHeadsFn();
    e !== null && e === this.lastPushedHeads || (this.pushing = !0, this.pushFn().then(() => {
      this.lastPushedHeads = this.getHeadsFn();
    }).catch(() => {
    }).finally(() => {
      this.pushing = !1, this.pendingAfterPush && !this.destroyed && (this.pendingAfterPush = !1, this.schedulePush());
    }));
  }
}
const oi = "web-of-trust", ci = 2;
class Ui {
  constructor() {
    c(this, "db", null);
  }
  async init() {
    this.db = await nr(oi, ci, {
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
    const r = this.ensureDb(), s = (/* @__PURE__ */ new Date()).toISOString(), i = {
      did: e,
      profile: t,
      createdAt: s,
      updatedAt: s
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
    for (const s of r)
      s.from === e.from && s.to === e.to && s.id !== e.id && await t.delete("verifications", s.id);
    await t.put("verifications", e);
  }
  async getReceivedVerifications() {
    const e = this.ensureDb(), t = await this.getIdentity();
    return t ? (await e.getAll("verifications")).filter((s) => s.to === t.did) : [];
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
    const r = this.ensureDb(), s = {
      attestationId: e,
      accepted: t,
      ...t ? { acceptedAt: (/* @__PURE__ */ new Date()).toISOString() } : {}
    };
    await r.put("attestationMetadata", s);
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
const Gr = "wot.identity.seed", Xr = 1, Yr = "bip39-64-byte", gt = "Stored identity uses an unsupported legacy seed format. Create a new ID to continue.";
class Oi {
  constructor(e = new st()) {
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
      type: Gr,
      version: Xr,
      seedFormat: Yr,
      seed: x(e)
    };
    return new TextEncoder().encode(JSON.stringify(t));
  }
  decodeSeed(e) {
    let t;
    try {
      t = JSON.parse(new TextDecoder().decode(e));
    } catch {
      throw new Error(gt);
    }
    if (!li(t)) throw new Error(gt);
    try {
      return K(t.seed);
    } catch {
      throw new Error(gt);
    }
  }
}
function li(n) {
  if (!n || typeof n != "object") return !1;
  const e = n;
  return e.type === Gr && e.version === Xr && e.seedFormat === Yr && typeof e.seed == "string";
}
const E = class E {
  constructor() {
    c(this, "myDid", null);
    c(this, "state", "disconnected");
    c(this, "messageCallbacks", /* @__PURE__ */ new Set());
    c(this, "receiptCallbacks", /* @__PURE__ */ new Set());
    c(this, "stateCallbacks", /* @__PURE__ */ new Set());
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
    let t = E.registry.get(e);
    t || (t = /* @__PURE__ */ new Set(), E.registry.set(e, t)), t.add(this);
    const r = E.offlineQueue.get(e);
    if (r && r.length > 0) {
      E.offlineQueue.delete(e);
      for (const s of r)
        await this.deliverToSelf(s);
    }
  }
  async disconnect() {
    if (this.myDid) {
      const e = E.registry.get(this.myDid);
      e && (e.delete(this), e.size === 0 && E.registry.delete(this.myDid));
    }
    this.myDid = null, this.notifyStateChange("disconnected");
  }
  getState() {
    return this.state;
  }
  async send(e) {
    if (this.state !== "connected" || !this.myDid)
      throw new Error("MessagingAdapter: must call connect() before send()");
    const t = (/* @__PURE__ */ new Date()).toISOString(), r = E.registry.get(e.toDid);
    if (r && r.size > 0) {
      for (const a of r)
        await a.deliverToSelf(e);
      const i = {
        messageId: e.id,
        status: "delivered",
        timestamp: t
      };
      for (const a of this.receiptCallbacks)
        a(i);
    }
    const s = E.offlineQueue.get(e.toDid) ?? [];
    return s.push(e), E.offlineQueue.set(e.toDid, s), {
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
    E.transportMap.set(e, t);
  }
  async resolveTransport(e) {
    return E.transportMap.get(e) ?? null;
  }
  /** Reset all shared state. Call in afterEach() for test isolation. */
  static resetAll() {
    for (const e of E.registry.values())
      for (const t of e)
        t.myDid = null, t.state = "disconnected";
    E.registry.clear(), E.offlineQueue.clear(), E.transportMap.clear();
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
c(E, "registry", /* @__PURE__ */ new Map()), c(E, "offlineQueue", /* @__PURE__ */ new Map()), c(E, "transportMap", /* @__PURE__ */ new Map());
let rr = E;
class Bi {
  constructor(e, t) {
    c(this, "ws", null);
    c(this, "state", "disconnected");
    c(this, "messageCallbacks", /* @__PURE__ */ new Set());
    c(this, "receiptCallbacks", /* @__PURE__ */ new Set());
    c(this, "stateCallbacks", /* @__PURE__ */ new Set());
    c(this, "transportMap", /* @__PURE__ */ new Map());
    c(this, "pendingReceipts", /* @__PURE__ */ new Map());
    /** Buffer for messages that arrive before any onMessage handler is registered */
    c(this, "earlyMessageBuffer", []);
    c(this, "heartbeatInterval", null);
    c(this, "heartbeatTimeout", null);
    c(this, "HEARTBEAT_INTERVAL_MS", 15e3);
    c(this, "HEARTBEAT_TIMEOUT_MS", 5e3);
    c(this, "SEND_TIMEOUT_MS");
    c(this, "signChallenge");
    c(this, "connectedDid", null);
    c(this, "peerCount", 0);
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
      return this.state === "connected" && await this.disconnect(), this.setState("connecting"), new Promise((t, r) => {
        this.ws = new WebSocket(this.relayUrl), this.ws.onopen = () => {
          var s;
          if (((s = this.ws) == null ? void 0 : s.readyState) === WebSocket.OPEN)
            this.ws.send(JSON.stringify({ type: "register", did: e }));
          else {
            const i = this.ws, a = () => {
              i.readyState === WebSocket.OPEN ? i.send(JSON.stringify({ type: "register", did: e })) : i.readyState === WebSocket.CONNECTING ? setTimeout(a, 10) : r(new Error("WebSocket closed before registration"));
            };
            setTimeout(a, 10);
          }
        }, this.ws.onmessage = (s) => {
          let i;
          try {
            i = JSON.parse(typeof s.data == "string" ? s.data : s.data.toString());
          } catch {
            console.warn("[WebSocket] Received malformed JSON, ignoring");
            return;
          }
          switch (i.type) {
            case "challenge":
              this.signChallenge ? this.signChallenge(i.nonce).then((a) => {
                var o;
                (o = this.ws) == null || o.send(JSON.stringify({
                  type: "challenge-response",
                  did: e,
                  nonce: i.nonce,
                  signature: a
                }));
              }).catch((a) => {
                this.setState("error"), r(new Error(`Challenge signing failed: ${a instanceof Error ? a.message : String(a)}`));
              }) : (this.setState("error"), r(new Error("Relay requires challenge-response auth but no signChallenge function provided")));
              break;
            case "registered":
              this.connectedDid = e, this.peerCount = typeof i.peers == "number" ? i.peers : 0, this.setState("connected"), this.startHeartbeat(), t();
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
    for (const r of this.messageCallbacks)
      try {
        await r(e), t = !0;
      } catch (s) {
        console.error("Message callback error:", s);
      }
    t && this.ws && this.ws.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "ack", messageId: e.id }));
  }
  handlePong() {
    this.heartbeatTimeout && (clearTimeout(this.heartbeatTimeout), this.heartbeatTimeout = null);
  }
  async send(e) {
    if (this.state !== "connected" || !this.ws)
      throw new Error("WebSocketMessagingAdapter: must call connect() before send()");
    return new Promise((t, r) => {
      const s = this.SEND_TIMEOUT_MS > 0 ? setTimeout(() => {
        this.pendingReceipts.delete(e.id), r(new Error(`Send timeout: no receipt from relay after ${this.SEND_TIMEOUT_MS}ms`));
      }, this.SEND_TIMEOUT_MS) : null;
      if (this.pendingReceipts.set(e.id, (i) => {
        s && clearTimeout(s), t(i);
      }), this.ws.readyState !== WebSocket.OPEN) {
        s && clearTimeout(s), this.pendingReceipts.delete(e.id), r(new Error("WebSocket not open"));
        return;
      }
      this.ws.send(JSON.stringify({ type: "send", envelope: e }));
    });
  }
  onMessage(e) {
    if (this.messageCallbacks.add(e), this.earlyMessageBuffer.length > 0) {
      const t = this.earlyMessageBuffer.splice(0);
      for (const r of t)
        this.handleIncomingMessage(r);
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
class _i {
  constructor(e = "wot-compact-store") {
    c(this, "dbName");
    c(this, "db", null);
    this.dbName = e;
  }
  async open() {
    return new Promise((e, t) => {
      const r = indexedDB.open(this.dbName, 1);
      r.onupgradeneeded = () => {
        const s = r.result;
        s.objectStoreNames.contains("snapshots") || s.createObjectStore("snapshots");
      }, r.onsuccess = () => {
        this.db = r.result, e();
      }, r.onerror = () => {
        t(r.error);
      };
    });
  }
  async save(e, t) {
    const r = this.getDb();
    return new Promise((s, i) => {
      const l = r.transaction("snapshots", "readwrite").objectStore("snapshots").put(t, e);
      l.onsuccess = () => s(), l.onerror = () => i(l.error);
    });
  }
  async load(e) {
    const t = this.getDb();
    return new Promise((r, s) => {
      const o = t.transaction("snapshots", "readonly").objectStore("snapshots").get(e);
      o.onsuccess = () => r(o.result ?? null), o.onerror = () => s(o.error);
    });
  }
  async delete(e) {
    const t = this.getDb();
    return new Promise((r, s) => {
      const o = t.transaction("snapshots", "readwrite").objectStore("snapshots").delete(e);
      o.onsuccess = () => r(), o.onerror = () => s(o.error);
    });
  }
  async list() {
    const e = this.getDb();
    return new Promise((t, r) => {
      const i = e.transaction("snapshots", "readonly").objectStore("snapshots"), a = [], o = i.openCursor();
      o.onsuccess = () => {
        const l = o.result;
        l ? (a.push(l.key), l.continue()) : t(a);
      }, o.onerror = () => r(o.error);
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
class Ni {
  constructor(e) {
    c(this, "TIMEOUT_MS", 3e3);
    this.baseUrl = e;
  }
  fetchWithTimeout(e, t) {
    const r = new AbortController(), s = setTimeout(() => r.abort(), this.TIMEOUT_MS);
    return fetch(e, { ...t, signal: r.signal }).finally(() => clearTimeout(s));
  }
  async publishProfile(e, t) {
    const r = b(), s = performance.now();
    try {
      const i = await _e.signProfile(e, t), a = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}`,
        { method: "PUT", body: i, headers: { "Content-Type": "application/jws" } }
      );
      if (!a.ok) throw new Error(`Profile upload failed: ${a.status}`);
      r.log({ store: "profiles", operation: "write", label: `publishProfile ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e.did, name: e.name } });
    } catch (i) {
      throw r.log({ store: "profiles", operation: "write", label: `publishProfile ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: i instanceof Error ? i.message : String(i), meta: { did: e.did } }), i;
    }
  }
  async publishVerifications(e, t) {
    var i;
    const r = b(), s = performance.now();
    try {
      const a = await t.signJws(e), o = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}/v`,
        { method: "PUT", body: a, headers: { "Content-Type": "text/plain" } }
      );
      if (!o.ok) throw new Error(`Verifications upload failed: ${o.status}`);
      r.log({ store: "profiles", operation: "write", label: `publishVerifications ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e.did, count: ((i = e.verifications) == null ? void 0 : i.length) ?? 0 } });
    } catch (a) {
      throw r.log({ store: "profiles", operation: "write", label: `publishVerifications ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: a instanceof Error ? a.message : String(a), meta: { did: e.did } }), a;
    }
  }
  async publishAttestations(e, t) {
    var i;
    const r = b(), s = performance.now();
    try {
      const a = await t.signJws(e), o = await this.fetchWithTimeout(
        `${this.baseUrl}/p/${encodeURIComponent(e.did)}/a`,
        { method: "PUT", body: a, headers: { "Content-Type": "text/plain" } }
      );
      if (!o.ok) throw new Error(`Attestations upload failed: ${o.status}`);
      r.log({ store: "profiles", operation: "write", label: `publishAttestations ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !0, meta: { did: e.did, count: ((i = e.attestations) == null ? void 0 : i.length) ?? 0 } });
    } catch (a) {
      throw r.log({ store: "profiles", operation: "write", label: `publishAttestations ${e.did.slice(0, 24)}…`, durationMs: Math.round(performance.now() - s), success: !1, error: a instanceof Error ? a.message : String(a), meta: { did: e.did } }), a;
    }
  }
  async resolveProfile(e) {
    const t = b(), r = performance.now();
    try {
      const s = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}`);
      if (s.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e, found: !1 } }), { profile: null, fromCache: !1 };
      if (!s.ok) throw new Error(`Profile fetch failed: ${s.status}`);
      const i = await s.text(), a = await _e.verifyProfile(i), o = a.valid && a.profile ? a.profile : null;
      return t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e, found: !!o, name: o == null ? void 0 : o.name } }), { profile: o, didDocument: a.didDocument ?? null, version: a.version, fromCache: !1 };
    } catch (s) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveProfile ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: s instanceof Error ? s.message : String(s), meta: { did: e } }), s;
    }
  }
  async resolveVerifications(e) {
    const t = b(), r = performance.now();
    try {
      const s = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/v`);
      if (s.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e, count: 0 } }), [];
      if (!s.ok) throw new Error(`Verifications fetch failed: ${s.status}`);
      const i = await s.text(), a = await _e.verifySignedPayload(i);
      if (!a.valid || !a.payload) return [];
      const l = a.payload.verifications ?? [];
      return t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e, count: l.length } }), l;
    } catch (s) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveVerifications ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: s instanceof Error ? s.message : String(s), meta: { did: e } }), s;
    }
  }
  async resolveAttestations(e) {
    const t = b(), r = performance.now();
    try {
      const s = await this.fetchWithTimeout(`${this.baseUrl}/p/${encodeURIComponent(e)}/a`);
      if (s.status === 404)
        return t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}… (not found)`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e, count: 0 } }), [];
      if (!s.ok) throw new Error(`Attestations fetch failed: ${s.status}`);
      const i = await s.text(), a = await _e.verifySignedPayload(i);
      if (!a.valid || !a.payload) return [];
      const l = a.payload.attestations ?? [];
      return t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !0, meta: { did: e, count: l.length } }), l;
    } catch (s) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveAttestations ${e.slice(0, 24)}…`, durationMs: Math.round(performance.now() - r), success: !1, error: s instanceof Error ? s.message : String(s), meta: { did: e } }), s;
    }
  }
  async resolveSummaries(e) {
    const t = b(), r = performance.now();
    try {
      const s = e.map((o) => encodeURIComponent(o)).join(","), i = await this.fetchWithTimeout(`${this.baseUrl}/s?dids=${s}`);
      if (!i.ok) throw new Error(`Summary fetch failed: ${i.status}`);
      const a = await i.json();
      return t.log({ store: "profiles", operation: "read", label: `resolveSummaries (${e.length} DIDs)`, durationMs: Math.round(performance.now() - r), success: !0, meta: { count: e.length, results: a.length } }), a;
    } catch (s) {
      throw t.log({ store: "profiles", operation: "read", label: `resolveSummaries (${e.length} DIDs)`, durationMs: Math.round(performance.now() - r), success: !1, error: s instanceof Error ? s.message : String(s), meta: { count: e.length } }), s;
    }
  }
}
class ji {
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
  async syncPending(e, t, r) {
    const s = await this.publishState.getDirtyFields(e);
    if (s.size === 0) return;
    const i = await r();
    if (s.has("profile") && i.profile)
      try {
        await this.inner.publishProfile(i.profile, t), await this.publishState.clearDirty(e, "profile"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
    if (s.has("verifications") && i.verifications)
      try {
        await this.inner.publishVerifications(i.verifications, t), await this.publishState.clearDirty(e, "verifications"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
    if (s.has("attestations") && i.attestations)
      try {
        await this.inner.publishAttestations(i.attestations, t), await this.publishState.clearDirty(e, "attestations"), this.clearError();
      } catch (a) {
        this.setError(a);
      }
  }
}
class Ri {
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
class Hi {
  constructor() {
    c(this, "profiles", /* @__PURE__ */ new Map());
    c(this, "verifications", /* @__PURE__ */ new Map());
    c(this, "attestations", /* @__PURE__ */ new Map());
    c(this, "fetchedAt", /* @__PURE__ */ new Map());
    c(this, "summaryCounts", /* @__PURE__ */ new Map());
  }
  async cacheEntry(e, t, r, s) {
    t && this.profiles.set(e, t), this.verifications.set(e, r), this.attestations.set(e, s), this.fetchedAt.set(e, (/* @__PURE__ */ new Date()).toISOString()), this.summaryCounts.delete(e);
  }
  async getEntry(e) {
    const t = this.fetchedAt.get(e);
    if (!t) return null;
    const r = this.profiles.get(e), s = this.verifications.get(e) ?? [], i = this.attestations.get(e) ?? [], a = this.summaryCounts.get(e);
    return {
      did: e,
      name: r == null ? void 0 : r.name,
      bio: r == null ? void 0 : r.bio,
      avatar: r == null ? void 0 : r.avatar,
      verificationCount: (a == null ? void 0 : a.verificationCount) ?? s.length,
      attestationCount: (a == null ? void 0 : a.attestationCount) ?? i.length,
      verifierDids: s.map((o) => o.from),
      fetchedAt: t
    };
  }
  async getEntries(e) {
    const t = /* @__PURE__ */ new Map();
    for (const r of e) {
      const s = await this.getEntry(r);
      s && t.set(r, s);
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
    for (const s of e) {
      const i = (r = this.profiles.get(s)) == null ? void 0 : r.name;
      i && t.set(s, i);
    }
    return t;
  }
  async findMutualContacts(e, t) {
    const r = this.verifications.get(e) ?? [], s = new Set(r.map((i) => i.from));
    return t.filter((i) => s.has(i));
  }
  async search(e) {
    var s, i;
    const t = e.toLowerCase(), r = [];
    for (const [a] of this.fetchedAt) {
      const o = this.profiles.get(a), l = (s = o == null ? void 0 : o.name) == null ? void 0 : s.toLowerCase().includes(t), u = (i = o == null ? void 0 : o.bio) == null ? void 0 : i.toLowerCase().includes(t), d = (this.attestations.get(a) ?? []).some((f) => f.claim.toLowerCase().includes(t));
      if (l || u || d) {
        const f = await this.getEntry(a);
        f && r.push(f);
      }
    }
    return r;
  }
  async updateSummary(e, t, r, s) {
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
    this.summaryCounts.set(e, { verificationCount: r, attestationCount: s }), this.fetchedAt.has(e) || this.fetchedAt.set(e, (/* @__PURE__ */ new Date()).toISOString());
  }
  async evict(e) {
    this.profiles.delete(e), this.verifications.delete(e), this.attestations.delete(e), this.fetchedAt.delete(e), this.summaryCounts.delete(e);
  }
  async clear() {
    this.profiles.clear(), this.verifications.clear(), this.attestations.clear(), this.fetchedAt.clear(), this.summaryCounts.clear();
  }
}
class Li {
  constructor(e, t, r) {
    c(this, "flushing", !1);
    c(this, "skipTypes");
    c(this, "sendTimeoutMs");
    c(this, "reconnectIntervalMs");
    c(this, "maxRetries");
    c(this, "isOnline");
    c(this, "reconnectTimer", null);
    c(this, "myDid", null);
    c(this, "unsubscribeStateChange", null);
    this.inner = e, this.outbox = t, this.skipTypes = new Set((r == null ? void 0 : r.skipTypes) ?? ["profile-update"]), this.sendTimeoutMs = (r == null ? void 0 : r.sendTimeoutMs) ?? 15e3, this.reconnectIntervalMs = (r == null ? void 0 : r.reconnectIntervalMs) ?? 1e4, this.maxRetries = (r == null ? void 0 : r.maxRetries) ?? 50, this.isOnline = (r == null ? void 0 : r.isOnline) ?? (() => !0);
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
    return this.sendTimeoutMs <= 0 ? this.inner.send(e) : new Promise((t, r) => {
      const s = setTimeout(() => {
        r(new Error(`Send timeout after ${this.sendTimeoutMs}ms`));
      }, this.sendTimeoutMs);
      this.inner.send(e).then(
        (i) => {
          clearTimeout(s), t(i);
        },
        (i) => {
          clearTimeout(s), r(i);
        }
      );
    });
  }
}
class Fi {
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
class Vi {
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
    const t = this.groupKeys.get(e.spaceId) ?? [], r = t.findIndex((s) => s.generation === e.generation);
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
class Ji {
  constructor() {
    c(this, "data", /* @__PURE__ */ new Map());
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
function Zr(n, e) {
  return `${n}:${e}`;
}
const ui = "wot-space-metadata", di = 1, Y = "spaces", Z = "groupKeys";
class Wi {
  constructor(e = ui) {
    c(this, "dbPromise");
    this.dbPromise = nr(e, di, {
      upgrade(t) {
        t.objectStoreNames.contains(Y) || t.createObjectStore(Y, { keyPath: "info.id" }), t.objectStoreNames.contains(Z) || t.createObjectStore(Z, { keyPath: "id" }).createIndex("bySpaceId", "spaceId");
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
          ([s, i]) => [s, Array.from(i)]
        )
      )
    };
    await t.put(Y, r);
  }
  async loadSpaceMetadata(e) {
    const r = await (await this.dbPromise).get(Y, e);
    return r ? this.deserialize(r) : null;
  }
  async loadAllSpaceMetadata() {
    return (await (await this.dbPromise).getAll(Y)).map((r) => this.deserialize(r));
  }
  async deleteSpaceMetadata(e) {
    await (await this.dbPromise).delete(Y, e);
  }
  async saveGroupKey(e) {
    const t = await this.dbPromise, r = {
      id: Zr(e.spaceId, e.generation),
      spaceId: e.spaceId,
      generation: e.generation,
      key: Array.from(e.key)
    };
    await t.put(Z, r);
  }
  async loadGroupKeys(e) {
    return (await (await this.dbPromise).getAllFromIndex(Z, "bySpaceId", e)).map((s) => ({
      spaceId: s.spaceId,
      generation: s.generation,
      key: new Uint8Array(s.key)
    }));
  }
  async deleteGroupKeys(e) {
    const t = await this.dbPromise, r = await t.getAllKeysFromIndex(Z, "bySpaceId", e), s = t.transaction(Z, "readwrite");
    for (const i of r)
      await s.store.delete(i);
    await s.done;
  }
  async clearAll() {
    const t = (await this.dbPromise).transaction([Y, Z], "readwrite");
    await t.objectStore(Y).clear(), await t.objectStore(Z).clear(), await t.done;
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
class qi {
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
  async grant(e, t, r, s) {
    const i = await Jr(
      {
        issuer: this.myDid,
        audience: t,
        resource: e,
        permissions: r,
        expiration: s
      },
      this.sign
    );
    return this.granted.push(i), i;
  }
  async delegate(e, t, r, s) {
    const i = Me(e);
    if (!i) throw new Error("Invalid parent capability");
    const a = s ?? i.expiration, o = await Js(
      e,
      { audience: t, permissions: r, expiration: a },
      this.sign
    );
    return this.granted.push(o), o;
  }
  async verify(e) {
    const t = await Wr(e);
    if (!t.valid) return t;
    if (this.revoked.has(t.capability.id))
      return { valid: !1, error: `Capability ${t.capability.id} has been revoked` };
    for (const r of t.chain)
      if (this.revoked.has(r.id))
        return { valid: !1, error: `Ancestor capability ${r.id} has been revoked` };
    return t;
  }
  async canAccess(e, t, r) {
    const s = [...this.received, ...this.granted];
    for (const i of s) {
      const a = Me(i);
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
      const r = Me(t);
      return r && r.resource === e;
    }) : [...this.received];
  }
  async getGrantedCapabilities(e) {
    return e ? this.granted.filter((t) => {
      const r = Me(t);
      return r && r.resource === e;
    }) : [...this.granted];
  }
}
class Gi {
  constructor(e) {
    c(this, "getPersonalDoc");
    c(this, "changePersonalDoc");
    c(this, "onPersonalDocChange");
    this.getPersonalDoc = e.getPersonalDoc, this.changePersonalDoc = e.changePersonalDoc, this.onPersonalDocChange = e.onPersonalDocChange;
  }
  async enqueue(e) {
    await this.has(e.id) || this.changePersonalDoc((r) => {
      r.outbox[e.id] = {
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
    return Object.entries(e.outbox).map(([t, r]) => ({
      envelope: JSON.parse(r.envelopeJson),
      createdAt: r.createdAt,
      retryCount: r.retryCount
    })).sort((t, r) => t.createdAt.localeCompare(r.createdAt));
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
      const s = e.getPersonalDoc();
      return Object.keys(s.outbox).length;
    };
    let r = t();
    return {
      subscribe: (s) => e.onPersonalDocChange(() => {
        const i = t();
        i !== r && (r = i, s(r));
      }),
      getValue: () => r
    };
  }
}
class Xi {
  constructor(e) {
    c(this, "getPersonalDoc");
    c(this, "changePersonalDoc");
    this.getPersonalDoc = e.getPersonalDoc, this.changePersonalDoc = e.changePersonalDoc;
  }
  async saveSpaceMetadata(e) {
    this.changePersonalDoc((t) => {
      const r = {
        id: e.info.id,
        type: e.info.type,
        name: e.info.name ?? null,
        description: e.info.description ?? null,
        members: [...e.info.members],
        createdAt: e.info.createdAt
      };
      e.info.appTag != null && (r.appTag = e.info.appTag), t.spaces[e.info.id] = {
        info: r,
        documentId: e.documentId,
        documentUrl: e.documentUrl,
        memberEncryptionKeys: Object.fromEntries(
          Object.entries(e.memberEncryptionKeys).map(
            ([s, i]) => [s, Array.from(i)]
          )
        )
      };
    });
  }
  async loadSpaceMetadata(e) {
    const r = this.getPersonalDoc().spaces[e];
    return r ? this.deserialize(r) : null;
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
    const t = Zr(e.spaceId, e.generation);
    this.changePersonalDoc((r) => {
      r.groupKeys[t] = {
        spaceId: e.spaceId,
        generation: e.generation,
        key: Array.from(e.key)
      };
    });
  }
  async loadGroupKeys(e) {
    const t = this.getPersonalDoc();
    return Object.values(t.groupKeys).filter((r) => r.spaceId === e).map((r) => ({
      spaceId: r.spaceId,
      generation: r.generation,
      key: new Uint8Array(r.key)
    }));
  }
  async deleteGroupKeys(e) {
    this.changePersonalDoc((t) => {
      for (const [r, s] of Object.entries(t.groupKeys))
        s.spaceId === e && delete t.groupKeys[r];
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
          ([t, r]) => [t, new Uint8Array(r)]
        )
      )
    };
  }
}
function je(n) {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}
function hi(n) {
  return Object.entries(n).map(([e, t]) => `${e}=${t}`).join(" ");
}
class fi {
  constructor(e) {
    c(this, "impl");
    c(this, "lastLoad", null);
    c(this, "compactStoreSaves", { lastAt: null, lastTimeMs: 0, lastSizeBytes: 0, totalSaves: 0, errors: 0 });
    c(this, "vaultSaves", { lastAt: null, lastTimeMs: 0, lastSizeBytes: 0, totalSaves: 0, errors: 0 });
    c(this, "migration", null);
    c(this, "errors", []);
    c(this, "blockedUiSamples", []);
    // Space metrics
    c(this, "spaceMetrics", /* @__PURE__ */ new Map());
    // Legacy-specific
    c(this, "_idbChunkCount", null);
    c(this, "_healthCheckResult", null);
    c(this, "_findDurationMs", null);
    c(this, "_flushDurationMs", null);
    // Sync info (set externally)
    c(this, "_relayConnected", !1);
    c(this, "_relayUrl", null);
    c(this, "_relayPeers", 0);
    c(this, "_relayLastMessage", null);
    // Doc info (set externally)
    c(this, "_docSizeBytes", 0);
    c(this, "_docContacts", 0);
    c(this, "_docAttestations", 0);
    c(this, "_docSpaces", 0);
    this.impl = e;
  }
  logLoad(e, t, r, s = {}) {
    const i = {
      source: e,
      timeMs: t,
      sizeBytes: r,
      details: s,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.lastLoad = i;
    const a = Object.keys(s).length > 0 ? ` ${hi(s)}` : "";
    console.log(`[persistence] ✓ load impl=${this.impl} source=${e} time=${t}ms size=${je(r)}${a}`);
    const o = { "compact-store": "compact-store", indexeddb: "compact-store", vault: "vault", "wot-profiles": "profiles", migration: "compact-store", new: "personal-doc" };
    b().log({
      store: o[e] ?? "personal-doc",
      operation: "read",
      label: `load from ${e}`,
      durationMs: t,
      sizeBytes: r,
      success: !0,
      meta: { impl: this.impl, ...s }
    });
  }
  logSave(e, t, r, s) {
    const i = e === "compact-store" ? this.compactStoreSaves : this.vaultSaves;
    i.lastAt = (/* @__PURE__ */ new Date()).toISOString(), i.lastTimeMs = t, i.lastSizeBytes = r, i.totalSaves++, s !== void 0 && (this.blockedUiSamples.push(s), this.blockedUiSamples.length > 100 && this.blockedUiSamples.shift());
    const a = s !== void 0 ? ` save-blocked-ui=${s}ms` : "";
    console.log(`[persistence] ✓ save impl=${this.impl} target=${e} time=${t}ms size=${je(r)}${a}`), b().log({
      store: e,
      operation: "write",
      label: `save to ${e}`,
      durationMs: t,
      sizeBytes: r,
      success: !0,
      meta: { impl: this.impl, blockedUiMs: s }
    });
  }
  logError(e, t) {
    const r = t instanceof Error ? t.message : String(t), s = {
      operation: e,
      error: r,
      at: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (this.errors.push(s), this.errors.length > 50 && this.errors.shift(), e.startsWith("save:")) {
      const l = e.split(":")[1];
      l === "compact-store" && this.compactStoreSaves.errors++, l === "vault" && this.vaultSaves.errors++;
    }
    console.error(`[persistence] ✗ ${e} impl=${this.impl} error="${r}"`);
    const i = e.split(":"), a = i[0] === "save" ? "write" : i[0] === "load" ? "read" : "error", o = i[1] ?? "personal-doc";
    b().log({
      store: o,
      operation: a,
      label: e,
      durationMs: 0,
      success: !1,
      error: r,
      meta: { impl: this.impl }
    });
  }
  logMigration(e, t) {
    this.migration = {
      fromChunks: e,
      toSizeBytes: t,
      at: (/* @__PURE__ */ new Date()).toISOString()
    }, console.log(`[persistence] ⚡ migration impl=${this.impl} chunks=${e} → snapshot=${je(t)}`);
  }
  // --- Legacy-specific setters ---
  setIdbChunkCount(e) {
    this._idbChunkCount = e;
  }
  setHealthCheckResult(e) {
    this._healthCheckResult = e;
  }
  setFindDuration(e) {
    this._findDurationMs = e;
  }
  setFlushDuration(e) {
    this._flushDurationMs = e;
  }
  // --- Sync info setters ---
  setRelayStatus(e, t, r) {
    this._relayConnected = e, this._relayUrl = t, this._relayPeers = r, this._relayLastMessage = (/* @__PURE__ */ new Date()).toISOString();
  }
  // --- Doc info setters ---
  setDocStats(e, t, r, s) {
    this._docSizeBytes = e, this._docContacts = t, this._docAttestations = r, this._docSpaces = s;
  }
  // --- Space metrics ---
  logSpaceLoad(e, t, r, s, i, a) {
    const o = this.spaceMetrics.get(e);
    this.spaceMetrics.set(e, {
      spaceId: e,
      name: t,
      loadSource: r,
      loadTimeMs: s,
      docSizeBytes: i,
      compactStoreSaves: (o == null ? void 0 : o.compactStoreSaves) ?? 0,
      vaultSaves: (o == null ? void 0 : o.vaultSaves) ?? 0,
      lastSaveMs: (o == null ? void 0 : o.lastSaveMs) ?? null,
      members: a
    }), console.log(`[persistence] ✓ space-load id=${e.slice(0, 8)}… name="${t}" source=${r} time=${s}ms size=${je(i)} members=${a}`);
  }
  logSpaceSave(e, t, r, s) {
    const i = this.spaceMetrics.get(e);
    i && (i.docSizeBytes = s, i.lastSaveMs = r, t === "compact-store" ? i.compactStoreSaves++ : i.vaultSaves++);
  }
  removeSpace(e) {
    this.spaceMetrics.delete(e);
  }
  // --- Implementation tag ---
  setImpl(e) {
    this.impl = e;
  }
  // --- Debug API ---
  getSnapshot() {
    const e = this.blockedUiSamples, t = e.length > 0 ? Math.round(e.reduce((i, a) => i + a, 0) / e.length) : 0, r = e.length > 0 ? Math.max(...e) : 0, s = e.length > 0 ? e[e.length - 1] : 0;
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
      spaces: Array.from(this.spaceMetrics.values()).map((i) => ({ ...i })),
      sync: {
        relay: {
          connected: this._relayConnected,
          url: this._relayUrl,
          peers: this._relayPeers,
          lastMessage: this._relayLastMessage
        }
      },
      automerge: {
        saveBlockedUiMs: { last: s, avg: t, max: r },
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
let bt = null;
function Yi() {
  return bt || (bt = new fi("legacy")), bt;
}
function Zi(n) {
  if (typeof window < "u") {
    window.wotDebug = () => n.getSnapshot();
    const e = b();
    e.init(), ai(e);
  }
}
class Qi {
  constructor(e) {
    this.inner = e;
  }
  async open() {
    const e = b(), t = performance.now();
    try {
      await this.inner.open(), e.log({
        store: "compact-store",
        operation: "connect",
        label: "open IndexedDB",
        durationMs: Math.round(performance.now() - t),
        success: !0
      });
    } catch (r) {
      throw e.log({
        store: "compact-store",
        operation: "connect",
        label: "open IndexedDB",
        durationMs: Math.round(performance.now() - t),
        success: !1,
        error: r instanceof Error ? r.message : String(r)
      }), r;
    }
  }
  async save(e, t) {
    const r = b(), s = performance.now();
    try {
      await this.inner.save(e, t), r.log({
        store: "compact-store",
        operation: "write",
        label: `save ${e.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - s),
        sizeBytes: t.byteLength,
        success: !0,
        meta: { docId: e }
      });
    } catch (i) {
      throw r.log({
        store: "compact-store",
        operation: "write",
        label: `save ${e.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - s),
        sizeBytes: t.byteLength,
        success: !1,
        error: i instanceof Error ? i.message : String(i),
        meta: { docId: e }
      }), i;
    }
  }
  async load(e) {
    const t = b(), r = performance.now();
    try {
      const s = await this.inner.load(e);
      return t.log({
        store: "compact-store",
        operation: "read",
        label: `load ${e.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - r),
        sizeBytes: s == null ? void 0 : s.byteLength,
        success: !0,
        meta: { docId: e, found: s !== null }
      }), s;
    } catch (s) {
      throw t.log({
        store: "compact-store",
        operation: "read",
        label: `load ${e.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - r),
        success: !1,
        error: s instanceof Error ? s.message : String(s),
        meta: { docId: e }
      }), s;
    }
  }
  async delete(e) {
    const t = b(), r = performance.now();
    try {
      await this.inner.delete(e), t.log({
        store: "compact-store",
        operation: "delete",
        label: `delete ${e.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - r),
        success: !0,
        meta: { docId: e }
      });
    } catch (s) {
      throw t.log({
        store: "compact-store",
        operation: "delete",
        label: `delete ${e.slice(0, 12)}…`,
        durationMs: Math.round(performance.now() - r),
        success: !1,
        error: s instanceof Error ? s.message : String(s),
        meta: { docId: e }
      }), s;
    }
  }
  async list() {
    const e = b(), t = performance.now();
    try {
      const r = await this.inner.list();
      return e.log({
        store: "compact-store",
        operation: "read",
        label: "list all docs",
        durationMs: Math.round(performance.now() - t),
        success: !0,
        meta: { count: r.length }
      }), r;
    } catch (r) {
      throw e.log({
        store: "compact-store",
        operation: "read",
        label: "list all docs",
        durationMs: Math.round(performance.now() - t),
        success: !1,
        error: r instanceof Error ? r.message : String(r)
      }), r;
    }
  }
  close() {
    this.inner.close(), b().log({
      store: "compact-store",
      operation: "disconnect",
      label: "close IndexedDB",
      durationMs: 0,
      success: !0
    });
  }
}
function mt(n) {
  var e;
  return {
    id: n.id,
    v: n.v,
    type: n.type,
    fromDid: n.fromDid,
    toDid: n.toDid,
    createdAt: n.createdAt,
    encoding: n.encoding,
    ref: n.ref,
    payloadSize: (e = n.payload) == null ? void 0 : e.length
  };
}
class ea {
  constructor(e) {
    this.inner = e;
  }
  async connect(e) {
    const t = b(), r = performance.now();
    try {
      await this.inner.connect(e), t.log({
        store: "relay",
        operation: "connect",
        label: `relay connect ${e.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - r),
        success: !0,
        meta: { did: e }
      });
    } catch (s) {
      throw t.log({
        store: "relay",
        operation: "connect",
        label: `relay connect ${e.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - r),
        success: !1,
        error: s instanceof Error ? s.message : String(s),
        meta: { did: e }
      }), s;
    }
  }
  async disconnect() {
    const e = b();
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
      const r = {
        connected: "connect",
        disconnected: "disconnect",
        connecting: "connect",
        error: "error"
      };
      b().log({
        store: "relay",
        operation: r[t],
        label: `relay ${t}`,
        durationMs: 0,
        success: t !== "error",
        meta: { state: t }
      }), e(t);
    });
  }
  async send(e) {
    const t = b(), r = performance.now();
    try {
      const s = await this.inner.send(e);
      return t.log({
        store: s.reason === "queued-in-outbox" ? "outbox" : "relay",
        operation: "send",
        label: `send ${e.type} → ${e.toDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - r),
        success: !0,
        meta: {
          ...mt(e),
          status: s.status,
          reason: s.reason
        }
      }), s;
    } catch (s) {
      throw t.log({
        store: "relay",
        operation: "send",
        label: `send ${e.type} → ${e.toDid.slice(0, 24)}…`,
        durationMs: Math.round(performance.now() - r),
        success: !1,
        error: s instanceof Error ? s.message : String(s),
        meta: mt(e)
      }), s;
    }
  }
  onMessage(e) {
    return this.inner.onMessage((t) => (b().log({
      store: "relay",
      operation: "receive",
      label: `receive ${t.type} ← ${t.fromDid.slice(0, 24)}…`,
      durationMs: 0,
      success: !0,
      meta: mt(t)
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
    const e = b(), t = performance.now(), r = this.inner.getOutboxStore(), s = await r.count();
    try {
      await this.inner.flushOutbox();
      const i = await r.count();
      e.log({
        store: "outbox",
        operation: "flush",
        label: `flush outbox ${s} → ${i}`,
        durationMs: Math.round(performance.now() - t),
        success: !0,
        meta: { pendingBefore: s, pendingAfter: i, delivered: s - i }
      });
    } catch (i) {
      throw e.log({
        store: "outbox",
        operation: "flush",
        label: "flush outbox failed",
        durationMs: Math.round(performance.now() - t),
        success: !1,
        error: i instanceof Error ? i.message : String(i),
        meta: { pendingBefore: s }
      }), i;
    }
  }
  getOutboxStore() {
    return this.inner.getOutboxStore();
  }
}
export {
  Ci as AttestationDeliveryService,
  Ls as AttestationWorkflow,
  Gi as AutomergeOutboxStore,
  Xi as AutomergeSpaceMetadataStorage,
  _i as CompactStorageManager,
  Ki as EncryptedSyncService,
  Ti as GraphCacheService,
  Pi as GroupKeyService,
  Ni as HttpDiscoveryAdapter,
  Rs as IdentityWorkflow,
  qi as InMemoryAuthorizationAdapter,
  Ji as InMemoryCompactStore,
  Hi as InMemoryGraphCacheStore,
  rr as InMemoryMessagingAdapter,
  Fi as InMemoryOutboxStore,
  Ri as InMemoryPublishStateStore,
  Vi as InMemorySpaceMetadataStorage,
  Wi as IndexedDBSpaceMetadataStorage,
  Ui as LocalStorageAdapter,
  ji as OfflineFirstDiscoveryAdapter,
  Li as OutboxMessagingAdapter,
  fi as PersistenceMetrics,
  Gi as PersonalDocOutboxStore,
  Xi as PersonalDocSpaceMetadataStorage,
  _e as ProfileService,
  Oi as SeedStorageIdentityVault,
  Vs as SpacesWorkflow,
  si as TraceLog,
  Qi as TracedCompactStorageManager,
  ea as TracedOutboxMessagingAdapter,
  $i as VaultClient,
  zi as VaultPushScheduler,
  Hs as VerificationWorkflow,
  Zs as WebCryptoAdapter,
  Zn as WebCryptoProtocolCryptoAdapter,
  Bi as WebSocketMessagingAdapter,
  Mi as WotIdentity,
  Ei as application,
  mi as base64ToUint8,
  Jr as createCapability,
  cn as createDid,
  nn as createResourceRef,
  an as decodeBase58,
  I as decodeBase64Url,
  Js as delegateCapability,
  we as didToPublicKeyBytes,
  sn as encodeBase58,
  C as encodeBase64Url,
  Me as extractCapability,
  Fe as extractJwsPayload,
  Si as getDefaultDisplayName,
  Yi as getMetrics,
  b as getTraceLog,
  wi as isValidDid,
  gi as parseResourceRef,
  xi as ports,
  ki as protocol,
  vi as protocolAdapters,
  Zi as registerDebugApi,
  ai as registerTraceApi,
  Ai as signEnvelope,
  ln as signJws,
  bi as skipFirst,
  k as toBuffer,
  ii as traceAsync,
  Ii as tracedFetch,
  Wr as verifyCapability,
  Di as verifyEnvelope,
  wt as verifyJws
};
