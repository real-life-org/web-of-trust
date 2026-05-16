const y = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function x(e) {
  const r = [0];
  for (const i of e) {
    let t = i;
    for (let s = 0; s < r.length; s++)
      t += r[s] << 8, r[s] = t % 58, t = t / 58 | 0;
    for (; t > 0; )
      r.push(t % 58), t = t / 58 | 0;
  }
  let n = "";
  for (const i of e)
    if (i === 0) n += y[0];
    else break;
  for (let i = r.length - 1; i >= 0; i--)
    n += y[r[i]];
  return n;
}
function E(e) {
  const r = [0];
  for (const n of e) {
    const i = y.indexOf(n);
    if (i < 0) throw new Error(`Invalid base58 character: ${n}`);
    let t = i;
    for (let s = 0; s < r.length; s++)
      t += r[s] * 58, r[s] = t & 255, t >>= 8;
    for (; t > 0; )
      r.push(t & 255), t >>= 8;
  }
  for (const n of e)
    if (n === y[0]) r.push(0);
    else break;
  return new Uint8Array(r.reverse());
}
function h(e) {
  let r = "";
  for (let n = 0; n < e.length; n++)
    r += String.fromCharCode(e[n]);
  return btoa(r).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function p(e) {
  const r = e.replace(/-/g, "+").replace(/_/g, "/"), n = (4 - r.length % 4) % 4, i = r + "=".repeat(n), t = atob(i);
  return Uint8Array.from(t, (s) => s.charCodeAt(0));
}
function U(e) {
  let r = "";
  for (let n = 0; n < e.length; n++)
    r += String.fromCharCode(e[n]);
  return btoa(r);
}
function A(e) {
  const r = atob(e);
  return Uint8Array.from(r, (n) => n.charCodeAt(0));
}
function D(e) {
  return e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength);
}
const f = new Uint8Array([237, 1]);
function P(e) {
  const r = new Uint8Array(f.length + e.length);
  return r.set(f), r.set(e, f.length), `did:key:${"z" + x(r)}`;
}
function b(e) {
  if (!e.startsWith("did:key:z"))
    throw new Error("Invalid did:key format");
  const r = e.slice(9), n = E(r);
  if (n[0] !== f[0] || n[1] !== f[1])
    throw new Error("Invalid multicodec prefix for Ed25519");
  return n.slice(f.length);
}
function C(e) {
  try {
    return e.startsWith("did:key:z") ? (b(e), !0) : !1;
  } catch {
    return !1;
  }
}
function T(e) {
  return e ? `User-${e.slice(-6)}` : "User";
}
async function k(e, r) {
  const n = {
    alg: "EdDSA",
    typ: "JWT"
  }, i = h(
    new TextEncoder().encode(JSON.stringify(n))
  ), t = h(
    new TextEncoder().encode(JSON.stringify(e))
  ), s = `${i}.${t}`, l = new TextEncoder().encode(s), a = await crypto.subtle.sign(
    "Ed25519",
    r,
    l
  ), c = new Uint8Array(a), u = h(c);
  return `${s}.${u}`;
}
async function $(e, r) {
  try {
    const n = e.split(".");
    if (n.length !== 3)
      return { valid: !1, error: "Invalid JWS format" };
    const [i, t, s] = n, l = p(i), a = JSON.parse(new TextDecoder().decode(l));
    if (a.alg !== "EdDSA")
      return { valid: !1, error: `Unsupported algorithm: ${a.alg}` };
    const c = p(t), u = JSON.parse(new TextDecoder().decode(c)), d = p(s), o = `${i}.${t}`, g = new TextEncoder().encode(o);
    return { valid: await crypto.subtle.verify(
      "Ed25519",
      r,
      D(d),
      g
    ), payload: u };
  } catch (n) {
    return {
      valid: !1,
      error: n instanceof Error ? n.message : "Verification failed"
    };
  }
}
function v(e) {
  try {
    const r = e.split(".");
    if (r.length !== 3) return null;
    const n = p(r[1]);
    return JSON.parse(new TextDecoder().decode(n));
  } catch {
    return null;
  }
}
async function J(e, r) {
  const n = {
    id: crypto.randomUUID(),
    issuer: e.issuer,
    audience: e.audience,
    resource: e.resource,
    permissions: [...e.permissions].sort(),
    expiration: e.expiration
  };
  return r(n);
}
async function B(e, r) {
  const n = r ?? /* @__PURE__ */ new Date(), i = v(e);
  if (!i || typeof i != "object")
    return { valid: !1, error: "Invalid capability: cannot extract payload" };
  const t = i, s = S(t);
  if (s)
    return { valid: !1, error: s };
  const l = new Date(t.expiration);
  if (isNaN(l.getTime()))
    return { valid: !1, error: "Invalid expiration date" };
  if (n >= l)
    return { valid: !1, error: "Capability has expired" };
  let a;
  try {
    const d = b(t.issuer);
    a = await crypto.subtle.importKey(
      "raw",
      d,
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  } catch {
    return { valid: !1, error: `Cannot resolve issuer DID: ${t.issuer}` };
  }
  const c = await $(e, a);
  if (!c.valid)
    return { valid: !1, error: `Invalid signature: ${c.error}` };
  const u = [];
  if (t.proof) {
    const d = await B(t.proof, r);
    if (!d.valid)
      return { valid: !1, error: `Invalid delegation chain: ${d.error}` };
    const o = d.capability;
    if (o.audience !== t.issuer)
      return {
        valid: !1,
        error: `Delegation chain broken: parent audience (${o.audience}) !== child issuer (${t.issuer})`
      };
    if (o.resource !== t.resource)
      return {
        valid: !1,
        error: `Delegation resource mismatch: parent (${o.resource}) !== child (${t.resource})`
      };
    const g = new Set(o.permissions);
    for (const w of t.permissions)
      if (!g.has(w))
        return {
          valid: !1,
          error: `Permission escalation: "${w}" not in parent permissions [${o.permissions.join(", ")}]`
        };
    const m = new Date(o.expiration);
    if (l > m)
      return {
        valid: !1,
        error: "Delegated capability expires after parent"
      };
    if (!o.permissions.includes("delegate"))
      return {
        valid: !1,
        error: 'Parent capability does not include "delegate" permission'
      };
    u.push(...d.chain, o);
  }
  return { valid: !0, capability: t, chain: u };
}
function I(e) {
  const r = v(e);
  return !r || typeof r != "object" ? null : r;
}
async function N(e, r, n) {
  const i = I(e);
  if (!i)
    throw new Error("Invalid parent capability");
  if (!i.permissions.includes("delegate"))
    throw new Error('Parent capability does not include "delegate" permission');
  const t = new Set(i.permissions);
  for (const c of r.permissions)
    if (!t.has(c))
      throw new Error(`Cannot delegate permission "${c}" — not in parent [${i.permissions.join(", ")}]`);
  const s = new Date(i.expiration);
  if (new Date(r.expiration) > s)
    throw new Error("Delegated capability cannot expire after parent");
  const a = {
    id: crypto.randomUUID(),
    issuer: i.audience,
    // Delegator is the audience of the parent
    audience: r.audience,
    resource: i.resource,
    permissions: [...r.permissions].sort(),
    expiration: r.expiration,
    proof: e
  };
  return n(a);
}
function S(e) {
  if (!e.id) return "Missing field: id";
  if (!e.issuer) return "Missing field: issuer";
  if (!e.audience) return "Missing field: audience";
  if (!e.resource) return "Missing field: resource";
  if (!e.permissions || !Array.isArray(e.permissions) || e.permissions.length === 0)
    return "Missing or empty field: permissions";
  if (!e.expiration) return "Missing field: expiration";
  const r = /* @__PURE__ */ new Set(["read", "write", "delete", "delegate"]);
  for (const n of e.permissions)
    if (!r.has(n))
      return `Invalid permission: "${n}"`;
  return null;
}
export {
  h as a,
  p as b,
  P as c,
  E as d,
  x as e,
  b as f,
  T as g,
  v as h,
  C as i,
  J as j,
  B as k,
  N as l,
  I as m,
  A as n,
  U as o,
  k as s,
  D as t,
  $ as v
};
