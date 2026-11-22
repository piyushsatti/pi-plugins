// <session-list-view> (route: /) — A1. The session list is read-only: there is
// no create-session endpoint in the contract (SEC-2), so sessions arrive from
// the engine and this view never makes one.
// With `data-session-id` set (route /session/:id) it lists that session's
// documents plus the session's open-comment count, which is the way into a
// document view — and it CAN add a document there (ENTRY-1), because
// `POST /api/sessions/:id/docs` names no path.
import { MAX_TITLE_LEN, SESSION_STATES } from "../contract.gen.js";
import { api } from "../lib/api.js";

/**
 * The one place a session state becomes words for a human.
 *
 * The keys are checked against the contract's own enum at module load (B2/CQ5):
 * a state added to `SessionStateSchema` and not given words here is an error the
 * moment anything imports this view, rather than a raw `CLAUDE_REVIEWING`
 * appearing in the UI.
 */
const STATE_LABELS = {
  USER_EDITING: "your turn",
  SUBMITTED: "submitted — waiting on Claude",
  CLAUDE_TURN: "Claude is working",
};

for (const state of SESSION_STATES) {
  if (STATE_LABELS[state] === undefined) {
    throw new Error(`session state ${state} has no label in web/src/views/session-list.js`);
  }
}

export function stateLabel(state) {
  return STATE_LABELS[state] ?? state ?? "";
}

export class SessionListView extends HTMLElement {
  /** See <document-view>: `ready` is the awaitable the DOM does not give us. */
  connectedCallback() {
    this.ready = this.dataset.sessionId
      ? this.renderDocs(this.dataset.sessionId)
      : this.renderSessions();
  }

  async renderSessions() {
    this.innerHTML = `<h1>agent-coop</h1><ul class="sessions" aria-label="Sessions"></ul>`;
    let sessions = [];
    try {
      ({ sessions } = await api.sessions());
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
      return;
    }
    const list = this.querySelector(".sessions");
    if (sessions.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "no sessions yet";
      list.appendChild(empty);
      return;
    }
    for (const session of sessions) {
      const li = document.createElement("li");
      li.className = "session-card";
      li.dataset.state = session.state ?? "";
      const link = document.createElement("a");
      link.href = `/session/${session.id}`;
      link.textContent = session.title;
      link.dataset.route = "";
      li.appendChild(link);
      const state = document.createElement("span");
      state.className = "state";
      // The state is carried by a word, never by colour alone (ui-design
      // §Accessibility).
      state.textContent = stateLabel(session.state);
      li.appendChild(state);
      list.appendChild(li);
    }
  }

  /**
   * The session's documents, re-read and PATCHED (never rebuilt).
   *
   * Two bugs lived in the rebuild this replaces, and both came from the same
   * `this.innerHTML = …` at the top:
   *
   *  - DUPLICATED ROWS. `addDoc` re-reads the list and the `doc_added` frame that
   *    same write broadcasts re-reads it again, so two runs are always in flight
   *    together. Each reset the subtree, then awaited, then APPENDED — so both
   *    appended, and the list showed every document twice. The list is now keyed
   *    by `doc_id`: a second run finds the row it would have added and updates it
   *    instead, which makes concurrent runs idempotent rather than merely rarer.
   *  - THE FORM WAS EATEN MID-TYPING. The add-document form lives in this same
   *    subtree, so any SSE frame arriving while the user was typing replaced the
   *    input under them and their title was gone. The shell — heading, status
   *    line, form — is built ONCE by `mountShell` and never rebuilt; only the
   *    `<ul>` is patched.
   */
  async renderDocs(session_id) {
    this.mountShell(session_id);
    let data;
    try {
      data = await api.session(session_id);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
      return;
    }
    this.querySelector("h1").textContent = data.session.title;
    const open = data.comments.length;
    this.querySelector(".state").textContent =
      `${stateLabel(data.session.state)} · ${open} open comment${open === 1 ? "" : "s"}`;
    this.patchDocs(session_id, data.docs, data.comments);
  }

