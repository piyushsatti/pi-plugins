// <turn-summary> — Claude's own words for the revision being viewed
// (ui-design §Turn-diff view: "so the user doesn't have to tab back to chat to
// know why something changed"). It carries the `turn_summary` from the
// `snapshot` event, delivered to the browser on the `revision_created` SSE
// frame; this component never fetches it.
export class TurnSummary extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", "note");
    this.render();
  }

  /** @param {string} text */
  set summary(text) {
    this._summary = text;
    if (this.isConnected) this.render();
  }

  get summary() {
    return this._summary ?? this.dataset.turnSummary ?? "";
  }

  render() {
    const text = this.summary;
    this.innerHTML = `
      <h2>Claude's summary of this turn</h2>
      <p class="summary"></p>`;
    const p = this.querySelector(".summary");
    if (text === "") {
      p.textContent = "no summary was recorded for this revision";
      p.classList.add("empty");
    } else {
      p.textContent = text;
    }
  }
}

customElements.define("turn-summary", TurnSummary);
