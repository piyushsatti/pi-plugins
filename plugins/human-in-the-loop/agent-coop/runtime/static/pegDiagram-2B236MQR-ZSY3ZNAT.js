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
import "./chunk-WPYH4SDG.js";
import {
  createRailroadPegServices
} from "./chunk-P4GDTN6N.js";
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

// node_modules/mermaid/dist/chunks/mermaid.core/pegDiagram-2B236MQR.mjs
var langiumParser = createRailroadPegServices().RailroadPeg.parser.LangiumParser;
var transformOrderedChoice = /* @__PURE__ */ __name((choice) => {
  const alternatives = choice.alternatives.map(transformSequence);
  if (alternatives.length === 1) {
    return alternatives[0];
  }
  return {
    type: "choice",
    alternatives
  };
}, "transformOrderedChoice");
var transformSequence = /* @__PURE__ */ __name((sequence) => {
  const elements = sequence.elements.map(transformPrefix);
  if (elements.length === 1) {
    return elements[0];
  }
  return {
    type: "sequence",
    elements
  };
}, "transformSequence");
var transformPrefix = /* @__PURE__ */ __name((prefix) => {
  const inner = transformSuffix(prefix.suffix);
  if (!prefix.operator) {
    return inner;
  }
  const label = prefix.operator === "&" ? `&${nodeToLabel(inner)}` : `!${nodeToLabel(inner)}`;
  return {
    type: "special",
    text: label
  };
}, "transformPrefix");
var nodeToLabel = /* @__PURE__ */ __name((node) => {
  switch (node.type) {
    case "terminal":
      return `"${node.value}"`;
    case "nonterminal":
      return node.name;
    case "special":
      return node.text;
    default:
      return "(...)";
  }
}, "nodeToLabel");
var transformSuffix = /* @__PURE__ */ __name((suffix) => {
  const inner = transformPrimary(suffix.primary);
  if (!suffix.operator) {
    return inner;
  }
  switch (suffix.operator) {
    case "?":
      return { type: "optional", element: inner };
    case "*":
      return { type: "repetition", element: inner, min: 0, max: Infinity };
    case "+":
      return { type: "repetition", element: inner, min: 1, max: Infinity };
    default:
      throw new Error(`Unsupported PEG suffix operator: ${suffix.operator}`);
  }
}, "transformSuffix");
var transformPrimary = /* @__PURE__ */ __name((primary) => {
  switch (primary.$type) {
    case "PegLiteral":
      return {
        type: "terminal",
        value: primary.value
      };
    case "PegIdentifier":
      return {
        type: "nonterminal",
        name: primary.name
      };
    case "PegGroup":
      return transformOrderedChoice(primary.element);
    case "PegAny":
      return {
        type: "special",
        text: primary.dot
      };
    default:
      throw new Error(`Unsupported PEG primary node: ${primary.$type}`);
  }
}, "transformPrimary");
var transformRule = /* @__PURE__ */ __name((rule) => {
  return {
    name: rule.name,
    definition: transformOrderedChoice(rule.definition)
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
    log.debug("[PEG Parser] Starting Langium parse");
    const result = langiumParser.parse(input);
    if (result.lexerErrors.length > 0 || result.parserErrors.length > 0) {
      throw new MermaidParseError(result);
    }
    const ast = result.value;
    log.debug("[PEG Parser] Parsed rules:", ast.rules.length);
    populateDb(ast);
    log.debug("[PEG Parser] Parse complete");
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
//# sourceMappingURL=pegDiagram-2B236MQR-ZSY3ZNAT.js.map
