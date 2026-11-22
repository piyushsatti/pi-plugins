import {
  db,
  getStyles,
  renderer
} from "./chunk-3WAQDBCW.js";
import {
  populateCommonDb
} from "./chunk-MBDTP6V4.js";
import {
  MermaidParseError
} from "./chunk-RTY455YU.js";
import "./chunk-LYHCL3XD.js";
import "./chunk-L5YNTSUJ.js";
import "./chunk-FIOBYBG6.js";
import "./chunk-LWUDAKMK.js";
import "./chunk-CTPRYFN5.js";
import "./chunk-HHZRGWST.js";
import {
  createRailroadAbnfServices
} from "./chunk-WPYH4SDG.js";
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
import "./chunk-R2LRVZHU.js";
import {
  log
} from "./chunk-M3END4QZ.js";
import {
  __name
} from "./chunk-UEB47VSI.js";
import "./chunk-G3PMV62Z.js";

// node_modules/mermaid/dist/chunks/mermaid.core/abnfDiagram-VRR7QNED.mjs
var langiumParser = createRailroadAbnfServices().RailroadAbnf.parser.LangiumParser;
var transformAlternation = /* @__PURE__ */ __name((alt) => {
  const alternatives = alt.alternatives.map(transformConcatenation);
  if (alternatives.length === 1) {
    return alternatives[0];
  }
  return {
    type: "choice",
    alternatives
  };
}, "transformAlternation");
var transformConcatenation = /* @__PURE__ */ __name((concat) => {
  const elements = concat.elements.map(transformElement);
  if (elements.length === 1) {
    return elements[0];
  }
  return {
    type: "sequence",
    elements
  };
}, "transformConcatenation");
var parseRepeat = /* @__PURE__ */ __name((repeat) => {
  if (repeat.includes("*")) {
    const [minStr, maxStr] = repeat.split("*");
    const min = minStr ? parseInt(minStr, 10) : 0;
    const max = maxStr ? parseInt(maxStr, 10) : Infinity;
    return { min, max };
  }
  const exact = parseInt(repeat, 10);
  return { min: exact, max: exact };
}, "parseRepeat");
var transformElement = /* @__PURE__ */ __name((element) => {
  const inner = transformPrimary(element.primary);
  if (!element.repeat) {
    return inner;
  }
  const { min, max } = parseRepeat(element.repeat);
  if (min === 0 && max === 1) {
    return { type: "optional", element: inner };
  }
  return {
    type: "repetition",
    element: inner,
    min,
    max
  };
}, "transformElement");
var transformPrimary = /* @__PURE__ */ __name((primary) => {
  switch (primary.$type) {
    case "AbnfStringLiteral":
      return {
        type: "terminal",
        value: primary.value
      };
    case "AbnfNumVal":
      return {
        type: "terminal",
        value: primary.value
      };
    case "AbnfRuleName":
      return {
        type: "nonterminal",
        name: primary.name
      };
    case "AbnfGroup":
      return transformAlternation(primary.element);
    case "AbnfOptionalGroup":
      return {
        type: "optional",
        element: transformAlternation(primary.element)
      };
    default:
      throw new Error(`Unsupported ABNF primary node: ${primary.$type}`);
  }
}, "transformPrimary");
var transformRule = /* @__PURE__ */ __name((rule) => {
  return {
    name: rule.name,
    definition: transformAlternation(rule.definition)
  };
}, "transformRule");
var populateDb = /* @__PURE__ */ __name((ast) => {
  populateCommonDb(ast, db);
  if (ast.title) {
    db.setTitle(ast.title);
  }
  ast.rules.map((rule) => db.addRule(transformRule(rule)));
}, "populateDb");
var parser = {
  parse: /* @__PURE__ */ __name((input) => {
    db.clear();
    log.debug("[ABNF Parser] Starting Langium parse");
    const result = langiumParser.parse(input);
    if (result.lexerErrors.length > 0 || result.parserErrors.length > 0) {
      throw new MermaidParseError(result);
    }
    const ast = result.value;
    log.debug("[ABNF Parser] Parsed rules:", ast.rules.length);
    populateDb(ast);
    log.debug("[ABNF Parser] Parse complete");
  }, "parse"),
  parser: {
    yy: db
  }
};
var diagram = {
  parser,
  db,
  renderer,
  styles: getStyles
};
export {
  diagram
};
//# sourceMappingURL=abnfDiagram-VRR7QNED-V55SXZFA.js.map
