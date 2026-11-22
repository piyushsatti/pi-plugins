// <agent-coop-app> — bootstrap, the one SSE subscription, and the pushState router.
// Three routes, no routing framework (ui-design §Build).
import { connect } from "./lib/sse.js";
import "./views/session-list.js";
import "./views/document.js";
import "./views/turn-diff.js";
import "./components/mermaid-block.js";

/**
 * Whether a `revision_created` frame should yank the open view into the diff.
 *
 * ui-design is explicit that only the submitted-and-now-revised document
 * flips: submit is session-scoped, but a revision is per-document, and a user
 * mid-edit on a second doc in the same session must not be pulled out of it.
 * `touched` is the set of doc_ids the turn's `apply_progress` frames named — a
 * turn that only answered comments touches nothing and navigates nowhere.
 *
 * Pure, so the rule is testable without a browser or a stream.
 */
export function shouldAutoNavigate(route, data, touched) {
  if (route?.view !== "document") return false;
  if (data.session_id !== route.session_id) return false;
  return touched.has(route.doc_id);
}

/** Pathname -> view descriptor. Pure, so it is testable without a browser. */
export function parseRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { view: "sessions" };
  if (parts[0] !== "session") return { view: "sessions" };
  if (parts.length === 2) return { view: "session", session_id: parts[1] };
  if (parts.length === 4 && parts[2] === "doc") {
    return { view: "document", session_id: parts[1], doc_id: parts[3] };
  }
  if (parts.length === 6 && parts[2] === "doc" && parts[4] === "diff") {
    return {
      view: "diff",
      session_id: parts[1],
      doc_id: parts[3],
      revision_id: decodeURIComponent(parts[5]),
    };
  }
  return { view: "sessions" };
}

export class AgentCoopApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<div class="toast" role="alert" hidden></div><div class="outlet"></div>`;
    this.outlet = this.querySelector(".outlet");
    /** doc_ids Claude has written to since the last revision landed. */
    this.touched = new Set();

    this.addEventListener("agent-coop-error", (ev) => this.toast(ev.detail));
    document.addEventListener("click", (ev) => {
      const link = ev.target.closest?.("a[data-route]");
      if (link === null || link === undefined) return;
      ev.preventDefault();
      this.navigate(link.getAttribute("href"));
    });
    window.addEventListener("popstate", () => this.render());

    // Same-origin in the browser; a test drives a real server on another port.
    this.sse = connect((name, data) => this.onSse(name, data), this.dataset.sseUrl || "/api/events");
    this.render();
  }

  /** One app, one stream: an app removed from the page must not leave a
   *  connection open behind it. */
  disconnectedCallback() {
    this.sse?.close();
    this.sse = null;
  }

  navigate(path) {
    history.pushState({}, "", path);
    this.render();
  }

  render() {
    const route = parseRoute(location.pathname);
    this.outlet.textContent = "";
    let el;
    if (route.view === "sessions") {
      el = document.createElement("session-list-view");
    } else if (route.view === "session") {
      el = document.createElement("session-list-view");
      el.dataset.sessionId = route.session_id;
    } else if (route.view === "document") {
      el = document.createElement("document-view");
      el.dataset.sessionId = route.session_id;
      el.dataset.docId = route.doc_id;
    } else {
      el = document.createElement("turn-diff-view");
      el.dataset.sessionId = route.session_id;
      el.dataset.docId = route.doc_id;
      el.dataset.to = route.revision_id;
      // `from` is deliberately not sent: the server picks the base — the user's
      // last submit at or before `to` (PI-1) — and the client must not invent
      // one, even though it can now list revisions (PI-5).
      //
      // The summary is a first-paint convenience only: this Map is whatever this
      // page happened to receive on the stream, and it dies with the page. The
      // view re-reads the stored summary from the server (PI-5), which is what
      // survives a reload.
      el.dataset.turnSummary = this.summaries?.get(route.revision_id) ?? "";
    }
    this.route = route;
    this.current = el;
    this.outlet.appendChild(el);
  }

  onSse(name, data) {
    // Which docs this turn actually wrote to, so the revision that follows
    // knows whether the open view is the one that changed.
    if (name === "apply_progress") this.touched.add(data.doc_id);

    if (name === "revision_created") {
      (this.summaries ??= new Map()).set(data.revision_id, data.turn_summary);
      const go = shouldAutoNavigate(this.route, data, this.touched);
      this.touched = new Set();
      if (go) {
        this.navigate(
          `/session/${this.route.session_id}/doc/${this.route.doc_id}` +
            `/diff/${encodeURIComponent(data.revision_id)}`,
        );
        return;
      }
    }
    this.current?.onSse?.(name, data);
  }

  toast(err) {
    const el = this.querySelector(".toast");
    el.hidden = false;
    el.textContent = err?.body?.error ?? err?.message ?? String(err);
    setTimeout(() => {
      el.hidden = true;
    }, 6000);
  }
}

customElements.define("agent-coop-app", AgentCoopApp);
