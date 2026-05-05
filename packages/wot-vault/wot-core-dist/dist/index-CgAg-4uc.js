import { b as f, a as d, c as I, p as S, e as g, d as J, f as U, g as _, h as C, r as L, i as O, x as q } from "./did-key-CMSqoIj7.js";
import { c as w, a as m, d as o, v as c, h as p, b as k, e as G, f as W, g as F, i as z, j as H, k as V, l as R, m as Y, n as X, o as Q, p as Z, q as ee } from "./attestation-vc-jws-CRBZHOwR.js";
import { g as ie } from "./index-D3HkpEuJ.js";
async function te(e) {
  if (e.payload.iss !== f(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return h(e.payload), w(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function re(e) {
  if (e.payload.iss !== f(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return h(e.payload), m(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.sign
  );
}
async function A(e, i) {
  const { header: r, payload: t } = o(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid DeviceKeyBinding alg");
  if (r.typ !== "wot-device-key-binding+jwt") throw new Error("Invalid DeviceKeyBinding typ");
  if (!r.kid) throw new Error("Missing DeviceKeyBinding kid");
  if (t.type !== "device-key-binding") throw new Error("Invalid DeviceKeyBinding type");
  if (t.iss !== f(r.kid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return await c(e, {
    publicKey: d(r.kid),
    crypto: i.crypto
  }), h(t), t;
}
function h(e) {
  if (e.sub !== e.deviceKid) throw new Error("DeviceKeyBinding sub/deviceKid mismatch");
  const i = d(e.deviceKid);
  if (e.devicePublicKeyMultibase !== I(i))
    throw new Error("DeviceKeyBinding public key mismatch");
}
async function ae(e, i, r) {
  if (!i) throw new Error("Missing spaceId");
  const t = p(e), n = `wot/space-admin/${i}/v1`, a = await r.hkdfSha256(t, n, 32), s = new Uint8Array(await ie(a));
  return { hkdfInfo: n, ed25519Seed: a, ed25519PublicKey: s, did: S(s) };
}
async function ne(e) {
  return w(
    { alg: "EdDSA", kid: e.payload.authorKid },
    e.payload,
    e.signingSeed
  );
}
async function se(e, i) {
  const { header: r, payload: t } = o(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid log entry alg");
  if (!r.kid) throw new Error("Missing log entry kid");
  if (t.authorKid !== r.kid) throw new Error("Log entry authorKid mismatch");
  return await c(e, {
    publicKey: d(t.authorKid),
    crypto: i.crypto
  }), de(t), t;
}
function de(e) {
  if (!Number.isInteger(e.seq) || e.seq < 0) throw new Error("Invalid log entry seq");
  if (!e.deviceId) throw new Error("Missing log entry deviceId");
  if (!e.docId) throw new Error("Missing log entry docId");
  if (!e.authorKid) throw new Error("Missing log entry authorKid");
  if (!Number.isInteger(e.keyGeneration) || e.keyGeneration < 0)
    throw new Error("Invalid log entry keyGeneration");
  if (!e.data) throw new Error("Missing log entry data");
  if (Number.isNaN(Date.parse(e.timestamp))) throw new Error("Invalid log entry timestamp");
}
const b = "application/didcomm-plain+json", v = "https://web-of-trust.de/protocols/member-update/1.0";
function oe(e) {
  const i = {
    id: e.id,
    typ: b,
    type: v,
    from: e.from,
    to: e.to,
    created_time: e.createdTime,
    body: e.body
  };
  return e.thid !== void 0 && (i.thid = e.thid), e.pthid !== void 0 && (i.pthid = e.pthid), E(i), i;
}
function ce(e) {
  return E(e), e;
}
function E(e) {
  const i = B(e, "member-update message");
  if (u(i.id, "member-update id"), i.typ !== b) throw new Error("Invalid member-update typ");
  if (i.type !== v) throw new Error("Invalid member-update type");
  D(i.from, "member-update from"), we(i.to, "member-update to"), M(i.created_time, "member-update created_time"), i.thid !== void 0 && u(i.thid, "member-update thid"), i.pthid !== void 0 && u(i.pthid, "member-update pthid"), P(i.body);
}
function P(e) {
  const i = B(e, "member-update body");
  if (ye(i, ["spaceId", "action", "memberDid", "effectiveKeyGeneration", "reason"], "member-update body"), u(i.spaceId, "member-update body spaceId"), i.action !== "added" && i.action !== "removed") throw new Error("Invalid member-update body action");
  if (D(i.memberDid, "member-update body memberDid"), M(i.effectiveKeyGeneration, "member-update body effectiveKeyGeneration"), i.reason !== void 0 && typeof i.reason != "string")
    throw new Error("Invalid member-update body reason");
}
function B(e, i) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${i}`);
  return e;
}
function ye(e, i, r) {
  const t = new Set(i);
  for (const n of Object.keys(e))
    if (!t.has(n)) throw new Error(`Invalid ${r} property: ${n}`);
}
function u(e, i) {
  if (typeof e != "string") throw new Error(`Invalid ${i}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e))
    throw new Error(`Invalid ${i}`);
}
function D(e, i) {
  if (typeof e != "string" || !/^did:[a-z0-9]+:.+/.test(e)) throw new Error(`Invalid ${i}`);
}
function we(e, i) {
  if (!Array.isArray(e) || e.length === 0) throw new Error(`Invalid ${i}`);
  for (const r of e) D(r, i);
}
function M(e, i) {
  if (!Number.isInteger(e) || e < 0) throw new Error(`Invalid ${i}`);
}
const K = "wot/personal-doc/v1";
async function le(e, i) {
  const r = p(e), t = await i.hkdfSha256(r, K, 32);
  return { hkdfInfo: K, key: t, docId: T(t) };
}
function T(e) {
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
async function ue(e) {
  return w(
    { alg: "EdDSA", kid: N(e.payload), typ: "wot-capability+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function fe(e, i) {
  const { header: r, payload: t } = o(e);
  if (r.alg !== "EdDSA") throw new Error("Invalid capability alg");
  if (r.typ !== "wot-capability+jwt") throw new Error("Invalid capability typ");
  if (r.kid !== N(t)) throw new Error("Capability kid mismatch");
  return await c(e, {
    publicKey: i.publicKey,
    crypto: i.crypto
  }), ge(t, i), t;
}
function N(e) {
  return `wot:space:${e.spaceId}#cap-${e.generation}`;
}
function ge(e, i) {
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
async function me(e) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await w(
      { alg: "EdDSA", kid: e.deviceKid, typ: "vc+jwt" },
      e.attestationPayload,
      e.deviceSigningSeed
    ),
    deviceKeyBindingJws: e.deviceKeyBindingJws
  };
}
async function pe(e) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await m(
      { alg: "EdDSA", kid: e.deviceKid, typ: "vc+jwt" },
      e.attestationPayload,
      e.sign
    ),
    deviceKeyBindingJws: e.deviceKeyBindingJws
  };
}
async function he(e, i) {
  if (e.type !== "wot-delegated-attestation-bundle/v1") throw new Error("Invalid delegated attestation bundle type");
  const r = i.requiredCapability ?? "sign-attestation", t = await A(e.deviceKeyBindingJws, { crypto: i.crypto }), { header: n, payload: a } = o(e.attestationJws);
  if (n.alg !== "EdDSA") throw new Error("Invalid attestation alg");
  if (n.kid !== t.deviceKid) throw new Error("Attestation kid does not match deviceKid");
  if (await c(e.attestationJws, {
    publicKey: d(t.deviceKid),
    crypto: i.crypto
  }), a.issuer !== t.iss || a.iss !== t.iss)
    throw new Error("Delegated attestation issuer mismatch");
  if (!t.capabilities.includes(r)) throw new Error("Missing required device capability");
  if (typeof a.iat != "number") throw new Error("Delegated attestation requires iat");
  const s = Date.parse(t.validFrom) / 1e3, l = Date.parse(t.validUntil) / 1e3;
  if (!(s <= a.iat && a.iat <= l))
    throw new Error("Attestation iat outside delegation window");
  return { attestationPayload: a, bindingPayload: t };
}
function x(e) {
  return g(k(e));
}
async function $(e, i) {
  return g(await i.sha256(new TextEncoder().encode(e)));
}
function be(e, i) {
  return `${e}~${i.map(x).join("~")}~`;
}
async function ve(e, i) {
  const r = e.split("~");
  if (r.length < 2 || r[r.length - 1] !== "") throw new Error("Invalid SD-JWT compact serialization");
  const t = r[0], n = r.slice(1, -1), a = o(t);
  if (!a.header.kid) throw new Error("Missing SD-JWT issuer kid");
  const s = await c(t, {
    publicKey: d(a.header.kid),
    crypto: i.crypto
  }), l = await Promise.all(
    n.map((j) => $(j, i.crypto))
  );
  return De(s.payload, l), {
    issuerPayload: s.payload,
    disclosures: n.map(Ee),
    disclosureDigests: l
  };
}
function Ee(e) {
  return JSON.parse(new TextDecoder().decode(J(e)));
}
function De(e, i) {
  const r = JSON.stringify(e);
  for (const t of i)
    if (!r.includes(`"${t}"`)) throw new Error("SD-JWT disclosure digest not present");
}
const Je = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  DIDCOMM_PLAINTEXT_TYP: b,
  MEMBER_UPDATE_MESSAGE_TYPE: v,
  assertMemberUpdateBody: P,
  assertMemberUpdateMessage: E,
  bytesToHex: G,
  canonicalize: W,
  canonicalizeToBytes: k,
  createAttestationVcJws: F,
  createAttestationVcJwsWithSigner: z,
  createDelegatedAttestationBundle: me,
  createDelegatedAttestationBundleWithSigner: pe,
  createDeviceKeyBindingJws: te,
  createDeviceKeyBindingJwsWithSigner: re,
  createJcsEd25519Jws: w,
  createJcsEd25519JwsWithSigner: m,
  createLogEntryJws: ne,
  createMemberUpdateMessage: oe,
  createSdJwtVcCompact: be,
  createSpaceCapabilityJws: ue,
  decodeBase58: U,
  decodeBase64Url: J,
  decodeJws: o,
  decryptEcies: H,
  decryptLogPayload: V,
  deriveEciesMaterial: R,
  deriveLogPayloadNonce: Y,
  derivePersonalDocFromSeedHex: le,
  deriveProtocolIdentityFromSeedHex: X,
  deriveSpaceAdminKeyFromSeedHex: ae,
  didKeyToPublicKeyBytes: d,
  didOrKidToDid: f,
  digestSdJwtDisclosure: $,
  ed25519MultibaseToPublicKeyBytes: _,
  ed25519PublicKeyToMultibase: I,
  encodeBase58: C,
  encodeBase64Url: g,
  encodeSdJwtDisclosure: x,
  encryptEcies: Q,
  encryptLogPayload: Z,
  hexToBytes: p,
  parseMemberUpdateMessage: ce,
  personalDocIdFromKey: T,
  publicKeyToDidKey: S,
  resolveDidKey: L,
  verifyAttestationVcJws: ee,
  verifyDelegatedAttestationBundle: he,
  verifyDeviceKeyBindingJws: A,
  verifyJwsWithPublicKey: c,
  verifyLogEntryJws: se,
  verifySdJwtVc: ve,
  verifySpaceCapabilityJws: fe,
  x25519MultibaseToPublicKeyBytes: O,
  x25519PublicKeyToMultibase: q
}, Symbol.toStringTag, { value: "Module" }));
export {
  b as D,
  v as M,
  re as a,
  ne as b,
  te as c,
  ae as d,
  se as e,
  oe as f,
  E as g,
  P as h,
  Je as i,
  le as j,
  T as k,
  ue as l,
  fe as m,
  me as n,
  pe as o,
  ce as p,
  he as q,
  x as r,
  $ as s,
  be as t,
  ve as u,
  A as v
};
