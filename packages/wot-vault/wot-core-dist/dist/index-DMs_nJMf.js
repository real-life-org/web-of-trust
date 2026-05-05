import { b as u, a as o, c as b, p as m, e as g, d as E, f as B, g as P, h as M, r as x, i as T, x as N } from "./did-key-CMSqoIj7.js";
import { c as l, a as f, d, v as c, h as v, b as K, e as U, f as C, g as j, i as G, j as L, k as q, l as O, m as W, n as F, o as H, p as _, q as $ } from "./attestation-vc-jws-CRBZHOwR.js";
import { g as z } from "./index-D3HkpEuJ.js";
async function V(e) {
  if (e.payload.iss !== u(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return h(e.payload), l(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function R(e) {
  if (e.payload.iss !== u(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return h(e.payload), f(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.sign
  );
}
async function D(e, i) {
  const { header: r, payload: t } = d(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid DeviceKeyBinding alg");
  if (r.typ !== "wot-device-key-binding+jwt") throw new Error("Invalid DeviceKeyBinding typ");
  if (!r.kid) throw new Error("Missing DeviceKeyBinding kid");
  if (t.type !== "device-key-binding") throw new Error("Invalid DeviceKeyBinding type");
  if (t.iss !== u(r.kid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return await c(e, {
    publicKey: o(r.kid),
    crypto: i.crypto
  }), h(t), t;
}
function h(e) {
  if (e.sub !== e.deviceKid) throw new Error("DeviceKeyBinding sub/deviceKid mismatch");
  const i = o(e.deviceKid);
  if (e.devicePublicKeyMultibase !== b(i))
    throw new Error("DeviceKeyBinding public key mismatch");
}
async function Q(e, i, r) {
  if (!i) throw new Error("Missing spaceId");
  const t = v(e), n = `wot/space-admin/${i}/v1`, a = await r.hkdfSha256(t, n, 32), s = new Uint8Array(await z(a));
  return { hkdfInfo: n, ed25519Seed: a, ed25519PublicKey: s, did: m(s) };
}
async function X(e) {
  return l(
    { alg: "EdDSA", kid: e.payload.authorKid },
    e.payload,
    e.signingSeed
  );
}
async function Y(e, i) {
  const { header: r, payload: t } = d(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid log entry alg");
  if (!r.kid) throw new Error("Missing log entry kid");
  if (t.authorKid !== r.kid) throw new Error("Log entry authorKid mismatch");
  return await c(e, {
    publicKey: o(t.authorKid),
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
function ee(e) {
  const i = e.incomingUpdate;
  if (i.effectiveKeyGeneration < e.localKeyGeneration) return "ignore-stale";
  if (i.effectiveKeyGeneration > e.localKeyGeneration + 1) return "buffer-future-and-catch-up";
  const r = te(i, e), t = e.seenUpdates.find((n) => ie(n, i));
  if (t) {
    const n = re(t.storedDisposition);
    return r > n ? "upgrade-pending-and-sync" : r < n ? "ignore-lower-authority" : "ignore-duplicate";
  }
  return r > 0 ? "store-pending-and-sync" : "store-unverified-pending-and-sync";
}
function ie(e, i) {
  return e.spaceId === i.spaceId && e.action === i.action && e.memberDid === i.memberDid && e.effectiveKeyGeneration === i.effectiveKeyGeneration;
}
function te(e, i) {
  return i.knownAdminDids.includes(e.signerDid) || e.action === "added" && i.knownMemberDids.includes(e.signerDid) ? 1 : 0;
}
function re(e) {
  return e === "store-pending-and-sync" ? 1 : 0;
}
const p = "wot/personal-doc/v1";
async function ne(e, i) {
  const r = v(e), t = await i.hkdfSha256(r, p, 32);
  return { hkdfInfo: p, key: t, docId: S(t) };
}
function S(e) {
  if (e.length < 16) throw new Error("Personal Doc key must be at least 16 bytes");
  const i = e.slice(0, 16);
  return [
    y(i.slice(0, 4)),
    y(i.slice(4, 6)),
    y(i.slice(6, 8)),
    y(i.slice(8, 10)),
    y(i.slice(10, 16))
  ].join("-");
}
function y(e) {
  return Array.from(e, (i) => i.toString(16).padStart(2, "0")).join("");
}
async function ae(e) {
  return l(
    { alg: "EdDSA", kid: I(e.payload), typ: "wot-capability+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function se(e, i) {
  const { header: r, payload: t } = d(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid capability alg");
  if (r.typ !== "wot-capability+jwt") throw new Error("Invalid capability typ");
  if (r.kid !== I(t)) throw new Error("Capability kid mismatch");
  return await c(e, {
    publicKey: i.publicKey,
    crypto: i.crypto
  }), oe(t, i), t;
}
function I(e) {
  return `wot:space:${e.spaceId}#cap-${e.generation}`;
}
function oe(e, i) {
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
async function de(e) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await l(
      { alg: "EdDSA", kid: e.deviceKid, typ: "vc+jwt" },
      e.attestationPayload,
      e.deviceSigningSeed
    ),
    deviceKeyBindingJws: e.deviceKeyBindingJws
  };
}
async function ce(e) {
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
async function ye(e, i) {
  if (e.type !== "wot-delegated-attestation-bundle/v1") throw new Error("Invalid delegated attestation bundle type");
  const r = i.requiredCapability ?? "sign-attestation", t = await D(e.deviceKeyBindingJws, { crypto: i.crypto }), { header: n, payload: a } = d(e.attestationJws);
  if (n.alg !== "EdDSA") throw new Error("Invalid attestation alg");
  if (n.kid !== t.deviceKid) throw new Error("Attestation kid does not match deviceKid");
  if (await c(e.attestationJws, {
    publicKey: o(t.deviceKid),
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
function J(e) {
  return g(K(e));
}
async function k(e, i) {
  return g(await i.sha256(new TextEncoder().encode(e)));
}
function le(e, i) {
  return `${e}~${i.map(J).join("~")}~`;
}
async function we(e, i) {
  const r = e.split("~");
  if (r.length < 2 || r[r.length - 1] !== "") throw new Error("Invalid SD-JWT compact serialization");
  const t = r[0], n = r.slice(1, -1), a = d(t);
  if (!a.header.kid) throw new Error("Missing SD-JWT issuer kid");
  const s = await c(t, {
    publicKey: o(a.header.kid),
    crypto: i.crypto
  }), w = await Promise.all(
    n.map((A) => k(A, i.crypto))
  );
  return ge(s.payload, w), {
    issuerPayload: s.payload,
    disclosures: n.map(ue),
    disclosureDigests: w
  };
}
function ue(e) {
  return JSON.parse(new TextDecoder().decode(E(e)));
}
function ge(e, i) {
  const r = JSON.stringify(e);
  for (const t of i)
    if (!r.includes(`"${t}"`)) throw new Error("SD-JWT disclosure digest not present");
}
const pe = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  bytesToHex: U,
  canonicalize: C,
  canonicalizeToBytes: K,
  createAttestationVcJws: j,
  createAttestationVcJwsWithSigner: G,
  createDelegatedAttestationBundle: de,
  createDelegatedAttestationBundleWithSigner: ce,
  createDeviceKeyBindingJws: V,
  createDeviceKeyBindingJwsWithSigner: R,
  createJcsEd25519Jws: l,
  createJcsEd25519JwsWithSigner: f,
  createLogEntryJws: X,
  createSdJwtVcCompact: le,
  createSpaceCapabilityJws: ae,
  decodeBase58: B,
  decodeBase64Url: E,
  decodeJws: d,
  decryptEcies: L,
  decryptLogPayload: q,
  deriveEciesMaterial: O,
  deriveLogPayloadNonce: W,
  derivePersonalDocFromSeedHex: ne,
  deriveProtocolIdentityFromSeedHex: F,
  deriveSpaceAdminKeyFromSeedHex: Q,
  didKeyToPublicKeyBytes: o,
  didOrKidToDid: u,
  digestSdJwtDisclosure: k,
  ed25519MultibaseToPublicKeyBytes: P,
  ed25519PublicKeyToMultibase: b,
  encodeBase58: M,
  encodeBase64Url: g,
  encodeSdJwtDisclosure: J,
  encryptEcies: H,
  encryptLogPayload: _,
  evaluateMemberUpdateDisposition: ee,
  hexToBytes: v,
  personalDocIdFromKey: S,
  publicKeyToDidKey: m,
  resolveDidKey: x,
  verifyAttestationVcJws: $,
  verifyDelegatedAttestationBundle: ye,
  verifyDeviceKeyBindingJws: D,
  verifyJwsWithPublicKey: c,
  verifyLogEntryJws: Y,
  verifySdJwtVc: we,
  verifySpaceCapabilityJws: se,
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
  ne as g,
  ae as h,
  pe as i,
  se as j,
  de as k,
  ce as l,
  ye as m,
  J as n,
  k as o,
  S as p,
  le as q,
  we as r,
  D as v
};
