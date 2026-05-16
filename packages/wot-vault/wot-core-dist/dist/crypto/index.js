import { f as y, b as d, t as o } from "../capabilities-BZPrEd2A.js";
import { j as B, c as m, d as w, n as D, l as $, e as x, o as C, a as E, m as K, h as J, g as h, i as P, s as T, k as U, v as V } from "../capabilities-BZPrEd2A.js";
function i(a) {
  return `${a.v}|${a.id}|${a.type}|${a.fromDid}|${a.toDid}|${a.createdAt}|${a.payload}`;
}
async function l(a, t) {
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
  B as createCapability,
  m as createDid,
  w as decodeBase58,
  D as decodeBase64,
  d as decodeBase64Url,
  $ as delegateCapability,
  y as didToPublicKeyBytes,
  x as encodeBase58,
  C as encodeBase64,
  E as encodeBase64Url,
  K as extractCapability,
  J as extractJwsPayload,
  h as getDefaultDisplayName,
  P as isValidDid,
  l as signEnvelope,
  T as signJws,
  o as toBuffer,
  U as verifyCapability,
  b as verifyEnvelope,
  V as verifyJws
};
