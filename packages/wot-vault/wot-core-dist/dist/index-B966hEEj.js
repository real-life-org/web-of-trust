import { g as s } from "./SpaceMetadataStorage-Diby-YzW.js";
function u(e) {
  return {
    getValue: () => e.getValue(),
    subscribe: (t) => {
      let r = !0;
      return e.subscribe((i) => {
        if (r) {
          r = !1;
          return;
        }
        t(i);
      });
    }
  };
}
const n = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  groupKeyId: s,
  skipFirst: u
}, Symbol.toStringTag, { value: "Module" }));
export {
  n as i,
  u as s
};
