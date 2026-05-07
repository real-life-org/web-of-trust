import { h as f, f as v, v as x } from "./jws-8PD3qxx2.js";
async function D(e, r) {
  const t = {
    id: crypto.randomUUID(),
    issuer: e.issuer,
    audience: e.audience,
    resource: e.resource,
    permissions: [...e.permissions].sort(),
    expiration: e.expiration
  };
  return r(t);
}
async function w(e, r) {
  const t = r ?? /* @__PURE__ */ new Date(), n = f(e);
  if (!n || typeof n != "object")
    return { valid: !1, error: "Invalid capability: cannot extract payload" };
  const i = n, l = g(i);
  if (l)
    return { valid: !1, error: l };
  const c = new Date(i.expiration);
  if (isNaN(c.getTime()))
    return { valid: !1, error: "Invalid expiration date" };
  if (t >= c)
    return { valid: !1, error: "Capability has expired" };
  let d;
  try {
    const a = v(i.issuer);
    d = await crypto.subtle.importKey(
      "raw",
      a,
      { name: "Ed25519" },
      !0,
      ["verify"]
    );
  } catch {
    return { valid: !1, error: `Cannot resolve issuer DID: ${i.issuer}` };
  }
  const o = await x(e, d);
  if (!o.valid)
    return { valid: !1, error: `Invalid signature: ${o.error}` };
  const u = [];
  if (i.proof) {
    const a = await w(i.proof, r);
    if (!a.valid)
      return { valid: !1, error: `Invalid delegation chain: ${a.error}` };
    const s = a.capability;
    if (s.audience !== i.issuer)
      return {
        valid: !1,
        error: `Delegation chain broken: parent audience (${s.audience}) !== child issuer (${i.issuer})`
      };
    if (s.resource !== i.resource)
      return {
        valid: !1,
        error: `Delegation resource mismatch: parent (${s.resource}) !== child (${i.resource})`
      };
    const y = new Set(s.permissions);
    for (const p of i.permissions)
      if (!y.has(p))
        return {
          valid: !1,
          error: `Permission escalation: "${p}" not in parent permissions [${s.permissions.join(", ")}]`
        };
    const m = new Date(s.expiration);
    if (c > m)
      return {
        valid: !1,
        error: "Delegated capability expires after parent"
      };
    if (!s.permissions.includes("delegate"))
      return {
        valid: !1,
        error: 'Parent capability does not include "delegate" permission'
      };
    u.push(...a.chain, s);
  }
  return { valid: !0, capability: i, chain: u };
}
function b(e) {
  const r = f(e);
  return !r || typeof r != "object" ? null : r;
}
async function $(e, r, t) {
  const n = b(e);
  if (!n)
    throw new Error("Invalid parent capability");
  if (!n.permissions.includes("delegate"))
    throw new Error('Parent capability does not include "delegate" permission');
  const i = new Set(n.permissions);
  for (const o of r.permissions)
    if (!i.has(o))
      throw new Error(`Cannot delegate permission "${o}" — not in parent [${n.permissions.join(", ")}]`);
  const l = new Date(n.expiration);
  if (new Date(r.expiration) > l)
    throw new Error("Delegated capability cannot expire after parent");
  const d = {
    id: crypto.randomUUID(),
    issuer: n.audience,
    // Delegator is the audience of the parent
    audience: r.audience,
    resource: n.resource,
    permissions: [...r.permissions].sort(),
    expiration: r.expiration,
    proof: e
  };
  return t(d);
}
function g(e) {
  if (!e.id) return "Missing field: id";
  if (!e.issuer) return "Missing field: issuer";
  if (!e.audience) return "Missing field: audience";
  if (!e.resource) return "Missing field: resource";
  if (!e.permissions || !Array.isArray(e.permissions) || e.permissions.length === 0)
    return "Missing or empty field: permissions";
  if (!e.expiration) return "Missing field: expiration";
  const r = /* @__PURE__ */ new Set(["read", "write", "delete", "delegate"]);
  for (const t of e.permissions)
    if (!r.has(t))
      return `Invalid permission: "${t}"`;
  return null;
}
export {
  D as c,
  $ as d,
  b as e,
  w as v
};