  /** Everything that is not the list, built once. Live form state (a half-typed
   *  title, focus, the disabled button) survives every later refresh because
   *  nothing rebuilds it. */
  mountShell(session_id) {
    if (this.querySelector(".add-doc") !== null) return;
    this.innerHTML = `
      <h1></h1>
      <p class="state" role="status"></p>
      <ul class="docs" aria-label="Documents"></ul>
      <form class="add-doc">
        <label for="add-doc-title">New document</label>
        <input id="add-doc-title" name="title" type="text" required
               maxlength="${MAX_TITLE_LEN}" placeholder="Document title">
        <button type="submit">Add document</button>
      </form>
      <a href="/" data-route>all sessions</a>`;
    this.querySelector(".add-doc").addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.ready = this.addDoc(session_id);
    });
  }

  /**
   * The list, made to match the server's answer: one row per `doc_id`, in the
   * server's order, rows that no longer exist removed. Re-appending a row that is
   * already there MOVES it rather than copying it, so ordering is applied the
   * same way whether the row is new or old.
   */
  patchDocs(session_id, docs, comments) {
    const list = this.querySelector(".docs");
    const seen = new Set();
    for (const doc of docs) {
      seen.add(doc.id);
      let li = list.querySelector(`li[data-doc-id="${CSS.escape(doc.id)}"]`);
      if (li === null) {
        li = document.createElement("li");
        li.dataset.docId = doc.id;
        const link = document.createElement("a");
        link.className = "doc-link";
        link.href = `/session/${session_id}/doc/${doc.id}`;
        link.dataset.route = "";
        li.appendChild(link);
      }
      li.querySelector(".doc-link").textContent = doc.title;

      const anchored = comments.filter((c) => c.doc_id === doc.id && c.anchor !== null).length;
      let badge = li.querySelector(".badge");
      if (anchored === 0) {
        badge?.remove();
      } else {
        if (badge === null) {
          badge = document.createElement("span");
          badge.className = "badge";
          li.appendChild(badge);
        }
        badge.textContent = `${anchored} anchored`;
      }
      list.appendChild(li);
    }
    for (const li of [...list.children]) {
      if (!seen.has(li.dataset.docId)) li.remove();
    }
  }

  /**
   * The user's way to add a document (A1, ENTRY-1). Until this control existed,
   * `POST /api/sessions/:id/docs` was reachable only from `agent_coop_add_doc`, so a
   * session could grow a document only when Claude said so.
   *
   * It names no path and mints no id — the server does both (SEC-2). It also
   * names no BLOCKS: `blocks` is omitted, exactly as the MCP shim omits it, so
   * the contract's `STARTER_BLOCKS` default is what answers "how many blocks does
   * a new document start with" (ENTRY-1). This view used to carry its own copy of
   * that array, which made three places state the same rule.
   *
   * The list is re-read rather than guessed at: the user who just pressed the
   * button should see the row without waiting for the round trip through SSE, and
   * `onSse` re-reads it again for the `doc_added` frame this same write
   * broadcasts. Both reads land in `patchDocs`, which is keyed by `doc_id`, so
   * the two of them racing produces one row.
   */
  async addDoc(session_id) {
    const input = this.querySelector("#add-doc-title");
    const title = input.value.trim();
    if (title === "") return;
    const button = this.querySelector(".add-doc button");
    button.disabled = true;
    try {
      await api.addDoc(session_id, { title });
      input.value = "";
    } catch (err) {
      // Loud, never silently retried (ui-design §State management).
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
      return;
    } finally {
      button.disabled = false;
    }
    await this.renderDocs(session_id);
  }

  /** A document can join the session while this list is open (A1, PI-2), so the
   *  list is re-read: one fetch, and the server owns the ordering. What the frame
   *  must NOT do is rebuild the view — the add-document form is in it, and the
   *  frame can arrive while the user is typing a title into it. */
  onSse(name, data) {
    if (name !== "doc_added") return;
    if (this.dataset.sessionId === undefined || data.session_id !== this.dataset.sessionId) return;
    this.ready = this.renderDocs(this.dataset.sessionId);
  }
}

customElements.define("session-list-view", SessionListView);
