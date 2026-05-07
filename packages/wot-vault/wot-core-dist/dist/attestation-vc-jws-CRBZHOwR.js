import { s as g, g as p } from "./index-D3HkpEuJ.js";
import { d as a, e as i, p as S, a as E, b } from "./did-key-CMSqoIj7.js";
function m(e) {
  if (e.length % 2 !== 0) throw new Error("Invalid hex string");
  const n = new Uint8Array(e.length / 2);
  for (let t = 0; t < n.length; t++) n[t] = Number.parseInt(e.slice(t * 2, t * 2 + 2), 16);
  return n;
}
function D(e) {
  return Array.from(e, (n) => n.toString(16).padStart(2, "0")).join("");
}
function l(e) {
  if (e === null) return "null";
  if (typeof e == "boolean") return e ? "true" : "false";
  if (typeof e == "number") {
    if (!Number.isFinite(e)) throw new Error("JCS does not support non-finite numbers");
    return JSON.stringify(Object.is(e, -0) ? 0 : e);
  }
  return typeof e == "string" ? JSON.stringify(e) : Array.isArray(e) ? `[${e.map((t) => l(t)).join(",")}]` : `{${Object.keys(e).sort().map((t) => `${JSON.stringify(t)}:${l(e[t])}`).join(",")}}`;
}
function u(e) {
  return new TextEncoder().encode(l(e));
}
function x(e) {
  const n = e.split(".");
  if (n.length !== 3) throw new Error("Invalid JWS compact serialization");
  const [t, r, c] = n;
  return {
    header: JSON.parse(new TextDecoder().decode(a(t))),
    payload: JSON.parse(new TextDecoder().decode(a(r))),
    signingInput: new TextEncoder().encode(`${t}.${r}`),
    signature: a(c)
  };
}
async function I(e, n, t) {
  if (t.length !== 32) throw new Error("Expected Ed25519 signing seed");
  return f(e, n, (r) => g(r, t));
}
async function f(e, n, t) {
  if (e.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  const r = i(u(e)), c = i(u(n)), s = new TextEncoder().encode(`${r}.${c}`), y = await t(s);
  return `${r}.${c}.${i(y)}`;
}
async function J(e, n) {
  const t = x(e);
  if (t.header.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  if (!await n.crypto.verifyEd25519(t.signingInput, t.signature, n.publicKey)) throw new Error("Invalid JWS signature");
  return t;
}
const K = "wot/identity/ed25519/v1", P = "wot/encryption/x25519/v1";
async function O(e, n) {
  const t = m(e), r = await n.hkdfSha256(t, K, 32), c = new Uint8Array(await p(r)), s = await n.hkdfSha256(t, P, 32), y = await n.x25519PublicFromSeed(s), w = S(c);
  return { ed25519Seed: r, ed25519PublicKey: c, x25519Seed: s, x25519PublicKey: y, did: w, kid: `${w}#sig-0` };
}
const h = "wot/ecies/v1", o = 12;
async function k(e) {
  const n = await e.crypto.x25519PublicFromSeed(e.ephemeralPrivateSeed), t = await e.crypto.x25519SharedSecret(e.ephemeralPrivateSeed, e.recipientPublicKey), r = await e.crypto.hkdfSha256(t, h, 32);
  return { ephemeralPublicKey: n, sharedSecret: t, aesKey: r };
}
async function W(e) {
  d(e.nonce, o, "ECIES nonce");
  const n = await k(e), t = await e.crypto.aes256GcmEncrypt(n.aesKey, e.nonce, e.plaintext);
  return {
    epk: i(n.ephemeralPublicKey),
    nonce: i(e.nonce),
    ciphertext: i(t)
  };
}
async function j(e) {
  const n = a(e.message.epk), t = a(e.message.nonce), r = a(e.message.ciphertext);
  d(t, o, "ECIES nonce");
  const c = await e.crypto.x25519SharedSecret(e.recipientPrivateSeed, n), s = await e.crypto.hkdfSha256(c, h, 32);
  return e.crypto.aes256GcmDecrypt(s, t, r);
}
async function N(e, n, t) {
  if (!n) throw new Error("Missing deviceId");
  if (!Number.isInteger(t) || t < 0) throw new Error("Invalid seq");
  return (await e.sha256(new TextEncoder().encode(`${n}|${t}`))).slice(0, o);
}
async function C(e) {
  d(e.spaceContentKey, 32, "Space content key");
  const n = await N(e.crypto, e.deviceId, e.seq), t = await e.crypto.aes256GcmEncrypt(e.spaceContentKey, n, e.plaintext), r = T(n, t);
  return { nonce: n, ciphertextTag: t, blob: r, blobBase64Url: i(r) };
}
async function U(e) {
  if (d(e.spaceContentKey, 32, "Space content key"), e.blob.length <= o) throw new Error("Invalid encrypted log payload blob");
  const n = e.blob.slice(0, o), t = e.blob.slice(o);
  return e.crypto.aes256GcmDecrypt(e.spaceContentKey, n, t);
}
function T(e, n) {
  const t = new Uint8Array(e.length + n.length);
  return t.set(e), t.set(n, e.length), t;
}
function d(e, n, t) {
  if (e.length !== n) throw new Error(`${t} must be ${n} bytes`);
}
async function B(e) {
  return I(
    { alg: "EdDSA", kid: e.kid, typ: "vc+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function F(e) {
  return f(
    { alg: "EdDSA", kid: e.kid, typ: "vc+jwt" },
    e.payload,
    e.sign
  );
}
async function H(e, n) {
  const t = await J(e, {
    publicKey: E(A(e)),
    crypto: n.crypto
  }), r = t.payload, c = t.header;
  if (c.typ !== "vc+jwt") throw new Error("Invalid attestation JWS typ");
  if (r.issuer !== r.iss) throw new Error("Attestation issuer and iss differ");
  if (r.iss !== b(c.kid ?? "")) throw new Error("Attestation iss does not match kid DID");
  if (!r.type.includes("WotAttestation")) throw new Error("Missing WotAttestation type");
  if (r.credentialSubject.id !== r.sub) throw new Error("Attestation subject mismatch");
  return r;
}
function A(e) {
  const n = e.split(".")[0];
  if (!n) throw new Error("Invalid JWS");
  const t = JSON.parse(new TextDecoder().decode(a(n)));
  if (!t.kid) throw new Error("Missing JWS kid");
  return t.kid;
}
export {
  f as a,
  u as b,
  I as c,
  x as d,
  D as e,
  l as f,
  B as g,
  m as h,
  F as i,
  j,
  U as k,
  k as l,
  N as m,
  O as n,
  W as o,
  C as p,
  H as q,
  J as v
};
