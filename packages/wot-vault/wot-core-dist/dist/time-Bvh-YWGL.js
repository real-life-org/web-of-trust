import { d as I, e as S, a as F, b as W } from "./broker-error-B2k9KKx_.js";
import { s as $ } from "./encryption-CQ_TXPVX.js";
function N(e) {
  if (e === null) return "null";
  if (typeof e == "boolean") return e ? "true" : "false";
  if (typeof e == "number") {
    if (!Number.isFinite(e)) throw new Error("JCS does not support non-finite numbers");
    return JSON.stringify(Object.is(e, -0) ? 0 : e);
  }
  return typeof e == "string" ? JSON.stringify(e) : Array.isArray(e) ? `[${e.map((t) => N(t)).join(",")}]` : `{${Object.keys(e).sort().map((t) => `${JSON.stringify(t)}:${N(e[t])}`).join(",")}}`;
}
function j(e) {
  return new TextEncoder().encode(N(e));
}
function J(e) {
  const n = e.split(".");
  if (n.length !== 3) throw new Error("Invalid JWS compact serialization");
  const [t, r, i] = n;
  if (!t || !r || !i) throw new Error("Invalid JWS compact serialization");
  return {
    header: JSON.parse(new TextDecoder().decode(I(t))),
    payload: JSON.parse(new TextDecoder().decode(I(r))),
    signingInput: new TextEncoder().encode(`${t}.${r}`),
    signature: I(i)
  };
}
async function Q(e, n, t) {
  if (t.length !== 32) throw new Error("Expected Ed25519 signing seed");
  return M(e, n, (r) => $(r, t));
}
async function M(e, n, t) {
  if (e.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  U(e.kid);
  const r = S(j(e)), i = S(j(n)), o = new TextEncoder().encode(`${r}.${i}`), s = await t(o);
  return `${r}.${i}.${S(s)}`;
}
async function ge(e, n) {
  const t = J(e);
  if (V(t.header), t.header.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  if (U(t.header.kid), !await n.crypto.verifyEd25519(t.signingInput, t.signature, n.publicKey)) throw new Error("Invalid JWS signature");
  return t;
}
function V(e) {
  if (!e || typeof e != "object" || Array.isArray(e)) throw new Error("Invalid JWS header");
}
function U(e) {
  if (typeof e != "string" || e.length === 0) throw new Error("Missing JWS kid");
}
const L = "https://www.w3.org/ns/credentials/v2", H = "https://web-of-trust.de/vocab/v1", P = "VerifiableCredential", z = "WotAttestation", B = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})([Zz]|([+-])(\d{2}):(\d{2}))$/;
async function Ee(e) {
  return Q(
    { alg: "EdDSA", kid: e.kid, typ: "vc+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function Te(e) {
  return M(
    { alg: "EdDSA", kid: e.kid, typ: "vc+jwt" },
    e.payload,
    e.sign
  );
}
async function be(e, n) {
  const t = J(e);
  if (p(t.header, "Invalid JWS header"), t.header.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  K(t.header.kid);
  const r = t.header.kid;
  if (!await n.crypto.verifyEd25519(
    t.signingInput,
    t.signature,
    F(r)
  )) throw new Error("Invalid JWS signature");
  const o = t.payload;
  if (t.header.typ !== "vc+jwt") throw new Error("Invalid attestation JWS typ");
  return Z(o, r, { now: n.now }), o;
}
function Z(e, n, t = {}) {
  p(e, "Invalid attestation payload");
  const r = t.now ?? /* @__PURE__ */ new Date(), i = t.requireIssuerKidBinding ?? !0;
  if (D(e["@context"], "Invalid attestation @context"), !e["@context"].includes(L)) throw new Error("Missing VC context");
  if (!e["@context"].includes(H)) throw new Error("Missing WoT context");
  if (D(e.type, "Invalid attestation type"), !e.type.includes(P)) throw new Error("Missing VerifiableCredential type");
  if (!e.type.includes(z)) throw new Error("Missing WotAttestation type");
  if (typeof e.issuer != "string" || e.issuer.length === 0)
    throw new Error("Missing attestation issuer");
  if (typeof e.iss != "string" || e.iss.length === 0) throw new Error("Missing attestation iss");
  if (e.issuer !== e.iss) throw new Error("Attestation issuer and iss differ");
  if (i && e.iss !== W(n))
    throw new Error("Attestation iss does not match kid DID");
  if (p(e.credentialSubject, "Invalid attestation credentialSubject"), typeof e.credentialSubject.id != "string" || e.credentialSubject.id.length === 0)
    throw new Error("Missing credentialSubject id");
  if (typeof e.credentialSubject.claim != "string" || e.credentialSubject.claim.length === 0)
    throw new Error("Missing credentialSubject claim");
  if (typeof e.sub != "string" || e.sub.length === 0) throw new Error("Missing attestation sub");
  if (e.credentialSubject.id !== e.sub) throw new Error("Attestation subject mismatch");
  if (typeof e.validFrom != "string" || e.validFrom.length === 0)
    throw new Error("Missing attestation validFrom");
  const o = _(e.validFrom, "Invalid attestation validFrom"), s = y(e.nbf, "Invalid attestation nbf");
  if (o !== s) throw new Error("Attestation validFrom and nbf differ");
  if (e.validUntil !== void 0) {
    if (typeof e.validUntil != "string" || e.validUntil.length === 0)
      throw new Error("Invalid attestation validUntil");
    const d = _(e.validUntil, "Invalid attestation validUntil");
    if (e.exp === void 0) throw new Error("Attestation validUntil requires exp");
    const f = y(e.exp, "Invalid attestation exp");
    if (d !== f) throw new Error("Attestation validUntil and exp differ");
  } else if (e.exp !== void 0)
    throw new Error("Attestation exp requires validUntil");
  const a = Math.floor(r.getTime() / 1e3);
  if (!Number.isFinite(a)) throw new Error("Invalid attestation verification time");
  if (s > a) throw new Error("Attestation not yet valid");
  if (e.exp !== void 0 && y(e.exp, "Invalid attestation exp") <= a)
    throw new Error("Attestation expired");
}
function K(e) {
  if (typeof e != "string" || e.length === 0) throw new Error("Missing JWS kid");
}
function p(e, n) {
  if (typeof e != "object" || e === null || Array.isArray(e)) throw new Error(n);
}
function D(e, n) {
  if (!Array.isArray(e) || !e.every((t) => typeof t == "string")) throw new Error(n);
}
function y(e, n) {
  if (typeof e != "number" || !Number.isInteger(e) || e < 0) throw new Error(n);
  return e;
}
function _(e, n) {
  const t = B.exec(e);
  if (!t) throw new Error(n);
  const [, r, i, o, s, a, d, f, v, g, E] = t, l = Number(r), u = Number(i), w = Number(o), T = Number(s), b = Number(a), m = Number(d), c = g === void 0 ? 0 : Number(g), x = E === void 0 ? 0 : Number(E);
  if (T > 23 || b > 59 || m > 59 || c > 23 || x > 59)
    throw new Error(n);
  const C = Date.UTC(l, u - 1, w, T, b, m), h = new Date(C);
  if (h.getUTCFullYear() !== l || h.getUTCMonth() !== u - 1 || h.getUTCDate() !== w || h.getUTCHours() !== T || h.getUTCMinutes() !== b || h.getUTCSeconds() !== m)
    throw new Error(n);
  const O = f.toUpperCase() === "Z" ? 0 : (v === "+" ? 1 : -1) * (c * 60 + x), R = C - O * 6e4;
  if (!Number.isFinite(R)) throw new Error(n);
  return R / 1e3;
}
const q = /* @__PURE__ */ new Set(["did", "name", "enc", "nonce", "ts", "broker"]), G = /^did:[a-z0-9]+:.+/, Y = /^[A-Za-z0-9_-]+$/, X = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, ee = /^urn:uuid:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, te = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, ne = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/, re = /* @__PURE__ */ new Set(["ws:", "wss:", "http:", "https:"]), ie = 300 * 1e3, oe = "in-person verifiziert";
function me(e) {
  let n;
  try {
    n = JSON.parse(e);
  } catch {
    throw new Error("Invalid QR challenge JSON");
  }
  if (!ae(n) || Array.isArray(n)) throw new Error("Invalid QR challenge object");
  for (const i of Object.keys(n))
    if (!q.has(i)) throw new Error(`Invalid QR challenge field: ${i}`);
  const t = n;
  if (A(t, "did"), A(t, "name"), A(t, "enc"), A(t, "nonce"), A(t, "ts"), t.broker !== void 0 && typeof t.broker != "string")
    throw new Error("Invalid QR challenge broker");
  if (!G.test(t.did)) throw new Error("Invalid QR challenge did");
  if (t.name.length < 1) throw new Error("Invalid QR challenge name");
  if (!Y.test(t.enc)) throw new Error("Invalid QR challenge enc");
  if (I(t.enc).byteLength !== 32) throw new Error("Invalid QR challenge enc length");
  if (!X.test(t.nonce)) throw new Error("Invalid QR challenge nonce");
  if (!k(t.ts)) throw new Error("Invalid QR challenge ts");
  t.broker !== void 0 && fe(t.broker);
  const r = {
    did: t.did,
    name: t.name,
    enc: t.enc,
    nonce: t.nonce,
    ts: t.ts
  };
  return t.broker !== void 0 && (r.broker = t.broker), r;
}
function se(e, n) {
  if (!k(e.ts)) return !1;
  const t = Date.parse(e.ts);
  if (!Number.isFinite(t)) return !1;
  const r = n.now.getTime() - t, i = n.maxAgeMs ?? ie;
  return r >= 0 && r <= i;
}
function Ae(e) {
  var r, i;
  if (e.payload.sub !== e.localDid || ((r = e.payload.credentialSubject) == null ? void 0 : r.id) !== e.localDid)
    return { decision: "reject", reason: "wrong-subject" };
  if (!de(e.payload))
    return { decision: "reject", reason: "not-verification-attestation" };
  if (!e.payload.jti) return { decision: "remote-unbound", reason: "missing-jti-nonce" };
  const n = ce(e.payload.jti);
  if (n === null)
    return { decision: "remote-unbound", reason: "no-active-matching-nonce" };
  if (ue(e.consumedNonces, n))
    return { decision: "reject", reason: "nonce-consumed" };
  const t = (i = e.activeChallenge) == null ? void 0 : i.nonce.toLowerCase();
  return !e.activeChallenge || !t || t !== n ? { decision: "remote-unbound", reason: "no-active-matching-nonce" } : se(e.activeChallenge, { now: e.now }) ? { decision: "accept-in-person", nonce: t } : { decision: "reject", reason: "challenge-expired" };
}
function ce(e) {
  const n = ee.exec(e);
  return n === null ? null : n[1].toLowerCase();
}
function A(e, n) {
  if (e[n] === void 0) throw new Error(`Missing QR challenge field: ${n}`);
  if (typeof e[n] != "string") throw new Error(`Invalid QR challenge field: ${n}`);
}
function ae(e) {
  return typeof e == "object" && e !== null;
}
function k(e) {
  const n = ne.exec(e);
  if (!n || !te.test(e) || !Number.isFinite(Date.parse(e))) return !1;
  const [, t, r, i, o, s, a, d, f] = n, v = Number(t), g = Number(r), E = Number(i), l = Number(o), u = Number(s), w = Number(a), T = d === void 0 ? 0 : Number(d), b = f === void 0 ? 0 : Number(f);
  if (l > 23 || u > 59 || w > 59 || T > 23 || b > 59) return !1;
  const m = Date.UTC(v, g - 1, E, l, u, w), c = new Date(m);
  return c.getUTCFullYear() === v && c.getUTCMonth() === g - 1 && c.getUTCDate() === E && c.getUTCHours() === l && c.getUTCMinutes() === u && c.getUTCSeconds() === w;
}
function de(e) {
  return e.type.includes("VerifiableCredential") && e.type.includes("WotAttestation") && e.credentialSubject.claim === oe;
}
function fe(e) {
  if (e.trim() !== e || /\s/.test(e)) throw new Error("Invalid QR challenge broker");
  let n;
  try {
    n = new URL(e);
  } catch {
    throw new Error("Invalid QR challenge broker");
  }
  if (!re.has(n.protocol)) throw new Error("Invalid QR challenge broker");
  if (n.username || n.password) throw new Error("Invalid QR challenge broker");
  if (!le(n.hostname)) throw new Error("Invalid QR challenge broker");
  if (n.port && !/^\d+$/.test(n.port)) throw new Error("Invalid QR challenge broker");
}
function le(e) {
  return e.length === 0 ? !1 : e === "localhost" || e.startsWith("[") && e.endsWith("]") ? !0 : /^\d+(?:\.\d+){3}$/.test(e) ? e.split(".").every((n) => Number(n) >= 0 && Number(n) <= 255) : e.split(".").every((n) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(n));
}
function ue(e, n) {
  for (const t of e)
    if (t.toLowerCase() === n) return !0;
  return !1;
}
function ve(e) {
  return new Date(Math.floor(e.getTime() / 1e3) * 1e3).toISOString().replace(".000Z", "Z");
}
export {
  ce as a,
  Q as b,
  Te as c,
  Ae as d,
  M as e,
  J as f,
  ge as g,
  j as h,
  Z as i,
  N as j,
  Ee as k,
  se as l,
  me as p,
  be as v,
  ve as w
};
