import {
  parse
} from "./chunk-RTY455YU.js";
import "./chunk-LYHCL3XD.js";
import {
  selectSvgElement
} from "./chunk-L5YNTSUJ.js";
import "./chunk-FIOBYBG6.js";
import "./chunk-LWUDAKMK.js";
import "./chunk-CTPRYFN5.js";
import "./chunk-HHZRGWST.js";
import "./chunk-WPYH4SDG.js";
import "./chunk-P4GDTN6N.js";
import "./chunk-AMQ2Y333.js";
import "./chunk-466PXVZ2.js";
import "./chunk-3ZRU2PHN.js";
import "./chunk-P7TXEBAV.js";
import "./chunk-Z7LYIIBK.js";
import "./chunk-R7YNNAIR.js";
import "./chunk-IF5YI54R.js";
import "./chunk-KWSFOI5X.js";
import "./chunk-NPEWV2PS.js";
import {
  configureSvgSize
} from "./chunk-R2LRVZHU.js";
import {
  log
} from "./chunk-M3END4QZ.js";
import {
  __name
} from "./chunk-UEB47VSI.js";
import "./chunk-G3PMV62Z.js";

// node_modules/mermaid/dist/chunks/mermaid.core/infoDiagram-FWYZ7A6U.mjs
var parser = {
  parse: /* @__PURE__ */ __name(async (input) => {
    const ast = await parse("info", input);
    log.debug(ast);
  }, "parse")
};
var DEFAULT_INFO_DB = {
  version: "11.16.0" + (true ? "" : "-tiny")
};
var getVersion = /* @__PURE__ */ __name(() => DEFAULT_INFO_DB.version, "getVersion");
var db = {
  getVersion
};
var draw = /* @__PURE__ */ __name((text, id, version) => {
  log.debug("rendering info diagram\n" + text);
  const svg = selectSvgElement(id);
  configureSvgSize(svg, 100, 400, true);
  const group = svg.append("g");
  group.append("text").attr("x", 100).attr("y", 40).attr("class", "version").attr("font-size", 32).style("text-anchor", "middle").text(`v${version}`);
}, "draw");
var renderer = { draw };
var diagram = {
  parser,
  db,
  renderer
};
export {
  diagram
};
//# sourceMappingURL=infoDiagram-FWYZ7A6U-JDYIHZCE.js.map
