const w = /* @__PURE__ */ new Set([
  "attestation",
  "verification",
  "contact",
  "space",
  "item"
]);
function a(t, e, o) {
  return o ? `wot:${t}:${e}/${o}` : `wot:${t}:${e}`;
}
function f(t) {
  if (!t.startsWith("wot:"))
    throw new Error(`Invalid ResourceRef: must start with "wot:" — got "${t}"`);
  const e = t.slice(4), o = e.indexOf(":");
  if (o === -1)
    throw new Error(`Invalid ResourceRef: missing type — got "${t}"`);
  const n = e.slice(0, o);
  if (!w.has(n))
    throw new Error(`Invalid ResourceRef: unknown type "${n}" — got "${t}"`);
  const s = e.slice(o + 1);
  if (!s)
    throw new Error(`Invalid ResourceRef: missing id — got "${t}"`);
  const i = s.indexOf("/");
  if (i === -1)
    return { type: n, id: s };
  const r = s.slice(0, i), c = s.slice(i + 1);
  return { type: n, id: r, subPath: c };
}
export {
  a as createResourceRef,
  f as parseResourceRef
};
