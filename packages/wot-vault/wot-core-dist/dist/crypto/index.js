import { f as y, b as d, t as o } from "../jws-8PD3qxx2.js";
import { c as B, d as m, j as w, e as D, k as $, a as x, h as C, g as E, i as K, s as J, v as h } from "../jws-8PD3qxx2.js";
import { c as T, d as U, e as V, v as j } from "../capabilities-BBiuFuYA.js";
function i(a) {
  return `${a.v}|${a.id}|${a.type}|${a.fromDid}|${a.toDid}|${a.createdAt}|${a.payload}`;
}
async function p(a, t) {
  const s = i(a);
  return a.signature = await t(s), a;
}
async function u(a, t, s) {
  const r = y(s), e = await crypto.subtle.importKey(
    "raw",
    r,
    { name: "Ed25519" },
    !0,
    ["verify"]
  ), c = new TextEncoder().encode(a), n = d(t);
  return crypto.subtle.verify(
    "Ed25519",
    e,
    o(n),
    c
  );
}
async function b(a, t = u) {
  try {
    if (!a.signature) return !1;
    const s = i(a);
    return await t(s, a.signature, a.fromDid);
  } catch {
    return !1;
  }
}
export {
  i as canonicalSigningInput,
  T as createCapability,
  B as createDid,
  m as decodeBase58,
  w as decodeBase64,
  d as decodeBase64Url,
  U as delegateCapability,
  y as didToPublicKeyBytes,
  D as encodeBase58,
  $ as encodeBase64,
  x as encodeBase64Url,
  V as extractCapability,
  C as extractJwsPayload,
  E as getDefaultDisplayName,
  K as isValidDid,
  p as signEnvelope,
  J as signJws,
  o as toBuffer,
  j as verifyCapability,
  b as verifyEnvelope,
  h as verifyJws
};
