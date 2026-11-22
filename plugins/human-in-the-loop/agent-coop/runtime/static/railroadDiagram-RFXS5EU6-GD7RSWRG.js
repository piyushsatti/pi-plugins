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
import {
  createRailroadServices
} from "./chunk-CTPRYFN5.js";
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
import "./chunk-R2LRVZHU.js";
import {
  log
} from "./chunk-M3END4QZ.js";
import {
  __name
} from "./chunk-UEB47VSI.js";
import "./chunk-G3PMV62Z.js";

// node_modules/mermaid/dist/chunks/mermaid.core/railroadDiagram-RFXS5EU6.mjs
var langiumParser = createRailroadServices().Railroad.parser.LangiumParser;
var transformExpression = /* @__PURE__ */ __name((expr) => {
  switch (expr.$type) {
    case "RailroadTerminalExpr":
      return {
        type: "terminal",
        value: expr.value
      };
    case "RailroadNonTerminalExpr":
      return {
        type: "nonterminal",
        name: expr.name
      };
    case "RailroadSpecialExpr":
      return {
        type: "special",
        text: expr.text
      };
    case "RailroadSequenceExpr": {
      const elements = expr.elements.map(transformExpression);
      return elements.length === 1 ? elements[0] : { type: "sequence", elements };
    }
    case "RailroadChoiceExpr": {
      const alternatives = expr.alternatives.map(transformExpression);
      return alternatives.length === 1 ? alternatives[0] : { type: "choice", alternatives };
    }
    case "RailroadOptionalExpr":
      return {
        type: "optional",
        element: transformExpression(expr.element)
      };
    case "RailroadOneOrMoreExpr":
      return {
        type: "repetition",
        element: transformExpression(expr.element),
        min: 1,
        max: Infinity
      };
    case "RailroadZeroOrMoreExpr":
      return {
        type: "repetition",
        element: transformExpression(expr.element),
        min: 0,
        max: Infinity
      };
    default:
      throw new Error(`Unsupported railroad expression: ${expr.$type}`);
  }
}, "transformExpression");
var transformRule = /* @__PURE__ */ __name((rule) => {
  return {
    name: rule.name,
    definition: transformExpression(rule.definition)
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
    log.debug("[Railroad Parser] Starting Langium parse");
    const result = langiumParser.parse(input);
    if (result.lexerErrors.length > 0 || result.parserErrors.length > 0) {
      throw new MermaidParseError(result);
    }
    const ast = result.value;
    log.debug("[Railroad Parser] Parsed rules:", ast.rules.length);
    populateDb(ast);
    log.debug("[Railroad Parser] Parse complete");
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
var railroadDiagram_default = diagram;
export {
  railroadDiagram_default as default,
  diagram
};
//# sourceMappingURL=railroadDiagram-RFXS5EU6-GD7RSWRG.js.map
