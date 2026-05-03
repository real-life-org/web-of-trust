const d = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function w(e) {
  const t = [0];
  for (const o of e) {
    let r = o;
    for (let a = 0; a < t.length; a++)
      r += t[a] << 8, t[a] = r % 58, r = r / 58 | 0;
    for (; r > 0; )
      t.push(r % 58), r = r / 58 | 0;
  }
  let n = "";
  for (const o of e)
    if (o === 0) n += d[0];
    else break;
  for (let o = t.length - 1; o >= 0; o--)
    n += d[t[o]];
  return n;
}
function b(e) {
  const t = [0];
  for (const n of e) {
    const o = d.indexOf(n);
    if (o < 0) throw new Error(`Invalid base58 character: ${n}`);
    let r = o;
    for (let a = 0; a < t.length; a++)
      r += t[a] * 58, t[a] = r & 255, r >>= 8;
    for (; r > 0; )
      t.push(r & 255), r >>= 8;
  }
  for (const n of e)
    if (n === d[0]) t.push(0);
    else break;
  return new Uint8Array(t.reverse());
}
function g(e) {
  let t = "";
  for (let n = 0; n < e.length; n++)
    t += String.fromCharCode(e[n]);
  return btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function i(e) {
  const t = e.replace(/-/g, "+").replace(/_/g, "/"), n = (4 - t.length % 4) % 4, o = t + "=".repeat(n), r = atob(o);
  return Uint8Array.from(r, (a) => a.charCodeAt(0));
}
function v(e) {
  let t = "";
  for (let n = 0; n < e.length; n++)
    t += String.fromCharCode(e[n]);
  return btoa(t);
}
function m(e) {
  const t = atob(e);
  return Uint8Array.from(t, (n) => n.charCodeAt(0));
}
function E(e) {
  return e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength);
}
const s = new Uint8Array([237, 1]);
function A(e) {
  const t = new Uint8Array(s.length + e.length);
  return t.set(s), t.set(e, s.length), `did:key:${"z" + w(t)}`;
}
function B(e) {
  if (!e.startsWith("did:key:z"))
    throw new Error("Invalid did:key format");
  const t = e.slice(9), n = b(t);
  if (n[0] !== s[0] || n[1] !== s[1])
    throw new Error("Invalid multicodec prefix for Ed25519");
  return n.slice(s.length);
}
function S(e) {
  try {
    return e.startsWith("did:key:z") ? (B(e), !0) : !1;
  } catch {
    return !1;
  }
}
function U(e) {
  return e ? `User-${e.slice(-6)}` : "User";
}
async function D(e, t) {
  const n = {
    alg: "EdDSA",
    typ: "JWT"
  }, o = g(
    new TextEncoder().encode(JSON.stringify(n))
  ), r = g(
    new TextEncoder().encode(JSON.stringify(e))
  ), a = `${o}.${r}`, l = new TextEncoder().encode(a), c = await crypto.subtle.sign(
    "Ed25519",
    t,
    l
  ), f = new Uint8Array(c), u = g(f);
  return `${a}.${u}`;
}
async function J(e, t) {
  try {
    const n = e.split(".");
    if (n.length !== 3)
      return { valid: !1, error: "Invalid JWS format" };
    const [o, r, a] = n, l = i(o), c = JSON.parse(new TextDecoder().decode(l));
    if (c.alg !== "EdDSA")
      return { valid: !1, error: `Unsupported algorithm: ${c.alg}` };
    const f = i(r), u = JSON.parse(new TextDecoder().decode(f)), y = i(a), h = `${o}.${r}`, p = new TextEncoder().encode(h);
    return { valid: await crypto.subtle.verify(
      "Ed25519",
      t,
      E(y),
      p
    ), payload: u };
  } catch (n) {
    return {
      valid: !1,
      error: n instanceof Error ? n.message : "Verification failed"
    };
  }
}
function T(e) {
  try {
    const t = e.split(".");
    if (t.length !== 3) return null;
    const n = i(t[1]);
    return JSON.parse(new TextDecoder().decode(n));
  } catch {
    return null;
  }
}
export {
  g as a,
  i as b,
  A as c,
  b as d,
  w as e,
  B as f,
  U as g,
  T as h,
  S as i,
  m as j,
  v as k,
  D as s,
  E as t,
  J as v
};
