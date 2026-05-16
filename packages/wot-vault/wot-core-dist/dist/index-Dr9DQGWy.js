import { b as m, a as $, f as kr, p as Dr, e as G, d as ee, g as Ar, c as Tr, B as ht, K as vt, h as mt, i as bt, j as Et, k as It, l as kt, m as Dt, r as At, n as Tt, x as St } from "./broker-error-B2k9KKx_.js";
import { g as Ct, h as Sr, b as Rt, a as _t, c as Nt, f as Kt, i as Bt, j as $t, k as Mt, d as Ot, e as Pt, l as Lt } from "./encryption-CQ_TXPVX.js";
import { b as H, e as he, f as R, g as M, h as ve, i as Cr, j as xt, k as Ut, c as Ft, d as Jt, l as jt, p as Vt, a as Gt, v as Ht, w as qt } from "./time-Bvh-YWGL.js";
const y = "application/didcomm-plain+json", me = "https://web-of-trust.de/protocols/space-invite/1.0", be = "https://web-of-trust.de/protocols/member-update/1.0", Ee = "https://web-of-trust.de/protocols/key-rotation/1.0";
function O(e) {
  const r = {
    id: e.id,
    typ: y,
    type: e.type,
    from: e.from,
    created_time: e.createdTime,
    body: e.body
  };
  return e.to !== void 0 && (r.to = e.to), e.thid !== void 0 && (r.thid = e.thid), e.pthid !== void 0 && (r.pthid = e.pthid), b(r), r;
}
function Yt(e) {
  return b(e), e;
}
function b(e) {
  const r = w(e, "plaintext message");
  if (f(r.id, "plaintext message id"), r.typ !== y) throw new Error("Invalid plaintext message typ");
  ri(r.type, "plaintext message type"), P(r.from, "plaintext message from"), r.to !== void 0 && q(r.to, "plaintext message to"), E(r.created_time, "plaintext message created_time"), r.thid !== void 0 && f(r.thid, "plaintext message thid"), r.pthid !== void 0 && f(r.pthid, "plaintext message pthid"), w(r.body, "plaintext message body");
}
function zt(e) {
  const r = {
    id: e.id,
    typ: y,
    type: me,
    from: e.from,
    to: e.to,
    created_time: e.createdTime,
    body: e.body
  };
  return e.thid !== void 0 && (r.thid = e.thid), e.pthid !== void 0 && (r.pthid = e.pthid), Ie(r), r;
}
function Wt(e) {
  const r = {
    id: e.id,
    typ: y,
    type: be,
    from: e.from,
    to: e.to,
    created_time: e.createdTime,
    body: e.body
  };
  return e.thid !== void 0 && (r.thid = e.thid), e.pthid !== void 0 && (r.pthid = e.pthid), ke(r), r;
}
function Zt(e) {
  const r = {
    id: e.id,
    typ: y,
    type: Ee,
    from: e.from,
    to: e.to,
    created_time: e.createdTime,
    body: e.body
  };
  return e.thid !== void 0 && (r.thid = e.thid), e.pthid !== void 0 && (r.pthid = e.pthid), De(r), r;
}
function Qt(e) {
  return Ie(e), e;
}
function Xt(e) {
  return ke(e), e;
}
function ei(e) {
  return De(e), e;
}
function Ie(e) {
  const r = w(e, "space-invite message");
  if (r.typ !== y) throw new Error("Invalid space-invite typ");
  if (r.type !== me) throw new Error("Invalid space-invite type");
  f(r.id, "space-invite id"), P(r.from, "space-invite from"), q(r.to, "space-invite to"), E(r.created_time, "space-invite created_time"), r.thid !== void 0 && f(r.thid, "space-invite thid"), r.pthid !== void 0 && f(r.pthid, "space-invite pthid"), Rr(r.body);
}
function ke(e) {
  const r = w(e, "member-update message");
  if (r.typ !== y) throw new Error("Invalid member-update typ");
  if (r.type !== be) throw new Error("Invalid member-update type");
  f(r.id, "member-update id"), P(r.from, "member-update from"), q(r.to, "member-update to"), E(r.created_time, "member-update created_time"), r.thid !== void 0 && f(r.thid, "member-update thid"), r.pthid !== void 0 && f(r.pthid, "member-update pthid"), _r(r.body);
}
function De(e) {
  const r = w(e, "key-rotation message");
  if (r.typ !== y) throw new Error("Invalid key-rotation typ");
  if (r.type !== Ee) throw new Error("Invalid key-rotation type");
  f(r.id, "key-rotation id"), P(r.from, "key-rotation from"), q(r.to, "key-rotation to"), E(r.created_time, "key-rotation created_time"), r.thid !== void 0 && f(r.thid, "key-rotation thid"), r.pthid !== void 0 && f(r.pthid, "key-rotation pthid"), Nr(r.body);
}
function Rr(e) {
  const r = w(e, "space-invite body");
  re(
    r,
    [
      "spaceId",
      "brokerUrls",
      "currentKeyGeneration",
      "spaceContentKeys",
      "spaceCapabilitySigningKey",
      "adminDids",
      "capability"
    ],
    "space-invite body"
  ), f(r.spaceId, "space-invite body spaceId"), ti(r.brokerUrls, "space-invite body brokerUrls"), E(r.currentKeyGeneration, "space-invite body currentKeyGeneration"), ii(r.spaceContentKeys, "space-invite body spaceContentKeys");
  const t = Math.max(
    ...r.spaceContentKeys.map((i) => i.generation)
  );
  if (r.currentKeyGeneration !== t)
    throw new Error("Invalid space-invite body currentKeyGeneration");
  V(r.spaceCapabilitySigningKey, "space-invite body spaceCapabilitySigningKey"), q(r.adminDids, "space-invite body adminDids", { allowEmpty: !0 }), Kr(r.capability, "space-invite body capability");
}
function _r(e) {
  const r = w(e, "member-update body");
  if (re(r, ["spaceId", "action", "memberDid", "effectiveKeyGeneration", "reason"], "member-update body"), f(r.spaceId, "member-update body spaceId"), r.action !== "added" && r.action !== "removed") throw new Error("Invalid member-update body action");
  if (P(r.memberDid, "member-update body memberDid"), E(r.effectiveKeyGeneration, "member-update body effectiveKeyGeneration"), r.reason !== void 0 && typeof r.reason != "string")
    throw new Error("Invalid member-update body reason");
}
function Nr(e) {
  const r = w(e, "key-rotation body");
  re(
    r,
    ["spaceId", "generation", "spaceContentKey", "spaceCapabilitySigningKey", "capability"],
    "key-rotation body"
  ), f(r.spaceId, "key-rotation body spaceId"), E(r.generation, "key-rotation body generation"), V(r.spaceContentKey, "key-rotation body spaceContentKey"), V(r.spaceCapabilitySigningKey, "key-rotation body spaceCapabilitySigningKey"), Kr(r.capability, "key-rotation body capability");
}
function w(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function re(e, r, t) {
  const i = new Set(r);
  for (const n of Object.keys(e))
    if (!i.has(n)) throw new Error(`Invalid ${t} property: ${n}`);
}
function f(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e))
    throw new Error(`Invalid ${r}`);
}
function P(e, r) {
  if (typeof e != "string" || !/^did:[a-z0-9]+:.+/.test(e)) throw new Error(`Invalid ${r}`);
}
function q(e, r, t = {}) {
  if (!Array.isArray(e) || !t.allowEmpty && e.length === 0) throw new Error(`Invalid ${r}`);
  for (const i of e) P(i, r);
}
function E(e, r) {
  if (!Number.isInteger(e) || e < 0) throw new Error(`Invalid ${r}`);
}
function ri(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  try {
    new URL(e);
  } catch {
    throw new Error(`Invalid ${r}`);
  }
}
function ti(e, r) {
  if (!Array.isArray(e) || e.length === 0) throw new Error(`Invalid ${r}`);
  for (const t of e) {
    if (typeof t != "string") throw new Error(`Invalid ${r}`);
    try {
      new URL(t);
    } catch {
      throw new Error(`Invalid ${r}`);
    }
  }
}
function ii(e, r) {
  if (!Array.isArray(e) || e.length === 0) throw new Error(`Invalid ${r}`);
  for (const t of e) {
    const i = w(t, r);
    re(i, ["generation", "key"], r), E(i.generation, `${r} generation`), V(i.key, `${r} key`);
  }
}
function V(e, r) {
  if (typeof e != "string" || !/^[A-Za-z0-9_-]+$/.test(e)) throw new Error(`Invalid ${r}`);
}
function Kr(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  const t = e.split(".");
  if (t.length !== 3) throw new Error(`Invalid ${r}`);
  for (const i of t) V(i, r);
}
const Ae = "https://web-of-trust.de/protocols/trust-list-delta/1.0", ni = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(~[A-Za-z0-9_-]*)+~?$/;
function oi(e) {
  const r = O({
    id: e.id,
    type: Ae,
    from: e.from,
    to: e.to,
    createdTime: e.createdTime,
    thid: e.thid,
    pthid: e.pthid,
    body: { delta: e.delta }
  });
  return Te(r), r;
}
function si(e) {
  return Te(e), e;
}
function Te(e) {
  if (b(e), e.typ !== y) throw new Error("Invalid trust-list-delta typ");
  if (e.type !== Ae) throw new Error("Invalid trust-list-delta type");
  fi(e.to, "trust-list-delta to"), e.thid !== void 0 && rr(e.thid, "trust-list-delta thid"), e.pthid !== void 0 && rr(e.pthid, "trust-list-delta pthid"), Br(e.body);
}
function Br(e) {
  const r = ai(e, "trust-list-delta body");
  di(r, ["delta"], "trust-list-delta body"), li(r.delta, "trust-list-delta body delta");
}
function ai(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function di(e, r, t) {
  const i = new Set(r);
  for (const n of Object.keys(e))
    if (!i.has(n)) throw new Error(`Invalid ${t} property: ${n}`);
}
function rr(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e))
    throw new Error(`Invalid ${r}`);
}
function ci(e, r) {
  if (typeof e != "string" || !/^did:[a-z0-9]+:.+/.test(e)) throw new Error(`Invalid ${r}`);
}
function fi(e, r) {
  if (!Array.isArray(e) || e.length === 0) throw new Error(`Invalid ${r}`);
  for (const t of e) ci(t, r);
}
function li(e, r) {
  if (typeof e != "string" || !ni.test(e))
    throw new Error(`Invalid ${r}`);
}
const yi = /* @__PURE__ */ new Set([
  "sign-log-entry",
  "sign-verification",
  "sign-attestation",
  "broker-auth",
  "device-admin"
]), ui = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
async function pi(e) {
  if (e.payload.iss !== m(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return Se(e.payload), H(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function wi(e) {
  if (e.payload.iss !== m(e.issuerKid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return Se(e.payload), he(
    { alg: "EdDSA", kid: e.issuerKid, typ: "wot-device-key-binding+jwt" },
    e.payload,
    e.sign
  );
}
async function $r(e, r) {
  const { header: t, payload: i } = R(e);
  if (Mr(t, "Invalid DeviceKeyBinding header"), t.alg !== "EdDSA") throw new Error("Invalid DeviceKeyBinding alg");
  if (t.typ !== "wot-device-key-binding+jwt") throw new Error("Invalid DeviceKeyBinding typ");
  if (typeof t.kid != "string" || t.kid.length === 0) throw new Error("Missing DeviceKeyBinding kid");
  if (await M(e, {
    publicKey: $(t.kid),
    crypto: r.crypto
  }), Se(i), i.iss !== m(t.kid)) throw new Error("DeviceKeyBinding issuer mismatch");
  return i;
}
function Se(e) {
  if (Mr(e, "Invalid DeviceKeyBinding payload"), e.type !== "device-key-binding") throw new Error("Invalid DeviceKeyBinding type");
  if (typeof e.iss != "string" || e.iss.length === 0) throw new Error("Missing DeviceKeyBinding iss");
  if (typeof e.deviceKid != "string" || e.deviceKid.length === 0)
    throw new Error("Missing DeviceKeyBinding deviceKid");
  if (typeof e.sub != "string" || e.sub.length === 0) throw new Error("Missing DeviceKeyBinding sub");
  if (typeof e.devicePublicKeyMultibase != "string" || e.devicePublicKeyMultibase.length === 0)
    throw new Error("Missing DeviceKeyBinding devicePublicKeyMultibase");
  if (e.deviceName !== void 0 && (typeof e.deviceName != "string" || e.deviceName.length === 0))
    throw new Error("Invalid DeviceKeyBinding deviceName");
  gi(e.capabilities), hi(e.iat, "Invalid DeviceKeyBinding iat");
  const r = tr(e.validFrom, "Missing DeviceKeyBinding validFrom", "Invalid DeviceKeyBinding validFrom"), t = tr(e.validUntil, "Missing DeviceKeyBinding validUntil", "Invalid DeviceKeyBinding validUntil");
  if (r > t) throw new Error("DeviceKeyBinding validity window is reversed");
  if (e.sub !== e.deviceKid) throw new Error("DeviceKeyBinding sub/deviceKid mismatch");
  const i = $(e.deviceKid);
  if (e.devicePublicKeyMultibase !== kr(i))
    throw new Error("DeviceKeyBinding public key mismatch");
}
function gi(e) {
  if (!Array.isArray(e) || e.length === 0) throw new Error("Invalid DeviceKeyBinding capabilities");
  const r = /* @__PURE__ */ new Set();
  for (const t of e) {
    if (typeof t != "string" || !yi.has(t))
      throw new Error("Unknown DeviceKeyBinding capability");
    if (r.has(t)) throw new Error("Duplicate DeviceKeyBinding capability");
    r.add(t);
  }
}
function Mr(e, r) {
  if (typeof e != "object" || e === null || Array.isArray(e)) throw new Error(r);
}
function hi(e, r) {
  if (typeof e != "number" || !Number.isInteger(e) || e < 0) throw new Error(r);
  return e;
}
function tr(e, r, t) {
  if (typeof e != "string" || e.length === 0) throw new Error(r);
  const i = ui.exec(e);
  if (!i) throw new Error(t);
  const [, n, o, s, a, c, d, l = "", g, _, I, k] = i, D = Number(n), A = Number(o), N = Number(s), T = Number(a), S = Number(c), L = Number(d), Y = vi(l), x = I === void 0 ? 0 : Number(I), U = k === void 0 ? 0 : Number(k);
  if (T > 23 || S > 59 || L > 59 || x > 23 || U > 59)
    throw new Error(t);
  const u = Date.UTC(D, A - 1, N, T, S, L), h = new Date(u);
  if (h.getUTCFullYear() !== D || h.getUTCMonth() !== A - 1 || h.getUTCDate() !== N || h.getUTCHours() !== T || h.getUTCMinutes() !== S || h.getUTCSeconds() !== L)
    throw new Error(t);
  const z = g === "Z" ? 0 : (_ === "+" ? 1 : -1) * (x * 60 + U), er = u + Y - z * 6e4;
  if (!Number.isFinite(er)) throw new Error(t);
  return er;
}
function vi(e) {
  return e.length === 0 ? 0 : +`0${e}` * 1e3;
}
const ir = 64, mi = 32, bi = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function Ei(e, r, t) {
  const i = Or(e), o = `wot/space-admin/${Ii(r)}/v1`, s = await t.hkdfSha256(i, o, mi), a = new Uint8Array(await Ct(s));
  return { hkdfInfo: o, ed25519Seed: s, ed25519PublicKey: a, did: Dr(a) };
}
function Or(e) {
  if (typeof e != "string" || !/^[0-9a-f]{128}$/i.test(e))
    throw new Error("BIP39 seed hex must be exactly 128 hex characters");
  const r = Sr(e);
  if (r.length !== ir)
    throw new Error(`BIP39 seed hex must decode to ${ir} bytes`);
  return r;
}
function Ii(e) {
  if (!bi.test(e)) throw new Error("spaceId must be a UUID v4 string");
  return e.toLowerCase();
}
const Ce = "https://web-of-trust.de/protocols/ack/1.0";
function ki(e) {
  const r = O({
    id: e.id,
    type: Ce,
    from: e.from,
    to: e.to,
    createdTime: e.createdTime,
    thid: e.thid,
    pthid: e.pthid,
    body: e.body
  });
  return Re(r), r;
}
function Di(e) {
  return Re(e), e;
}
function Re(e) {
  if (b(e), e.type !== Ce) throw new Error("Invalid ack message type");
  if (e.thid === void 0) throw new Error("Invalid ack thid");
  if (Pr(e.body), e.thid !== e.body.messageId) throw new Error("Invalid ack thid");
}
function Pr(e) {
  const r = Ai(e, "ack body");
  Ti(r.messageId, "ack body messageId");
}
function Ai(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function Ti(e, r) {
  if (typeof e != "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e))
    throw new Error(`Invalid ${r}`);
}
const Lr = 32, Si = 43, Ci = 1440 * 60 * 1e3, Ri = /^[A-Za-z0-9_-]+$/;
function _e(e) {
  if (e.byteLength !== Lr) throw new Error("Expected 32-byte broker nonce");
  return G(e);
}
function Ne(e) {
  if (e.length !== Si || !Ri.test(e))
    throw new Error("Invalid broker nonce");
  let r;
  try {
    r = ee(e);
  } catch {
    throw new Error("Invalid broker nonce");
  }
  if (r.byteLength !== Lr) throw new Error("Invalid broker nonce length");
  const t = _e(r);
  if (t !== e) throw new Error("Invalid broker nonce canonical form");
  return { canonicalNonce: t, bytes: r };
}
function _i(e) {
  const r = e.nonce.canonicalNonce, t = e.now.getTime();
  if (!Number.isFinite(t)) throw new Error("Invalid broker nonce consumption time");
  return e.consumedNonces.has(r) ? { decision: "reject", reason: "nonce-replay", canonicalNonce: r } : {
    decision: "accept",
    canonicalNonce: r,
    remember: {
      type: "remember-consumed-nonce",
      canonicalNonce: r,
      until: new Date(t + Ci)
    }
  };
}
const Ke = "wot/broker-auth/v1", K = "challenge-response";
function xr(e) {
  return Me($e(e));
}
function Be(e) {
  Ki(e);
  const r = Me(
    $e(e)
  );
  return ve(r);
}
function Ur(e) {
  const r = $e(e.pendingChallenge);
  let t;
  try {
    t = {
      type: Ni(e.candidate.type),
      did: Fr(e.candidate.did),
      deviceId: Jr(e.candidate.deviceId),
      nonce: jr(e.candidate.nonce)
    };
  } catch {
    return {
      disposition: "rejected",
      errorCode: "MALFORMED_MESSAGE"
    };
  }
  if (t.did !== r.did || t.deviceId !== r.deviceId || t.nonce !== r.nonce)
    return {
      disposition: "rejected",
      errorCode: "AUTH_INVALID"
    };
  const i = Me(t);
  return {
    disposition: "accepted",
    transcript: i,
    signingBytes: Be(i)
  };
}
function $e(e) {
  return {
    did: Fr(e.did),
    deviceId: Jr(e.deviceId),
    nonce: jr(e.nonce)
  };
}
function Me(e) {
  return {
    protocol: Ke,
    type: K,
    did: e.did,
    deviceId: e.deviceId,
    nonce: e.nonce
  };
}
function Fr(e) {
  if (typeof e != "string" || e.length === 0) throw new Error("Invalid broker auth DID");
  return e;
}
function Jr(e) {
  if (typeof e != "string" || !Bi(e))
    throw new Error("Invalid broker auth deviceId");
  return e;
}
function jr(e) {
  if (typeof e != "string") throw new Error("Invalid broker auth nonce");
  return Ne(e).canonicalNonce;
}
function Ni(e) {
  if (e !== K) throw new Error("Invalid broker auth response type");
  return K;
}
function Ki(e) {
  if (e.protocol !== Ke || e.type !== K)
    throw new Error("Invalid broker auth transcript");
}
function Bi(e) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e);
}
const te = K, Vr = 64, $i = 86, Mi = /^[A-Za-z0-9_-]+$/;
function Oi(e) {
  const r = ie({
    type: te,
    did: e.did,
    deviceId: e.deviceId,
    nonce: e.nonce,
    signature: Oe(e.signature)
  });
  return {
    type: r.type,
    did: r.did,
    deviceId: r.deviceId,
    nonce: r.nonce,
    signature: r.signature
  };
}
function ie(e) {
  const r = Ui(e, "broker challenge-response control-frame");
  Fi(r), F(r, "type"), F(r, "did"), F(r, "deviceId"), F(r, "nonce"), F(r, "signature"), Ji(r.type);
  const t = xi(r.signature), i = xr({
    did: r.did,
    deviceId: r.deviceId,
    nonce: r.nonce
  });
  return {
    type: te,
    did: i.did,
    deviceId: i.deviceId,
    nonce: i.nonce,
    signature: t.canonicalSignature,
    signatureBytes: t.bytes,
    transcript: i,
    signingBytes: Be(i)
  };
}
function Pi(e) {
  ie(e);
}
async function Li(e) {
  ji(e.publicKey), Vi(e.crypto);
  let r;
  try {
    r = ie(e.frame);
  } catch {
    return {
      disposition: "rejected",
      errorCode: "MALFORMED_MESSAGE"
    };
  }
  let t;
  try {
    t = Ur({
      pendingChallenge: e.pendingChallenge,
      candidate: {
        type: r.type,
        did: r.did,
        deviceId: r.deviceId,
        nonce: r.nonce
      }
    });
  } catch {
    return {
      disposition: "rejected",
      errorCode: "MALFORMED_MESSAGE"
    };
  }
  return t.disposition === "rejected" ? t : await e.crypto.verifyEd25519(
    t.signingBytes,
    r.signatureBytes,
    e.publicKey
  ) ? {
    disposition: "accepted",
    frame: {
      type: r.type,
      did: r.did,
      deviceId: r.deviceId,
      nonce: r.nonce,
      signature: r.signature
    },
    transcript: t.transcript,
    signingBytes: t.signingBytes
  } : {
    disposition: "rejected",
    errorCode: "AUTH_INVALID"
  };
}
function Oe(e) {
  if (e.byteLength !== Vr)
    throw new Error("Invalid broker challenge-response signature length");
  return G(e);
}
function xi(e) {
  if (typeof e != "string" || e.length !== $i || !Mi.test(e))
    throw new Error("Invalid broker challenge-response signature");
  let r;
  try {
    r = ee(e);
  } catch {
    throw new Error("Invalid broker challenge-response signature");
  }
  if (r.byteLength !== Vr)
    throw new Error("Invalid broker challenge-response signature length");
  const t = Oe(r);
  if (t !== e)
    throw new Error("Invalid broker challenge-response signature canonical form");
  return { canonicalSignature: t, bytes: r };
}
function Ui(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function Fi(e) {
  const r = /* @__PURE__ */ new Set(["type", "did", "deviceId", "nonce", "signature"]);
  for (const t of Object.keys(e))
    if (!r.has(t))
      throw new Error(`Invalid broker challenge-response control-frame property: ${t}`);
}
function F(e, r) {
  if (!Object.prototype.hasOwnProperty.call(e, r))
    throw new Error(`Invalid broker challenge-response control-frame ${r}`);
}
function Ji(e) {
  if (e !== te)
    throw new Error("Invalid broker challenge-response control-frame type");
}
function ji(e) {
  if (!(e instanceof Uint8Array) || e.byteLength !== 32)
    throw new Error("Invalid broker challenge-response public key");
}
function Vi(e) {
  if (e === null || typeof e != "object" || typeof e.verifyEd25519 != "function")
    throw new Error("Invalid broker challenge-response verifier");
}
const ne = "error/1.0";
function Gi(e) {
  return Pe({
    type: ne,
    thid: e.thid,
    body: e.body
  });
}
function Pe(e) {
  const r = qi(e, "broker error control-frame");
  Yi(r), se(r, "type"), se(r, "thid"), se(r, "body"), zi(r.type);
  const t = Wi(r), i = Ar(r.body);
  return {
    type: ne,
    thid: t,
    body: i
  };
}
function Hi(e) {
  Pe(e);
}
function qi(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function Yi(e) {
  const r = /* @__PURE__ */ new Set(["type", "thid", "body"]);
  for (const t of Object.keys(e))
    if (!r.has(t)) throw new Error(`Invalid broker error control-frame property: ${t}`);
}
function zi(e) {
  if (e !== ne) throw new Error("Invalid broker error control-frame type");
}
function se(e, r) {
  if (!Object.prototype.hasOwnProperty.call(e, r))
    throw new Error(`Invalid broker error control-frame ${r}`);
}
function Wi(e) {
  const { thid: r } = e;
  if (r === null) return null;
  if (typeof r != "string" || r.length === 0)
    throw new Error("Invalid broker error control-frame thid");
  return r;
}
function Zi(e) {
  let r = !1, t = !1, i = !1;
  for (const n of e.deviceList)
    if (n.deviceId === e.deviceId) {
      if (n.did !== e.did) {
        i = !0;
        continue;
      }
      if (n.status === "revoked") {
        r = !0;
        break;
      }
      t = !0;
    }
  return e.revocationWins === !0 || r ? nr(e, "DEVICE_REVOKED") : i ? nr(e, "DEVICE_ID_CONFLICT") : t ? {
    disposition: "registered",
    did: e.did,
    deviceId: e.deviceId,
    isNewDevice: !1,
    actions: [or(e)]
  } : {
    disposition: "registered",
    did: e.did,
    deviceId: e.deviceId,
    isNewDevice: !0,
    actions: [
      {
        type: "persist-active-device-registration",
        did: e.did,
        deviceId: e.deviceId
      },
      or(e)
    ]
  };
}
function nr(e, r) {
  return {
    disposition: "rejected",
    did: e.did,
    deviceId: e.deviceId,
    errorCode: r,
    actions: []
  };
}
function or(e) {
  return {
    type: "deliver-pending-inbox-messages",
    did: e.did,
    deviceId: e.deviceId
  };
}
const Qi = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, Xi = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function Le(e) {
  return !tn(e) || !nn(e, ["type", "did", "deviceId", "revokedAt"]) || e.type !== "device-revoke" || typeof e.did != "string" || e.did.length === 0 || typeof e.deviceId != "string" || !Qi.test(e.deviceId) || typeof e.revokedAt != "string" || !on(e.revokedAt) ? ae() : {
    valid: !0,
    payload: {
      type: e.type,
      did: e.did,
      deviceId: e.deviceId,
      revokedAt: e.revokedAt
    }
  };
}
function en(e) {
  const r = Le(e.decodedPayload);
  if (!r.valid)
    return {
      disposition: "rejected",
      errorCode: r.errorCode,
      actions: []
    };
  const t = r.payload;
  let i, n = !1;
  for (const o of e.deviceList)
    if (o.deviceId === t.deviceId) {
      if (o.did !== t.did) {
        n = !0;
        continue;
      }
      if (o.status === "revoked") {
        (i === void 0 || i.status !== "revoked") && (i = o);
        continue;
      }
      i === void 0 && (i = o);
    }
  return n ? {
    disposition: "rejected",
    did: t.did,
    deviceId: t.deviceId,
    errorCode: "DEVICE_ID_CONFLICT",
    actions: []
  } : (i == null ? void 0 : i.status) === "revoked" ? {
    disposition: "accepted-idempotent",
    did: t.did,
    deviceId: t.deviceId,
    revokedAt: i.revokedAt ?? t.revokedAt,
    actions: []
  } : (i == null ? void 0 : i.status) === "active" ? {
    disposition: "accepted",
    did: t.did,
    deviceId: t.deviceId,
    revokedAt: t.revokedAt,
    actions: [
      Gr(t),
      Hr(t)
    ]
  } : {
    disposition: "accepted-tombstone",
    did: t.did,
    deviceId: t.deviceId,
    revokedAt: t.revokedAt,
    actions: [
      {
        type: "persist-revoked-device-tombstone",
        did: t.did,
        deviceId: t.deviceId,
        revokedAt: t.revokedAt
      }
    ]
  };
}
function rn(e) {
  const { revocation: r, knownDevice: t } = e;
  return r.did !== t.did || r.deviceId !== t.deviceId ? {
    disposition: "not-for-known-device",
    did: r.did,
    deviceId: r.deviceId,
    actions: []
  } : t.status === "revoked" ? {
    disposition: "accepted-idempotent",
    did: r.did,
    deviceId: r.deviceId,
    revokedAt: t.revokedAt ?? r.revokedAt,
    actions: []
  } : {
    disposition: "accepted",
    did: r.did,
    deviceId: r.deviceId,
    revokedAt: r.revokedAt,
    actions: [
      Gr(r),
      Hr(r)
    ]
  };
}
function Gr(e) {
  return {
    type: "mark-device-revoked",
    did: e.did,
    deviceId: e.deviceId,
    revokedAt: e.revokedAt
  };
}
function Hr(e) {
  return {
    type: "delete-pending-inbox-messages",
    did: e.did,
    deviceId: e.deviceId
  };
}
function ae() {
  return {
    valid: !1,
    errorCode: "MALFORMED_MESSAGE"
  };
}
function tn(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e);
}
function nn(e, r) {
  const t = new Set(r), i = Reflect.ownKeys(e);
  if (i.length !== t.size) return !1;
  for (const n of i)
    if (typeof n != "string" || !t.has(n) || !Object.prototype.hasOwnProperty.call(e, n)) return !1;
  return r.every((n) => Object.prototype.hasOwnProperty.call(e, n));
}
function on(e) {
  const r = Xi.exec(e);
  if (r === null) return !1;
  const [, t, i, n, o, s, a, c] = r, d = Number(t), l = Number(i), g = Number(n), _ = Number(o), I = Number(s), k = Number(a);
  if (l < 1 || l > 12 || g < 1 || g > sn(d, l) || _ > 23 || I > 59 || k > 59)
    return !1;
  if (c !== "Z") {
    const D = Number(c.slice(1, 3)), A = Number(c.slice(4, 6));
    if (D > 23 || A > 59) return !1;
  }
  return !0;
}
function sn(e, r) {
  return r === 2 ? an(e) ? 29 : 28 : [4, 6, 9, 11].includes(r) ? 30 : 31;
}
function an(e) {
  return e % 4 === 0 && (e % 100 !== 0 || e % 400 === 0);
}
const W = "device-revoke";
function dn(e) {
  const r = oe({
    type: W,
    revocationJws: e.revocationJws
  });
  return {
    type: r.type,
    revocationJws: r.revocationJws
  };
}
function oe(e) {
  const r = un(e, "broker device-revoke control-frame");
  if (pn(r), sr(r, "type"), sr(r, "revocationJws"), r.type !== W)
    throw new Error("Invalid broker device-revoke control-frame type");
  if (typeof r.revocationJws != "string" || !wn(r.revocationJws))
    throw new Error("Invalid broker device-revoke revocationJws");
  const t = ln(r.revocationJws), i = Le(t.payload);
  if (!i.valid) throw new Error("Invalid broker device-revoke payload");
  return {
    type: W,
    revocationJws: r.revocationJws,
    header: t.header,
    payload: i.payload,
    signingBytes: t.signingInput,
    signatureBytes: t.signature
  };
}
function cn(e) {
  oe(e);
}
async function fn(e) {
  gn(e.publicKey), hn(e.crypto);
  let r;
  try {
    r = oe(e.frame);
  } catch {
    return {
      disposition: "rejected",
      errorCode: "MALFORMED_MESSAGE"
    };
  }
  if (!yn(r.header, r.payload.did))
    return {
      disposition: "rejected",
      errorCode: "AUTH_INVALID"
    };
  let t;
  try {
    t = await e.crypto.verifyEd25519(
      r.signingBytes,
      r.signatureBytes,
      e.publicKey
    );
  } catch {
    return {
      disposition: "rejected",
      errorCode: "AUTH_INVALID"
    };
  }
  return t ? {
    disposition: "accepted",
    frame: {
      type: r.type,
      revocationJws: r.revocationJws
    },
    header: r.header,
    payload: r.payload,
    signingBytes: r.signingBytes,
    signatureBytes: r.signatureBytes
  } : {
    disposition: "rejected",
    errorCode: "AUTH_INVALID"
  };
}
function ln(e) {
  try {
    return R(e);
  } catch {
    throw new Error("Invalid broker device-revoke revocationJws");
  }
}
function yn(e, r) {
  return e.alg !== "EdDSA" || typeof e.kid != "string" || e.kid.length === 0 || !e.kid.includes("#") ? !1 : m(e.kid) === r;
}
function un(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function pn(e) {
  const r = /* @__PURE__ */ new Set(["type", "revocationJws"]);
  for (const t of Reflect.ownKeys(e))
    if (typeof t != "string" || !r.has(t))
      throw new Error(`Invalid broker device-revoke control-frame property: ${String(t)}`);
}
function sr(e, r) {
  if (!Object.prototype.hasOwnProperty.call(e, r))
    throw new Error(`Invalid broker device-revoke control-frame ${r}`);
}
function wn(e) {
  const r = e.split(".");
  return r.length === 3 && r.every((t) => t.length > 0);
}
function gn(e) {
  if (!(e instanceof Uint8Array) || e.byteLength !== 32)
    throw new Error("Invalid broker device-revoke public key");
}
function hn(e) {
  if (e === null || typeof e != "object" || typeof e.verifyEd25519 != "function")
    throw new Error("Invalid broker device-revoke verifier");
}
function vn(e) {
  const r = [], t = [];
  let i;
  for (const n of e.recipientDevices)
    if (n.did === e.recipientDid) {
      if (n.status === "revoked") {
        t.push({
          did: n.did,
          deviceId: n.deviceId,
          reason: "device-revoked"
        });
        continue;
      }
      if (n.status === "active") {
        if (e.sender.did === e.recipientDid && n.deviceId === e.sender.deviceId) {
          i = {
            did: n.did,
            deviceId: n.deviceId,
            reason: "self-addressed-sender-excluded"
          };
          continue;
        }
        r.push({
          did: n.did,
          deviceId: n.deviceId,
          messageId: e.messageId,
          acked: !1
        });
      }
    }
  return {
    deliveryTargets: r,
    cleanupPendingEntriesFor: t,
    ...i ? { excludedSenderTarget: i } : {},
    fullyDelivered: r.length === 0
  };
}
function mn(e) {
  let r = !1;
  const t = e.entries.map((n) => n.messageId !== e.messageId || n.did !== e.authenticatedDevice.did || n.deviceId !== e.authenticatedDevice.deviceId ? { ...n } : (r = !0, {
    ...n,
    acked: !0
  })), i = t.filter((n) => n.messageId === e.messageId);
  return {
    ackApplied: r,
    entries: t,
    fullyDelivered: i.length === 0 || i.every((n) => n.acked)
  };
}
const Z = "register", Q = "challenge", X = "registered";
function bn(e) {
  return xe({
    type: Z,
    did: e.did,
    deviceId: e.deviceId
  });
}
function xe(e) {
  const r = Je(e, "broker register control-frame");
  return je(r, ["type", "did", "deviceId"], "broker register control-frame"), p(r, "type", "broker register control-frame"), p(r, "did", "broker register control-frame"), p(r, "deviceId", "broker register control-frame"), Ve(
    r.type,
    Z,
    "broker register control-frame"
  ), {
    type: Z,
    did: qr(r.did, "broker register control-frame did"),
    deviceId: Yr(r.deviceId, "broker register control-frame deviceId")
  };
}
function En(e) {
  xe(e);
}
function In(e) {
  const r = Ue({
    type: Q,
    nonce: _e(e.nonce)
  });
  return {
    type: r.type,
    nonce: r.nonce
  };
}
function Ue(e) {
  const r = Je(e, "broker challenge control-frame");
  if (je(r, ["type", "nonce"], "broker challenge control-frame"), p(r, "type", "broker challenge control-frame"), p(r, "nonce", "broker challenge control-frame"), Ve(
    r.type,
    Q,
    "broker challenge control-frame"
  ), typeof r.nonce != "string") throw new Error("Invalid broker challenge control-frame nonce");
  const t = Ne(r.nonce);
  return {
    type: Q,
    nonce: t.canonicalNonce,
    nonceBytes: t.bytes
  };
}
function kn(e) {
  Ue(e);
}
function Dn(e) {
  return Fe({
    type: X,
    did: e.did,
    deviceId: e.deviceId,
    isNewDevice: e.isNewDevice
  });
}
function Fe(e) {
  const r = Je(e, "broker registered control-frame");
  if (je(
    r,
    ["type", "did", "deviceId", "isNewDevice"],
    "broker registered control-frame"
  ), p(r, "type", "broker registered control-frame"), p(r, "did", "broker registered control-frame"), p(r, "deviceId", "broker registered control-frame"), p(r, "isNewDevice", "broker registered control-frame"), Ve(
    r.type,
    X,
    "broker registered control-frame"
  ), typeof r.isNewDevice != "boolean")
    throw new Error("Invalid broker registered control-frame isNewDevice");
  return {
    type: X,
    did: qr(r.did, "broker registered control-frame did"),
    deviceId: Yr(r.deviceId, "broker registered control-frame deviceId"),
    isNewDevice: r.isNewDevice
  };
}
function An(e) {
  Fe(e);
}
function Je(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function je(e, r, t) {
  const i = new Set(r);
  for (const n of Reflect.ownKeys(e))
    if (typeof n != "string" || !i.has(n))
      throw new Error(`Invalid ${t} property: ${String(n)}`);
}
function p(e, r, t) {
  if (!Object.prototype.hasOwnProperty.call(e, r))
    throw new Error(`Invalid ${t} ${r}`);
}
function Ve(e, r, t) {
  if (e !== r) throw new Error(`Invalid ${t} type`);
}
function qr(e, r) {
  if (typeof e != "string" || e.length === 0) throw new Error(`Invalid ${r}`);
  return e;
}
function Yr(e, r) {
  if (typeof e != "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e))
    throw new Error(`Invalid ${r}`);
  return e;
}
function Tn(e, r) {
  if (!Object.prototype.hasOwnProperty.call(e, r)) return 0;
  const t = e[r];
  if (zr(t), t === Number.MAX_SAFE_INTEGER) throw new Error("Sync head seq overflow");
  return t + 1;
}
function Sn(e) {
  return e.truncated ? "request-next-page" : "complete";
}
function Cn(e, r) {
  ar(e), ar(r);
  const t = Object.keys(e), i = Object.keys(r);
  if (t.length !== i.length) return "divergent";
  for (const n of t)
    if (!Object.prototype.hasOwnProperty.call(r, n) || e[n] !== r[n]) return "divergent";
  return "consistent";
}
function ar(e) {
  for (const r of Object.values(e)) zr(r);
}
function zr(e) {
  if (!Number.isSafeInteger(e) || e < 0) throw new Error("Invalid sync head seq");
}
const Rn = "authenticated-device-only", _n = "transport-persistence-only", Nn = "none";
function Kn(e) {
  if (e.localOutcome.kind === "processing-incomplete" || Bn(e)) return J("processing-incomplete");
  switch (e.localOutcome.kind) {
    case "applied":
      return e.localOutcome.durable ? de("applied") : J("apply-not-durable");
    case "pending":
      return e.localOutcome.durability !== "durable" || e.localOutcome.dependencies.length === 0 ? J("pending-not-durable") : de("durably-buffered-pending");
    case "invalid-rejected":
      return e.localOutcome.authoritativeStateChanged ? J("invalid-changed-state") : {
        action: "may-ack-invalid-and-drop",
        reason: "invalid-rejected",
        authoritativeStateChanged: !1,
        ...Wr()
      };
    case "duplicate":
      return de("duplicate-replay-history");
  }
}
function Bn(e) {
  return e.decryption === "incomplete" || e.innerVerification === "incomplete" || e.replayCheck === "incomplete" ? !0 : e.localOutcome.kind === "invalid-rejected" ? !1 : e.decryption === "failed" || e.innerVerification === "failed" || e.replayCheck === "failed" ? !0 : e.localOutcome.kind === "duplicate" ? e.replayCheck !== "duplicate-known" : !1;
}
function de(e) {
  return {
    action: "send-ack",
    reason: e,
    ...Wr()
  };
}
function J(e) {
  return {
    action: "do-not-ack",
    reason: e
  };
}
function Wr() {
  return {
    ackScope: Rn,
    ackMeaning: _n,
    semanticEffect: Nn
  };
}
function $n(e) {
  return dr(e.localGeneration), dr(e.incomingGeneration), e.incomingGeneration <= e.localGeneration ? "ignore-stale-or-duplicate" : e.incomingGeneration === e.localGeneration + 1 ? "apply" : "future-buffer";
}
function dr(e) {
  if (!Number.isSafeInteger(e) || e < 0)
    throw new Error("Invalid key-rotation generation");
}
const Ge = "https://web-of-trust.de/protocols/log-entry/1.0", Mn = /^[A-Za-z0-9_-]+$/;
async function On(e) {
  return qe(e.payload), H(
    { alg: "EdDSA", kid: e.payload.authorKid },
    e.payload,
    e.signingSeed
  );
}
async function Pn(e, r) {
  const { header: t, payload: i } = R(e);
  if (t.alg !== "EdDSA") throw new Error("Invalid log entry alg");
  if (!t.kid) throw new Error("Missing log entry kid");
  if (i.authorKid !== t.kid) throw new Error("Log entry authorKid mismatch");
  return await M(e, {
    publicKey: $(i.authorKid),
    crypto: r.crypto
  }), qe(i), i;
}
function Ln(e) {
  const r = O({
    id: e.id,
    type: Ge,
    from: e.from,
    to: e.to,
    createdTime: e.createdTime,
    thid: e.thid,
    pthid: e.pthid,
    body: { entry: e.entry }
  });
  return He(r), r;
}
function xn(e) {
  return He(e), e;
}
function He(e) {
  if (b(e), e.type !== Ge) throw new Error("Invalid log-entry message type");
  Jn(e.to, "log-entry message to"), Zr(e.body);
}
function Zr(e) {
  const r = Qr(e, "log-entry body");
  Xr(r, ["entry"], "log-entry body"), Yn(r.entry, "log-entry body entry");
}
function qe(e) {
  const r = Qr(e, "log entry payload");
  if (Xr(r, ["seq", "deviceId", "docId", "authorKid", "keyGeneration", "data", "timestamp"], "log entry payload"), jn(r.seq, "log entry seq"), cr(r.deviceId, "log entry deviceId"), cr(r.docId, "log entry docId"), Un(r.authorKid, "log entry authorKid"), !Number.isInteger(r.keyGeneration) || r.keyGeneration < 0)
    throw new Error("Invalid log entry keyGeneration");
  Vn(r.data, "log entry data"), Gn(r.timestamp, "log entry timestamp");
}
function Qr(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function Xr(e, r, t) {
  const i = new Set(r);
  for (const n of Object.keys(e))
    if (!i.has(n)) throw new Error(`Invalid ${t} property: ${n}`);
}
function cr(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e))
    throw new Error(`Invalid ${r}`);
}
function Un(e, r) {
  if (typeof e != "string" || !/^did:[a-z0-9]+:.+#.+/.test(e)) throw new Error(`Invalid ${r}`);
}
function Fn(e, r) {
  if (typeof e != "string" || !/^did:[a-z0-9]+:.+/.test(e)) throw new Error(`Invalid ${r}`);
}
function Jn(e, r) {
  if (!Array.isArray(e) || e.length === 0) throw new Error(`Invalid ${r}`);
  for (const t of e) Fn(t, r);
}
function jn(e, r) {
  if (!Number.isInteger(e) || e < 0) throw new Error(`Invalid ${r}`);
}
function Vn(e, r) {
  if (typeof e != "string" || !et(e)) throw new Error(`Invalid ${r}`);
}
function Gn(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  const t = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(e);
  if (!t || Number.isNaN(Date.parse(e))) throw new Error(`Invalid ${r}`);
  const [, i, n, o, s, a, c, , d, l] = t;
  if (!Hn(
    Number.parseInt(i, 10),
    Number.parseInt(n, 10),
    Number.parseInt(o, 10),
    Number.parseInt(s, 10),
    Number.parseInt(a, 10),
    Number.parseInt(c, 10),
    d === void 0 ? void 0 : Number.parseInt(d, 10),
    l === void 0 ? void 0 : Number.parseInt(l, 10)
  ))
    throw new Error(`Invalid ${r}`);
}
function Hn(e, r, t, i, n, o, s, a) {
  return !(r < 1 || r > 12 || t < 1 || t > qn(e, r) || i < 0 || i > 23 || n < 0 || n > 59 || o < 0 || o > 59 || s !== void 0 && (s < 0 || s > 23) || a !== void 0 && (a < 0 || a > 59));
}
function qn(e, r) {
  return new Date(Date.UTC(e, r, 0)).getUTCDate();
}
function Yn(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  const t = e.split(".");
  if (t.length !== 3 || t.some((i) => !et(i)))
    throw new Error(`Invalid ${r}`);
}
function et(e) {
  return Mn.test(e) && e.length % 4 !== 1;
}
function zn(e) {
  fr(e.keyGeneration, "keyGeneration must be a non-negative safe integer");
  for (const r of e.availableKeyGenerations)
    fr(
      r,
      "availableKeyGenerations must contain only non-negative safe integers"
    );
  return e.availableKeyGenerations.includes(e.keyGeneration) ? "process-decrypt" : "blocked-by-key";
}
function fr(e, r) {
  if (!Number.isSafeInteger(e) || e < 0) throw new Error(r);
}
function Wn(e) {
  const r = e.incomingUpdate;
  if (r.effectiveKeyGeneration < e.localKeyGeneration) return "ignore-stale";
  if (r.effectiveKeyGeneration > e.localKeyGeneration + 1) return "buffer-future-and-catch-up";
  const t = Qn(r, e), i = e.seenUpdates.find((n) => Zn(n, r));
  if (i) {
    const n = Xn(i.storedDisposition);
    return t > n ? "upgrade-pending-and-sync" : t < n ? "ignore-lower-authority" : "ignore-duplicate";
  }
  return t > 0 ? "store-pending-and-sync" : "store-unverified-pending-and-sync";
}
function Zn(e, r) {
  return e.spaceId === r.spaceId && e.action === r.action && e.memberDid === r.memberDid && e.effectiveKeyGeneration === r.effectiveKeyGeneration;
}
function Qn(e, r) {
  return r.knownAdminDids.includes(e.signerDid) || e.action === "added" && r.knownMemberDids.includes(e.signerDid) ? 1 : 0;
}
function Xn(e) {
  return e === "store-pending-and-sync" ? 1 : 0;
}
const lr = "wot/personal-doc/v1", ue = 32;
async function eo(e, r) {
  const t = Or(e), i = await r.hkdfSha256(t, lr, ue);
  return { hkdfInfo: lr, key: i, docId: rt(i) };
}
function rt(e) {
  if (e.length !== ue)
    throw new Error(`Personal Doc key must be exactly ${ue} bytes`);
  const r = new Uint8Array(16);
  return r.set(e.subarray(0, 16)), r[6] = r[6] & 15 | 64, r[8] = r[8] & 63 | 128, [
    j(r.slice(0, 4)),
    j(r.slice(4, 6)),
    j(r.slice(6, 8)),
    j(r.slice(8, 10)),
    j(r.slice(10, 16))
  ].join("-");
}
function j(e) {
  return Array.from(e, (r) => r.toString(16).padStart(2, "0")).join("");
}
const pe = {
  recoveredDataKind: "public-profile-discovery-data",
  canonicalReplacementFor: [],
  notCanonicalReplacementFor: [
    "personal-doc",
    "vault",
    "private-wallet",
    "private-sync-state"
  ]
}, ce = "profile-service-fallback", fe = "real-life-org/wot-spec#19", ro = [
  "did-document",
  "public-profile-data",
  "published-verifications",
  "deliberately-published-attestations",
  "did-document-keyAgreement",
  "did-document-service"
], to = [
  "private-wallet-state",
  "unpublished-received-attestations",
  "private-contacts-not-public-profile-derived",
  "space-content-keys",
  "space-membership-secrets",
  "personal-doc-only-state",
  "vault-secrets",
  "private-sync-state"
], io = [
  "jws-signature-verification",
  "did-path-consistency",
  "version-monotonicity"
];
function no(e) {
  return ro.includes(e) ? {
    artifact: e,
    disposition: "allowed",
    recoverySource: ce,
    dataBoundary: pe.recoveredDataKind,
    canonicalReplacementFor: [...pe.canonicalReplacementFor],
    normativeDecision: fe
  } : to.includes(e) ? {
    artifact: e,
    disposition: "forbidden",
    recoverySource: ce,
    dataBoundary: "private-or-non-discovery-state",
    canonicalReplacementFor: [],
    normativeDecision: fe
  } : {
    artifact: e,
    disposition: "unknown",
    recoverySource: ce,
    dataBoundary: "out-of-scope",
    canonicalReplacementFor: [],
    normativeDecision: fe
  };
}
function oo() {
  return [...io];
}
const tt = /^did:[a-z0-9]+:.+/, so = ["encryptionPublicKey"];
function it(e, r) {
  const t = v(e, "Invalid profile resource payload");
  if (typeof t.did != "string" || !tt.test(t.did))
    throw new Error("Invalid profile resource DID");
  if (t.did !== r.expectedDid) throw new Error("Profile resource DID does not match path DID");
  B(t.version, "profile resource version"), yo(t.didDocument, t.did);
  const i = v(t.profile, "Invalid profile resource profile metadata");
  if (typeof i.name != "string" || i.name.length === 0)
    throw new Error("Invalid profile resource profile name");
  for (const n of so)
    if (Object.prototype.hasOwnProperty.call(i, n))
      throw new Error(`Profile resource profile metadata must not contain ${n}`);
  if (!st(t.updatedAt)) throw new Error("Invalid profile resource updatedAt");
  return t;
}
function nt(e, r) {
  const t = v(e, "Invalid profile service list resource payload");
  if (le(t, "didDocument") || le(t, "profile"))
    throw new Error("Profile service list resource must not contain didDocument or profile");
  if (typeof t.did != "string" || !tt.test(t.did))
    throw new Error("Invalid profile service list resource DID");
  if (t.did !== r.expectedDid)
    throw new Error("Profile service list resource DID does not match path DID");
  if (B(t.version, "profile service list resource version"), !st(t.updatedAt)) throw new Error("Invalid profile service list resource updatedAt");
  const i = ["verifications", "attestations"].filter((s) => le(t, s));
  if (i.length !== 1)
    throw new Error("Profile service list resource must contain exactly one list field");
  const n = i[0];
  if (n !== r.resourceKind)
    throw new Error("Profile service list resource kind does not match payload list field");
  const o = t[n];
  if (!Array.isArray(o) || o.some((s) => !wo(s)))
    throw new Error("Profile service list resource entries must be compact JWS strings");
  return t;
}
function ao(e) {
  return B(e.incomingVersion, "incoming profile resource version"), e.storedVersion === void 0 ? { accept: !0 } : (B(e.storedVersion, "stored profile resource version"), e.incomingVersion > e.storedVersion ? { accept: !0 } : { accept: !1, conflictVersion: e.storedVersion });
}
function co(e) {
  return B(e.fetchedVersion, "fetched profile resource version"), e.lastSeenVersion === void 0 ? !1 : (B(e.lastSeenVersion, "last seen profile resource version"), e.fetchedVersion < e.lastSeenVersion);
}
async function fo(e, r) {
  const t = R(e), i = v(t.header, "Invalid JWS header");
  if (i.alg !== "EdDSA") throw new Error("Unsupported JWS alg");
  if (typeof i.kid != "string" || i.kid.length === 0) throw new Error("Missing JWS kid");
  const n = r.resourceKind === "verifications" || r.resourceKind === "attestations" ? nt(t.payload, {
    expectedDid: r.expectedDid,
    resourceKind: r.resourceKind
  }) : it(t.payload, { expectedDid: r.expectedDid });
  if (m(i.kid) !== n.did)
    throw new Error("Profile service resource JWS kid DID does not match payload DID");
  const o = await lo(i.kid, r.didResolver);
  if (!await r.crypto.verifyEd25519(t.signingInput, t.signature, o)) throw new Error("Invalid JWS signature");
  return n;
}
async function lo(e, r) {
  const t = m(e), i = await r.resolve(t);
  if (!i) throw new Error("Unable to resolve profile resource DID");
  uo(i, t);
  const n = i.verificationMethod.find((o) => go(o.id, t, e));
  if (!n) throw new Error("Unable to resolve profile resource verification method");
  return Tr(n.publicKeyMultibase);
}
function v(e, r) {
  if (typeof e != "object" || e === null || Array.isArray(e)) throw new Error(r);
  return e;
}
function le(e, r) {
  return Object.prototype.hasOwnProperty.call(e, r);
}
function B(e, r) {
  if (!Number.isSafeInteger(e) || e < 0) throw new Error(`Invalid ${r}`);
}
function yo(e, r) {
  const t = v(e, "Invalid profile resource DID document");
  if (t.id !== r) throw new Error("Profile resource DID document id does not match payload DID");
  ot(t, "Invalid profile resource DID document");
}
function uo(e, r) {
  const t = v(e, "Invalid resolved profile resource DID document");
  if (t.id !== r) throw new Error("Resolved profile resource DID document id does not match resolved DID");
  ot(t, "Invalid resolved profile resource DID document");
}
function ot(e, r) {
  yr(e.verificationMethod, r), ur(e.authentication, r), ur(e.assertionMethod, r), yr(e.keyAgreement, r), e.service !== void 0 && po(e.service, r);
}
function yr(e, r) {
  if (!Array.isArray(e)) throw new Error(r);
  for (const t of e) {
    const i = v(t, r);
    C(i.id, r), C(i.type, r), C(i.controller, r), C(i.publicKeyMultibase, r);
  }
}
function po(e, r) {
  if (!Array.isArray(e)) throw new Error(r);
  for (const t of e) {
    const i = v(t, r);
    C(i.id, r), C(i.type, r), C(i.serviceEndpoint, r);
  }
}
function ur(e, r) {
  if (!Array.isArray(e) || e.some((t) => typeof t != "string")) throw new Error(r);
}
function C(e, r) {
  if (typeof e != "string") throw new Error(r);
}
function st(e) {
  if (typeof e != "string") return !1;
  const r = e.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!r) return !1;
  const t = Number(r[1]), i = Number(r[2]), n = Number(r[3]), o = Number(r[4]), s = Number(r[5]), a = Number(r[6]);
  if (i < 1 || i > 12 || n < 1 || n > 31 || o > 23 || s > 59 || a > 59) return !1;
  if (r[7] !== "Z") {
    const l = Number(r[9]), g = Number(r[10]);
    if (l > 23 || g > 59) return !1;
  }
  const c = Date.UTC(t, i - 1, n, o, s, a);
  if (Number.isNaN(c)) return !1;
  const d = new Date(c);
  return d.getUTCFullYear() === t && d.getUTCMonth() + 1 === i && d.getUTCDate() === n && d.getUTCHours() === o && d.getUTCMinutes() === s && d.getUTCSeconds() === a;
}
function wo(e) {
  if (typeof e != "string") return !1;
  const r = e.split(".");
  return r.length === 3 && r.every((t) => /^[A-Za-z0-9_-]+$/.test(t));
}
function go(e, r, t) {
  return e === t || e.startsWith("#") && `${r}${e}` === t;
}
function ho(e) {
  return we(e.localSeq, "localSeq"), we(e.brokerSeq, "brokerSeq"), e.brokerSeq > e.localSeq ? {
    disposition: "restore-clone-required",
    reason: "broker-seq-greater-than-local-seq"
  } : {
    disposition: "no-restore-clone-detected",
    reason: "broker-seq-not-greater-than-local-seq"
  };
}
function vo(e) {
  return we(e.seq, "seq"), pr(e.incomingContentHash, "incomingContentHash"), e.existingContentHash == null ? { disposition: "accept-new-entry" } : (pr(e.existingContentHash, "existingContentHash"), e.existingContentHash === e.incomingContentHash ? { disposition: "idempotent-retransmission" } : {
    disposition: "reject-seq-collision",
    errorCode: "SEQ_COLLISION_DETECTED",
    clientHint: "restore-clone-required"
  });
}
function we(e, r) {
  if (!Number.isSafeInteger(e) || e < 0) throw new Error(`Invalid ${r}`);
}
function pr(e, r) {
  if (typeof e != "string" || e.length === 0) throw new Error(`Invalid ${r}`);
}
const mo = [
  "durable-buffer-or-retry",
  "key-catch-up",
  "do-not-mark-processed"
], wr = {
  nonAuthoritativeOverKnownValidLogEntries: !0,
  noRollbackKnownValidLogEntries: !0,
  noOverwriteKnownValidLogEntries: !0,
  notAppendOnlyLogReplacement: !0
};
function bo(e) {
  const { snapshot: r } = e;
  return !gr(r.keyGeneration) || !gr(e.expectedKeyGeneration) ? ye("invalid-key-generation") : r.docId !== e.expectedDocId ? ye("doc-id-mismatch") : r.keyGeneration !== e.expectedKeyGeneration ? ye("key-generation-mismatch") : e.keyMaterial !== "available" ? {
    status: "blocked-by-key",
    reason: Eo(e.keyMaterial),
    mergeEligible: !1,
    markSnapshotProcessed: !1,
    actions: mo
  } : r.heads === void 0 ? {
    status: "crdt-merge-helper-only",
    reason: "missing-coverage-metadata",
    mergeEligible: !0,
    markSnapshotProcessed: !1,
    actions: ["crdt-merge-only", "sync-request-log-catch-up"],
    logSafety: wr
  } : {
    status: "catch-up-optimization-eligible",
    reason: "matching-metadata-with-coverage",
    mergeEligible: !0,
    markSnapshotProcessed: !1,
    actions: ["crdt-merge", "log-head-coverage-optimization"],
    logSafety: wr
  };
}
function ye(e) {
  return {
    status: "rejected",
    reason: e,
    mergeEligible: !1,
    markSnapshotProcessed: !1,
    actions: []
  };
}
function Eo(e) {
  return e === "missing" ? "missing-key-material" : e === "unavailable" ? "unavailable-key-material" : "future-key-material";
}
function gr(e) {
  return Number.isSafeInteger(e) && e >= 0;
}
const hr = [
  "audience",
  "generation",
  "issuedAt",
  "permissions",
  "spaceId",
  "type",
  "validUntil"
], Io = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, ko = /^did:[a-z0-9]+:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+(?::(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)*$/, Do = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
async function Ao(e) {
  return dt(e.payload), H(
    { alg: "EdDSA", kid: at(e.payload), typ: "wot-capability+jwt" },
    e.payload,
    e.signingSeed
  );
}
async function To(e, r) {
  const { header: t, payload: i } = await M(e, {
    publicKey: r.publicKey,
    crypto: r.crypto
  });
  if (t.typ !== "wot-capability+jwt") throw new Error("Invalid capability typ");
  if (dt(i), t.kid !== at(i)) throw new Error("Capability kid mismatch");
  return So(i, r), i;
}
function at(e) {
  return `wot:space:${e.spaceId}#cap-${e.generation}`;
}
function dt(e) {
  if (!e || typeof e != "object" || Array.isArray(e))
    throw new Error("Invalid capability payload");
  Co(e);
  const r = e;
  if (r.type !== "capability") throw new Error("Invalid capability type");
  if (typeof r.spaceId != "string" || !Io.test(r.spaceId))
    throw new Error("Invalid capability spaceId");
  if (typeof r.audience != "string" || !ko.test(r.audience))
    throw new Error("Invalid capability audience");
  Ro(r.permissions);
  const t = r.generation;
  if (typeof t != "number" || !Number.isInteger(t) || t < 0)
    throw new Error("Invalid capability generation");
  vr(r.issuedAt, "issuedAt"), vr(r.validUntil, "validUntil");
}
function So(e, r) {
  if (r.expectedSpaceId !== void 0 && e.spaceId !== r.expectedSpaceId)
    throw new Error("Capability spaceId mismatch");
  if (r.expectedAudience !== void 0 && e.audience !== r.expectedAudience)
    throw new Error("Capability audience mismatch");
  if (r.expectedGeneration !== void 0 && e.generation !== r.expectedGeneration)
    throw new Error("Capability generation mismatch");
  if (r.now !== void 0) {
    const t = r.now.getTime();
    if (Number.isNaN(t)) throw new Error("Invalid capability verifier time");
    if (t >= Date.parse(e.validUntil)) throw new Error("Capability expired");
  }
}
function Co(e) {
  const r = Object.keys(e).sort();
  if (r.length !== hr.length || r.some((t, i) => t !== hr[i]))
    throw new Error("Invalid capability payload fields");
}
function Ro(e) {
  if (!Array.isArray(e) || e.length === 0)
    throw new Error("Invalid capability permissions");
  const r = /* @__PURE__ */ new Set();
  for (const t of e) {
    if (t !== "read" && t !== "write") throw new Error("Invalid capability permission");
    if (r.has(t)) throw new Error("Duplicate capability permission");
    r.add(t);
  }
}
function vr(e, r) {
  if (typeof e != "string") throw new Error(`Invalid capability ${r}`);
  const t = Do.exec(e);
  if (!t || !_o(t) || Number.isNaN(Date.parse(e)))
    throw new Error(`Invalid capability ${r}`);
}
function _o(e) {
  const r = Number.parseInt(e[1], 10), t = Number.parseInt(e[2], 10), i = Number.parseInt(e[3], 10), n = Number.parseInt(e[4], 10), o = Number.parseInt(e[5], 10), s = Number.parseInt(e[6], 10), a = e[8];
  if (t < 1 || t > 12 || i < 1 || i > No(r, t) || n > 23 || o > 59 || s > 59) return !1;
  if (a === "Z") return !0;
  const c = Number.parseInt(a.slice(1, 3), 10), d = Number.parseInt(a.slice(4, 6), 10);
  return c <= 23 && d <= 59;
}
function No(e, r) {
  return r === 2 ? Ko(e) ? 29 : 28 : [4, 6, 9, 11].includes(r) ? 30 : 31;
}
function Ko(e) {
  return e % 4 === 0 && (e % 100 !== 0 || e % 400 === 0);
}
const Ye = "https://web-of-trust.de/protocols/sync-request/1.0", ze = "https://web-of-trust.de/protocols/sync-response/1.0", Bo = /^[A-Za-z0-9_-]+$/;
function $o(e) {
  const r = O({
    id: e.id,
    type: Ye,
    from: e.from,
    to: e.to,
    createdTime: e.createdTime,
    body: e.body,
    thid: e.thid,
    pthid: e.pthid
  });
  return We(r), r;
}
function Mo(e) {
  const r = O({
    id: e.id,
    type: ze,
    from: e.from,
    to: e.to,
    createdTime: e.createdTime,
    body: e.body,
    thid: e.thid,
    pthid: e.pthid
  });
  return Ze(r), r;
}
function Oo(e) {
  return We(e), e;
}
function Po(e) {
  return Ze(e), e;
}
function We(e) {
  if (b(e), e.type !== Ye) throw new Error("Invalid sync-request type");
  ct(e.body);
}
function Ze(e) {
  if (b(e), e.type !== ze) throw new Error("Invalid sync-response type");
  if (e.thid === void 0 || e.thid.length === 0) throw new Error("Invalid sync-response thid");
  ft(e.body);
}
function ct(e) {
  const r = Qe(e, "sync-request body");
  yt(r, ["docId", "heads", "limit"], "sync-request body"), Xe(r.docId, "sync-request body docId"), lt(r.heads, "sync-request body heads"), r.limit !== void 0 && ut(r.limit, "sync-request body limit");
}
function ft(e) {
  const r = Qe(e, "sync-response body");
  if (yt(r, ["docId", "entries", "heads", "truncated"], "sync-response body"), Xe(r.docId, "sync-response body docId"), Lo(r.entries, "sync-response body entries"), lt(r.heads, "sync-response body heads"), typeof r.truncated != "boolean") throw new Error("Invalid sync-response body truncated");
}
function lt(e, r) {
  const t = Qe(e, r);
  for (const [i, n] of Object.entries(t))
    Xe(i, `${r} deviceId`), ut(n, `${r} seq`);
}
function Qe(e, r) {
  if (e === null || typeof e != "object" || Array.isArray(e)) throw new Error(`Invalid ${r}`);
  return e;
}
function yt(e, r, t) {
  const i = new Set(r);
  for (const n of Object.keys(e))
    if (!i.has(n)) throw new Error(`Invalid ${t} property: ${n}`);
}
function Xe(e, r) {
  if (typeof e != "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e))
    throw new Error(`Invalid ${r}`);
}
function ut(e, r) {
  if (!Number.isSafeInteger(e) || e < 0) throw new Error(`Invalid ${r}`);
}
function Lo(e, r) {
  if (!Array.isArray(e)) throw new Error(`Invalid ${r}`);
  for (const t of e) xo(t, r);
}
function xo(e, r) {
  if (typeof e != "string") throw new Error(`Invalid ${r}`);
  const t = e.split(".");
  if (t.length !== 3 || t.some((i) => !Uo(i)))
    throw new Error(`Invalid ${r}`);
}
function Uo(e) {
  return Bo.test(e) && e.length % 4 !== 1;
}
const mr = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, Fo = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
async function Jo(e) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await H(
      { alg: "EdDSA", kid: e.deviceKid, typ: "vc+jwt" },
      e.attestationPayload,
      e.deviceSigningSeed
    ),
    deviceKeyBindingJws: e.deviceKeyBindingJws
  };
}
async function jo(e) {
  return {
    type: "wot-delegated-attestation-bundle/v1",
    attestationJws: await he(
      { alg: "EdDSA", kid: e.deviceKid, typ: "vc+jwt" },
      e.attestationPayload,
      e.sign
    ),
    deviceKeyBindingJws: e.deviceKeyBindingJws
  };
}
async function Vo(e, r) {
  Go(e);
  const t = r.requiredCapability ?? "sign-attestation", i = await $r(e.deviceKeyBindingJws, { crypto: r.crypto }), { header: n, payload: o } = R(e.attestationJws);
  if (!br(n)) throw new Error("Invalid attestation JWS header");
  if (n.alg !== "EdDSA") throw new Error("Invalid attestation alg");
  if (n.typ !== "vc+jwt") throw new Error("Invalid attestation JWS typ");
  if (n.kid !== i.deviceKid) throw new Error("Attestation kid does not match deviceKid");
  if (await M(e.attestationJws, {
    publicKey: $(i.deviceKid),
    crypto: r.crypto
  }), br(o) && (typeof o.issuer == "string" && o.issuer !== i.iss || typeof o.iss == "string" && o.iss !== i.iss))
    throw new Error("Delegated attestation issuer mismatch");
  if (Cr(o, i.deviceKid, {
    now: r.now,
    requireIssuerKidBinding: !1
  }), !i.capabilities.includes(t)) throw new Error("Missing required device capability");
  if (o.iat === void 0) throw new Error("Delegated attestation requires iat");
  const a = Ho(o.iat, "Invalid delegated attestation iat") * 1e3, c = Er(i.validFrom, "Invalid DeviceKeyBinding validFrom"), d = Er(i.validUntil, "Invalid DeviceKeyBinding validUntil");
  if (!(c <= a && a <= d))
    throw new Error("Attestation iat outside delegation window");
  return { attestationPayload: o, bindingPayload: i };
}
function Go(e) {
  if (typeof e != "object" || e === null || Array.isArray(e))
    throw new Error("Invalid delegated attestation bundle");
  const r = Object.keys(e);
  for (const i of r)
    if (i !== "type" && i !== "attestationJws" && i !== "deviceKeyBindingJws")
      throw new Error("Invalid delegated attestation bundle field");
  const t = e;
  if (t.type !== "wot-delegated-attestation-bundle/v1") throw new Error("Invalid delegated attestation bundle type");
  if (typeof t.attestationJws != "string" || !mr.test(t.attestationJws))
    throw new Error("Invalid delegated attestation bundle attestationJws");
  if (typeof t.deviceKeyBindingJws != "string" || !mr.test(t.deviceKeyBindingJws))
    throw new Error("Invalid delegated attestation bundle deviceKeyBindingJws");
}
function Ho(e, r) {
  if (typeof e != "number" || !Number.isInteger(e) || e < 0) throw new Error(r);
  return e;
}
function br(e) {
  return typeof e == "object" && e !== null && !Array.isArray(e);
}
function Er(e, r) {
  const t = Fo.exec(e);
  if (!t) throw new Error(r);
  const [, i, n, o, s, a, c, d = "", l, g, _, I] = t, k = Number(i), D = Number(n), A = Number(o), N = Number(s), T = Number(a), S = Number(c), L = qo(d), Y = _ === void 0 ? 0 : Number(_), x = I === void 0 ? 0 : Number(I);
  if (N > 23 || T > 59 || S > 59 || Y > 23 || x > 59)
    throw new Error(r);
  const U = Date.UTC(k, D - 1, A, N, T, S), u = new Date(U);
  if (u.getUTCFullYear() !== k || u.getUTCMonth() !== D - 1 || u.getUTCDate() !== A || u.getUTCHours() !== N || u.getUTCMinutes() !== T || u.getUTCSeconds() !== S)
    throw new Error(r);
  const h = l === "Z" ? 0 : (g === "+" ? 1 : -1) * (Y * 60 + x), z = U + L - h * 6e4;
  if (!Number.isFinite(z)) throw new Error(r);
  return z;
}
function qo(e) {
  return e.length === 0 ? 0 : +`0${e}` * 1e3;
}
function pt(e) {
  return G(ve(e));
}
async function wt(e, r) {
  return G(await r.sha256(new TextEncoder().encode(e)));
}
function Yo(e, r) {
  return `${e}~${r.map(pt).join("~")}~`;
}
async function gt(e, r) {
  const t = e.split("~");
  if (t.length < 2 || t[t.length - 1] !== "") throw new Error("Invalid SD-JWT compact serialization");
  const i = t[0], n = t.slice(1, -1), o = R(i), s = Zo(o.header.kid), a = await M(i, {
    publicKey: $(s),
    crypto: r.crypto
  }), c = await Promise.all(
    n.map((d) => wt(d, r.crypto))
  );
  return Qo(a.payload, c), {
    issuerKid: s,
    issuerPayload: a.payload,
    disclosures: n.map(Wo),
    disclosureDigests: c
  };
}
async function zo(e, r) {
  const t = await gt(e, r), { issuerKid: i, issuerPayload: n } = t;
  if (es(n.iss, "iss") !== m(i)) throw new Error("Invalid HMC Trust List issuer");
  if (n._sd_alg !== "sha-256") throw new Error("Invalid HMC Trust List _sd_alg");
  if (n.vct !== r.expectedVct) throw new Error("Invalid HMC Trust List vct");
  const s = rs(r.now);
  if (Ir(n.exp, "exp") <= s) throw new Error("Expired HMC Trust List exp");
  if (Ir(n.iat, "iat") > s) throw new Error("Future HMC Trust List iat");
  return t;
}
function Wo(e) {
  return JSON.parse(new TextDecoder().decode(ee(e)));
}
function Zo(e) {
  if (e === void 0 || e === "") throw new Error("Missing SD-JWT issuer kid");
  if (typeof e != "string") throw new Error("Invalid SD-JWT issuer kid");
  return e;
}
function Qo(e, r) {
  const t = Xo(e);
  for (const i of r)
    if (!t.has(i)) throw new Error("SD-JWT disclosure digest not present");
}
function Xo(e) {
  const r = /* @__PURE__ */ new Set();
  return ge(e, r), r;
}
function ge(e, r) {
  if (Array.isArray(e)) {
    for (const t of e) ge(t, r);
    return;
  }
  if (!(e === null || typeof e != "object"))
    for (const [t, i] of Object.entries(e)) {
      if (t === "_sd") {
        if (!Array.isArray(i)) throw new Error("Invalid SD-JWT _sd claim");
        for (const n of i) {
          if (typeof n != "string") throw new Error("Invalid SD-JWT _sd claim");
          r.add(n);
        }
        continue;
      }
      ge(i, r);
    }
}
function Ir(e, r) {
  if (e === void 0)
    throw new Error(`Missing HMC Trust List ${r}`);
  if (typeof e != "number" || !Number.isInteger(e) || e < 0)
    throw new Error(`Invalid HMC Trust List ${r}`);
  return e;
}
function es(e, r) {
  if (e === void 0 || e === "") throw new Error(`Missing HMC Trust List ${r}`);
  if (typeof e != "string") throw new Error(`Invalid HMC Trust List ${r}`);
  return e;
}
function rs(e) {
  const r = e.getTime();
  if (!Number.isFinite(r)) throw new Error("Invalid HMC Trust List verification time");
  return Math.floor(r / 1e3);
}
const os = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ACK_MESSAGE_TYPE: Ce,
  BROKER_AUTH_TRANSCRIPT_PROTOCOL: Ke,
  BROKER_AUTH_TRANSCRIPT_TYPE: K,
  BROKER_CHALLENGE_CONTROL_FRAME_TYPE: Q,
  BROKER_CHALLENGE_RESPONSE_CONTROL_FRAME_TYPE: te,
  BROKER_DEVICE_REVOKE_CONTROL_FRAME_TYPE: W,
  BROKER_ERROR_CLIENT_ACTIONS: ht,
  BROKER_REGISTERED_CONTROL_FRAME_TYPE: X,
  BROKER_REGISTER_CONTROL_FRAME_TYPE: Z,
  DIDCOMM_PLAINTEXT_TYP: y,
  ERROR_CONTROL_FRAME_TYPE: ne,
  KEY_ROTATION_MESSAGE_TYPE: Ee,
  KNOWN_BROKER_ERROR_CODES: vt,
  LOG_ENTRY_MESSAGE_TYPE: Ge,
  MEMBER_UPDATE_MESSAGE_TYPE: be,
  PROFILE_RECOVERY_DATA_BOUNDARY: pe,
  SPACE_INVITE_MESSAGE_TYPE: me,
  SYNC_REQUEST_MESSAGE_TYPE: Ye,
  SYNC_RESPONSE_MESSAGE_TYPE: ze,
  TRUST_LIST_DELTA_MESSAGE_TYPE: Ae,
  applyBrokerInboxAck: mn,
  assertAckMessage: Re,
  assertAckMessageBody: Pr,
  assertAttestationVcPayload: Cr,
  assertBrokerChallengeControlFrame: kn,
  assertBrokerChallengeResponseControlFrame: Pi,
  assertBrokerDeviceRevokeControlFrame: cn,
  assertBrokerErrorControlFrame: Hi,
  assertBrokerRegisterControlFrame: En,
  assertBrokerRegisteredControlFrame: An,
  assertKeyRotationBody: Nr,
  assertKeyRotationMessage: De,
  assertKnownBrokerErrorCode: mt,
  assertLogEntryMessage: He,
  assertLogEntryMessageBody: Zr,
  assertLogEntryPayload: qe,
  assertMemberUpdateBody: _r,
  assertMemberUpdateMessage: ke,
  assertPlaintextMessage: b,
  assertSpaceInviteBody: Rr,
  assertSpaceInviteMessage: Ie,
  assertSyncRequestBody: ct,
  assertSyncRequestMessage: We,
  assertSyncResponseBody: ft,
  assertSyncResponseMessage: Ze,
  assertTrustListDeltaBody: Br,
  assertTrustListDeltaMessage: Te,
  buildBrokerAuthTranscript: xr,
  bytesToHex: Rt,
  canonicalize: xt,
  canonicalizeToBytes: ve,
  classifyBrokerAuthChallengeResponseBinding: Ur,
  classifyBrokerErrorClientAction: bt,
  classifyBrokerSeqCollision: vo,
  classifyDeviceRevocationDisposition: rn,
  classifyLocalBrokerSeqConsistency: ho,
  classifyLogEntryKeyDisposition: zn,
  classifyProfileRecoveryArtifact: no,
  classifySnapshotDisposition: bo,
  compareSyncHeads: Cn,
  computeBrokerInboxDeliveryTargets: vn,
  createAckMessage: ki,
  createAttestationVcJws: Ut,
  createAttestationVcJwsWithSigner: Ft,
  createBrokerAuthTranscriptSigningBytes: Be,
  createBrokerChallengeControlFrame: In,
  createBrokerChallengeResponseControlFrame: Oi,
  createBrokerDeviceRevokeControlFrame: dn,
  createBrokerErrorControlFrame: Gi,
  createBrokerRegisterControlFrame: bn,
  createBrokerRegisteredControlFrame: Dn,
  createDelegatedAttestationBundle: Jo,
  createDelegatedAttestationBundleWithSigner: jo,
  createDeviceKeyBindingJws: pi,
  createDeviceKeyBindingJwsWithSigner: wi,
  createDidKeyResolver: Et,
  createJcsEd25519Jws: H,
  createJcsEd25519JwsWithSigner: he,
  createKeyRotationMessage: Zt,
  createLogEntryJws: On,
  createLogEntryMessage: Ln,
  createMemberUpdateMessage: Wt,
  createPlaintextMessage: O,
  createSdJwtVcCompact: Yo,
  createSpaceCapabilityJws: Ao,
  createSpaceInviteMessage: zt,
  createSyncRequestMessage: $o,
  createSyncResponseMessage: Mo,
  createTrustListDeltaMessage: oi,
  decideBrokerChallengeNonceConsumption: _i,
  decideProfileResourcePutAcceptance: ao,
  decideVerificationAttestationAcceptance: Jt,
  decodeBase58: It,
  decodeBase64Url: ee,
  decodeJws: R,
  decryptEcies: _t,
  decryptLogPayload: Nt,
  deriveBip39SeedFromMnemonic: Kt,
  deriveEciesMaterial: Bt,
  deriveLogPayloadNonce: $t,
  derivePersonalDocFromSeedHex: eo,
  deriveProtocolIdentityFromMnemonic: Mt,
  deriveProtocolIdentityFromSeedHex: Ot,
  deriveSpaceAdminKeyFromSeedHex: Ei,
  deriveSyncStartSeq: Tn,
  detectProfileResourceRollback: co,
  didKeyToPublicKeyBytes: $,
  didOrKidToDid: m,
  digestSdJwtDisclosure: wt,
  ed25519MultibaseToPublicKeyBytes: Tr,
  ed25519PublicKeyToMultibase: kr,
  encodeBase58: kt,
  encodeBase64Url: G,
  encodeSdJwtDisclosure: pt,
  encryptEcies: Pt,
  encryptLogPayload: Lt,
  evaluateBrokerDeviceRegistrationDisposition: Zi,
  evaluateDeviceRevocationDisposition: en,
  evaluateInboxAckDisposition: Kn,
  evaluateKeyRotationDisposition: $n,
  evaluateMemberUpdateDisposition: Wn,
  evaluateSyncResponseDisposition: Sn,
  formatBrokerChallengeNonce: _e,
  formatBrokerChallengeResponseSignature: Oe,
  hexToBytes: Sr,
  isActiveQrChallengeValid: jt,
  isKnownBrokerErrorCode: Dt,
  listProfileRecoveryVerificationGates: oo,
  parseAckMessage: Di,
  parseBrokerChallengeControlFrame: Ue,
  parseBrokerChallengeNonce: Ne,
  parseBrokerChallengeResponseControlFrame: ie,
  parseBrokerDeviceRevokeControlFrame: oe,
  parseBrokerErrorBody: Ar,
  parseBrokerErrorControlFrame: Pe,
  parseBrokerRegisterControlFrame: xe,
  parseBrokerRegisteredControlFrame: Fe,
  parseKeyRotationMessage: ei,
  parseLogEntryMessage: xn,
  parseMemberUpdateMessage: Xt,
  parsePlaintextMessage: Yt,
  parseQrChallenge: Vt,
  parseSpaceInviteMessage: Qt,
  parseSyncRequestMessage: Oo,
  parseSyncResponseMessage: Po,
  parseTrustListDeltaMessage: si,
  parseVerificationJtiNonce: Gt,
  personalDocIdFromKey: rt,
  publicKeyToDidKey: Dr,
  resolveDidKey: At,
  validateDeviceRevokePayload: Le,
  validateProfileServiceListResourcePayload: nt,
  validateProfileServiceResourcePayload: it,
  verifyAttestationVcJws: Ht,
  verifyBrokerChallengeResponseControlFrame: Li,
  verifyBrokerDeviceRevokeControlFrame: fn,
  verifyDelegatedAttestationBundle: Vo,
  verifyDeviceKeyBindingJws: $r,
  verifyHmcTrustListSdJwtVc: zo,
  verifyJwsWithPublicKey: M,
  verifyLogEntryJws: Pn,
  verifyProfileServiceResourceJws: fo,
  verifySdJwtVc: gt,
  verifySpaceCapabilityJws: To,
  wholeSecondRfc3339: qt,
  x25519MultibaseToPublicKeyBytes: Tt,
  x25519PublicKeyToMultibase: St
}, Symbol.toStringTag, { value: "Module" }));
export {
  Le as $,
  Ce as A,
  Ke as B,
  Gi as C,
  Pe as D,
  ne as E,
  Hi as F,
  Zi as G,
  W as H,
  dn as I,
  oe as J,
  cn as K,
  fn as L,
  vn as M,
  mn as N,
  Z as O,
  Q as P,
  X as Q,
  bn as R,
  xe as S,
  Ae as T,
  En as U,
  In as V,
  Ue as W,
  kn as X,
  Dn as Y,
  Fe as Z,
  An as _,
  Te as a,
  Vo as a$,
  en as a0,
  rn as a1,
  Tn as a2,
  Sn as a3,
  Cn as a4,
  Kn as a5,
  $n as a6,
  Ge as a7,
  On as a8,
  Pn as a9,
  eo as aA,
  rt as aB,
  pe as aC,
  no as aD,
  oo as aE,
  it as aF,
  nt as aG,
  ao as aH,
  co as aI,
  fo as aJ,
  ho as aK,
  vo as aL,
  bo as aM,
  Ao as aN,
  To as aO,
  Ye as aP,
  ze as aQ,
  $o as aR,
  Mo as aS,
  Oo as aT,
  Po as aU,
  We as aV,
  Ze as aW,
  ct as aX,
  ft as aY,
  Jo as aZ,
  jo as a_,
  Ln as aa,
  xn as ab,
  He as ac,
  Zr as ad,
  qe as ae,
  zn as af,
  Wn as ag,
  y as ah,
  me as ai,
  be as aj,
  Ee as ak,
  O as al,
  Yt as am,
  b as an,
  zt as ao,
  Wt as ap,
  Zt as aq,
  Qt as ar,
  Xt as as,
  ei as at,
  Ie as au,
  ke as av,
  De as aw,
  Rr as ax,
  _r as ay,
  Nr as az,
  Br as b,
  pt as b0,
  wt as b1,
  Yo as b2,
  gt as b3,
  zo as b4,
  oi as c,
  Ei as d,
  pi as e,
  wi as f,
  ki as g,
  Di as h,
  os as i,
  Re as j,
  Pr as k,
  _e as l,
  Ne as m,
  _i as n,
  K as o,
  si as p,
  xr as q,
  Be as r,
  Ur as s,
  te as t,
  Oi as u,
  $r as v,
  ie as w,
  Pi as x,
  Li as y,
  Oe as z
};
