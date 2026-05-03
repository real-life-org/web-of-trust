import { b as u, a as d, c as b, p as E, e as g, d as m, f as A, g as P, h as x, r as M, i as T, x as N } from "./did-key-CMSqoIj7.js";
import { c as y, a as f, d as c, v as o, h, b as K, e as C, f as j, g as q, i as L, j as O, k as U, l as W, m as F, n as H, o as _, p as $, q as z } from "./attestation-vc-jws-CRBZHOwR.js";
import { g as G } from "./index-D3HkpEuJ.js";
async function V(e) {
  if (e.payload.iss !== u(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return v(e.payload), y(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function R(e) {
  if (e.payload.iss !== u(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return v(e.payload), f(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.sign
  );
}
async function D(e, i) {
  const { header: r, payload: t } = c(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid DeviceKeyBinding alg");
  if (r.typ !== "wot-device-key-binding+jwt") throw new Error("Invalid DeviceKeyBinding typ");
  if (!r.kid) throw new Error("Missing DeviceKeyBinding kid");
  if (t.type !== "device-key-binding") throw new Error("Invalid DeviceKeyBinding type");
  if (t.iss !== u(r.kid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return await o(e, {
    publicKey: d(r.kid),
    crypto: i.crypto
  }), v(t), t;
}
function v(e) {
  if (e.sub !== e.deviceKid) throw new Error("DeviceKeyBinding sub/deviceKid mismatch");
  const i = d(e.deviceKid);
  if (e.devicePublicKeyMultibase !== b(i))
    throw new Error("DeviceKeyBinding public key mismatch");
}
async function Q(e, i, r) {
  if (!i) throw new Error("Missing spaceId");
  const t = h(e), n = `wot/space-admin/${i}/v1`, a = await r.hkdfSha256(t, n, 32), s = new Uint8Array(await G(a));
  return { hkdfInfo: n, ed25519Seed: a, ed25519PublicKey: s, did: E(s) };
}
async function X(e) {
  return y(
    { alg: "EdDSA", kid: e.payload.authorKid },
    e.payload,
    e.signingSeed
  );
}
async function Y(e, i) {
  const { header: r, payload: t } = c(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid log entry alg");
  if (!r.kid) throw new Error("Missing log entry kid");
  if (t.authorKid !== r.kid) throw new Error("Log entry authorKid mismatch");
  return await o(e, {
    publicKey: d(t.authorKid),
    crypto: i.crypto
  }), Z(t), t;
}
function Z(e) {
  if (!Number.isInteger(e.seq) || e.seq < 0) throw new Error("Invalid log entry seq");
  if (!e.deviceId) throw new Error("Missing log entry deviceId");
  if (!e.docId) throw new Error("Missing log entry docId");
  if (!e.authorKid) throw new Error("Missing log entry authorKid");
  if (!Number.isInteger(e.keyGeneration) || e.keyGeneration < 0)
    throw new Error("Invalid log entry keyGeneration");
  if (!e.data) throw new Error("Missing log entry data");
  if (Number.isNaN(Date.parse(e.timestamp))) throw new Error("Invalid log entry timestamp");
}
const p = "wot/personal-doc/v1";
async function ee(e, i) {
  const r = h(e), t = await i.hkdfSha256(r, p, 32);
  return { hkdfInfo: p, key: t, docId: S(t) };
}
function S(e) {
  if (e.length < 16) throw new Error("Personal Doc key must be at least 16 bytes");
  const i = e.slice(0, 16);
  return [
    l(i.slice(0, 4)),
    l(i.slice(4, 6)),
    l(i.slice(6, 8)),
    l(i.slice(8, 10)),
    l(i.slice(10, 16))
  ].join("-");
}
function l(e) {
  return Array.from(e, (i) => i.toString(16).padStart(2, "0")).join("");
}
async function ie(e) {
  return y(
    { alg: "EdDSA", kid: J(e.payload), typ: "wot-capability+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function te(e, i) {
  const { header: r, payload: t } = c(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid capability alg");
  if (r.typ !== "wot-capability+jwt") throw new Error("Invalid capability typ");
  if (r.kid !== J(t)) throw new Error("Capability kid mismatch");
  return await o(e, {
    publicKey: i.publicKey,
    crypto: i.crypto
  }), re(t, i), t;
}
function J(e) {
  return `wot:space:${e.spaceId}#cap-${e.generation}`;
}
function re(e, i) {
  if (e.type !== "capability") throw new Error("Invalid capability type");
  if (!e.spaceId) throw new Error("Missing capability spaceId");
  if (!e.audience) throw new Error("Missing capability audience");
  if (!Array.isArray(e.permissions) || e.permissions.length === 0)
    throw new Error("Missing capability permissions");
  if (!Number.isInteger(e.generation) || e.generation < 0) throw new Error("Invalid capability generation");
  if (Number.isNaN(Date.parse(e.issuedAt))) throw new Error("Invalid capability issuedAt");
  if (Number.isNaN(Date.parse(e.validUntil))) throw new Error("Invalid capability validUntil");
  if (i.expectedSpaceId !== void 0 && e.spaceId !== i.expectedSpaceId)
    throw new Error("Capability spaceId mismatch");
  if (i.expectedAudience !== void 0 && e.audience !== i.expectedAudience)
    throw new Error("Capability audience mismatch");
  if (i.expectedGeneration !== void 0 && e.generation !== i.expectedGeneration)
    throw new Error("Capability generation mismatch");
  if (i.now && i.now.getTime() >= Date.parse(e.validUntil)) throw new Error("Capability expired");
}
async function ae(e) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await y(
      { alg: "EdDSA", kid: e.deviceKid, typ: "vc+jwt" },
      e.attestationPayload,
      e.deviceSigningSeed
    ),
    deviceKeyBindingJws: e.deviceKeyBindingJws
  };
}
async function ne(e) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await f(
      { alg: "EdDSA", kid: e.deviceKid, typ: "vc+jwt" },
      e.attestationPayload,
      e.sign
    ),
    deviceKeyBindingJws: e.deviceKeyBindingJws
  };
}
async function se(e, i) {
  if (e.type !== "wot-delegated-attestation-bundle/v1") throw new Error("Invalid delegated attestation bundle type");
  const r = i.requiredCapability ?? "sign-attestation", t = await D(e.deviceKeyBindingJws, { crypto: i.crypto }), { header: n, payload: a } = c(e.attestationJws);
  if (n.alg !== "EdDSA") throw new Error("Invalid attestation alg");
  if (n.kid !== t.deviceKid) throw new Error("Attestation kid does not match deviceKid");
  if (await o(e.attestationJws, {
    publicKey: d(t.deviceKid),
    crypto: i.crypto
  }), a.issuer !== t.iss || a.iss !== t.iss)
    throw new Error("Delegated attestation issuer mismatch");
  if (!t.capabilities.includes(r)) throw new Error("Missing required device capability");
  if (typeof a.iat != "number") throw new Error("Delegated attestation requires iat");
  const s = Date.parse(t.validFrom) / 1e3, w = Date.parse(t.validUntil) / 1e3;
  if (!(s <= a.iat && a.iat <= w))
    throw new Error("Attestation iat outside delegation window");
  return { attestationPayload: a, bindingPayload: t };
}
function I(e) {
  return g(K(e));
}
async function k(e, i) {
  return g(await i.sha256(new TextEncoder().encode(e)));
}
function de(e, i) {
  return `${e}~${i.map(I).join("~")}~`;
}
async function ce(e, i) {
  const r = e.split("~");
  if (r.length < 2 || r[r.length - 1] !== "") throw new Error("Invalid SD-JWT compact serialization");
  const t = r[0], n = r.slice(1, -1), a = c(t);
  if (!a.header.kid) throw new Error("Missing SD-JWT issuer kid");
  const s = await o(t, {
    publicKey: d(a.header.kid),
    crypto: i.crypto
  }), w = await Promise.all(
    n.map((B) => k(B, i.crypto))
  );
  return le(s.payload, w), {
    issuerPayload: s.payload,
    disclosures: n.map(oe),
    disclosureDigests: w
  };
}
function oe(e) {
  return JSON.parse(new TextDecoder().decode(m(e)));
}
function le(e, i) {
  const r = JSON.stringify(e);
  for (const t of i)
    if (!r.includes(`"${t}"`)) throw new Error("SD-JWT disclosure digest not present");
}
const ge = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  bytesToHex: C,
  canonicalize: j,
  canonicalizeToBytes: K,
  createAttestationVcJws: q,
  createAttestationVcJwsWithSigner: L,
  createDelegatedAttestationBundle: ae,
  createDelegatedAttestationBundleWithSigner: ne,
  createDeviceKeyBindingJws: V,
  createDeviceKeyBindingJwsWithSigner: R,
  createJcsEd25519Jws: y,
  createJcsEd25519JwsWithSigner: f,
  createLogEntryJws: X,
  createSdJwtVcCompact: de,
  createSpaceCapabilityJws: ie,
  decodeBase58: A,
  decodeBase64Url: m,
  decodeJws: c,
  decryptEcies: O,
  decryptLogPayload: U,
  deriveEciesMaterial: W,
  deriveLogPayloadNonce: F,
  derivePersonalDocFromSeedHex: ee,
  deriveProtocolIdentityFromSeedHex: H,
  deriveSpaceAdminKeyFromSeedHex: Q,
  didKeyToPublicKeyBytes: d,
  didOrKidToDid: u,
  digestSdJwtDisclosure: k,
  ed25519MultibaseToPublicKeyBytes: P,
  ed25519PublicKeyToMultibase: b,
  encodeBase58: x,
  encodeBase64Url: g,
  encodeSdJwtDisclosure: I,
  encryptEcies: _,
  encryptLogPayload: $,
  hexToBytes: h,
  personalDocIdFromKey: S,
  publicKeyToDidKey: E,
  resolveDidKey: M,
  verifyAttestationVcJws: z,
  verifyDelegatedAttestationBundle: se,
  verifyDeviceKeyBindingJws: D,
  verifyJwsWithPublicKey: o,
  verifyLogEntryJws: Y,
  verifySdJwtVc: ce,
  verifySpaceCapabilityJws: te,
  x25519MultibaseToPublicKeyBytes: T,
  x25519PublicKeyToMultibase: N
}, Symbol.toStringTag, { value: "Module" }));
export {
  R as a,
  X as b,
  V as c,
  Q as d,
  Y as e,
  ee as f,
  ie as g,
  te as h,
  ge as i,
  ae as j,
  ne as k,
  se as l,
  I as m,
  k as n,
  de as o,
  S as p,
  ce as q,
  D as v
};
