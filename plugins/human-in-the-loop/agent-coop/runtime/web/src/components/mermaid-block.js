// <mermaid-block source="graph TD…"> — a ```mermaid fence, drawn (A9).
//
// mermaid is reached by a DYNAMIC import() and never a static one, which is the
// whole arrangement: esbuild splits it into its own chunk (scripts/build.ts sets
// `splitting`), so the first bytes the page loads do not carry a diagram library,
// and mermaid itself then loads only the grammar for the diagram type in the
// fence. A static import would put ~1MB in front of every page for a feature most
// documents do not use.
//
// The element is the seam: lib/render.js decides that a fence IS a diagram and
// puts the source in an attribute; this file is the only thing that knows the
// library exists.

/**
 * The two calls this element makes, which is all a stand-in has to answer.
 *
 * Stated as a type rather than left to inference off `import("mermaid")`: the
 * whole library's surface would otherwise be the contract, and a DOM test would
 * have to fake eleven methods nothing calls.
 *
 * @typedef {{
 *   initialize: (config: { startOnLoad: boolean, securityLevel: string }) => void,
 *   render: (id: string, source: string) => Promise<{ svg: string }>,
 * }} MermaidLike
 */

/**
 * How the library is reached, kept in one indirect place so a DOM test can drive
 * this element without a headless browser: mermaid measures rendered text to lay
 * a diagram out, which happy-dom does not do. The DEFAULT is the dynamic
 * import() that makes the chunk — tests/scripts/test_build.test.ts asserts the
 * chunk exists, which is the evidence that this stayed lazy.
 *
 * @type {{ load: () => Promise<MermaidLike> }}
 */
export const mermaidLoader = {
  load: () => import("mermaid").then((m) => m.default),
};

/** Ids must be unique per render call; mermaid uses them for its own `defs`. */
let seq = 0;

export class MermaidBlock extends HTMLElement {
  connectedCallback() {
    // Draw once per ELEMENT. `connectedCallback` fires again on every
    // re-connection, so an element that is moved rather than remade would redraw:
    // a second mermaid parse of the same source, replacing a good SVG with an
    // identical one.
    //
    // No caller in web/src moves one today, and the comment that used to be here
    // said otherwise — it named `renderBlocks` and `patchBlock`, which do the
    // opposite. Both rebuild DOM from markdown, so the element they produce is a
    // NEW one that has never drawn, and the highlight painter only re-parents the
    // text nodes inside a `<mark>` (selection-layer.js `unwrapMarks`), which a
    // diagram is never in. The guard is therefore about what this element
    // GUARANTEES, not about a caller: re-connect it however you like and it draws
    // once. tests/web/test_render.test.ts re-appends it by hand to hold that.
    if (this.dataset.rendered !== undefined) return;
    this.dataset.rendered = "";
    /** Resolves when the diagram has been drawn or has failed — the awaitable the
     *  DOM does not give us, same arrangement as `<document-view>.ready`. */
    this.drawn = this.draw();
  }

  async draw() {
    const source = this.getAttribute("source") ?? "";
    // The source is what the user typed: it is what shows while the chunk is in
    // flight, and what stays if the diagram will not parse.
    this.showSource(source);
    if (source.trim() === "") return;
    try {
      const mermaid = await mermaidLoader.load();
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const { svg } = await mermaid.render(`mermaid-${++seq}`, source);
      // mermaid's own sanitiser produced this string (securityLevel strict).
      this.innerHTML = svg;
      delete this.dataset.error;
    } catch (err) {
      // A diagram that will not draw must still show its source: it is the
      // user's own text, and dropping it would lose content the log holds.
      this.dataset.error = String(err?.message ?? err);
      this.showSource(source);
    }
  }

  /** The fence as a plain code block — the same container as any other fence. */
  showSource(source) {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    const code = document.createElement("code");
    code.textContent = source;
    pre.appendChild(code);
    this.replaceChildren(pre);
  }
}

customElements.define("mermaid-block", MermaidBlock);
