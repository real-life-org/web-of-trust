const a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function l(t) {
  const e = [0];
  for (const i of t) {
    let r = i;
    for (let o = 0; o < e.length; o++)
      r += e[o] << 8, e[o] = r % 58, r = r / 58 | 0;
    for (; r > 0; )
      e.push(r % 58), r = r / 58 | 0;
  }
  let n = "";
  for (const i of t)
    if (i === 0) n += a[0];
    else break;
  for (let i = e.length - 1; i >= 0; i--) n += a[e[i]];
  return n;
}
function d(t) {
  const e = [0];
  for (const n of t) {
    const i = a.indexOf(n);
    if (i < 0) throw new Error(`Invalid base58 character: ${n}`);
    let r = i;
    for (let o = 0; o < e.length; o++)
      r += e[o] * 58, e[o] = r & 255, r >>= 8;
    for (; r > 0; )
      e.push(r & 255), r >>= 8;
  }
  for (const n of t)
    if (n === a[0]) e.push(0);
    else break;
  return new Uint8Array(e.reverse());
}
function b(t) {
  let e = "";
  for (let n = 0; n < t.length; n++) e += String.fromCharCode(t[n]);
  return btoa(e).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function g(t) {
  const e = t.replace(/-/g, "+").replace(/_/g, "/"), n = e + "=".repeat((4 - e.length % 4) % 4), i = atob(n);
  return Uint8Array.from(i, (r) => r.charCodeAt(0));
}
const s = new Uint8Array([237, 1]), c = new Uint8Array([236, 1]);
function p(t) {
  return `did:key:${u(t)}`;
}
function u(t) {
  const e = new Uint8Array(s.length + t.length);
  return e.set(s), e.set(t, s.length), `z${l(e)}`;
}
function w(t) {
  const e = new Uint8Array(c.length + t.length);
  return e.set(c), e.set(t, c.length), `z${l(e)}`;
}
function f(t) {
  return t.split("#", 1)[0];
}
function h(t) {
  const e = f(t);
  if (!e.startsWith("did:key:z")) throw new Error("Expected did:key");
  return y(`z${e.slice(9)}`);
}
function y(t) {
  if (!t.startsWith("z")) throw new Error("Expected base58btc multibase key");
  const e = d(t.slice(1));
  if (e[0] !== s[0] || e[1] !== s[1])
    throw new Error("Expected Ed25519 multibase key");
  return e.slice(s.length);
}
function E(t) {
  if (!t.startsWith("z")) throw new Error("Expected base58btc multibase key");
  const e = d(t.slice(1));
  if (e[0] !== c[0] || e[1] !== c[1])
    throw new Error("Expected X25519 multibase key");
  return e.slice(c.length);
}
function k(t, e = {}) {
  const n = u(h(t)), i = {
    id: t,
    verificationMethod: [
      {
        id: "#sig-0",
        type: "Ed25519VerificationKey2020",
        controller: t,
        publicKeyMultibase: n
      }
    ],
    authentication: ["#sig-0"],
    assertionMethod: ["#sig-0"],
    keyAgreement: e.keyAgreement ?? []
  };
  return e.service && (i.service = e.service), i;
}
export {
  h as a,
  f as b,
  u as c,
  g as d,
  b as e,
  d as f,
  y as g,
  l as h,
  E as i,
  p,
  k as r,
  w as x
};
