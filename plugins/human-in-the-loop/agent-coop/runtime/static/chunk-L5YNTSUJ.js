import {
  getConfig2
} from "./chunk-R2LRVZHU.js";
import {
  select_default
} from "./chunk-M3END4QZ.js";
import {
  __name
} from "./chunk-UEB47VSI.js";

// node_modules/mermaid/dist/chunks/mermaid.core/chunk-VAUOI2AC.mjs
var selectSvgElement = /* @__PURE__ */ __name((id) => {
  const { securityLevel } = getConfig2();
  let root = select_default("body");
  if (securityLevel === "sandbox") {
    const sandboxElement = select_default(`#i${id}`);
    const doc = sandboxElement.node()?.contentDocument ?? document;
    root = select_default(doc.body);
  }
  const svg = root.select(`#${id}`);
  return svg;
}, "selectSvgElement");

export {
  selectSvgElement
};
//# sourceMappingURL=chunk-L5YNTSUJ.js.map
