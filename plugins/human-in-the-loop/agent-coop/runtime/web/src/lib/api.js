// Fetch wrappers, one per endpoint the P5 slice uses. Field names are
// contract-design's (seam authority); this file never invents a shape.
// Every non-2xx body is the server's `McpToolError`, surfaced as a thrown
// Error carrying `.status` and `.body` so callers can toast it loudly
// (ui-design §State management: failures are loud, never silently retried).

const JSON_HEADERS = { "content-type": "application/json" };

// In the browser the bundle is served by the same process as the API, so a
// relative path is correct and `base` stays "". Tests drive these same
// wrappers against a real socket, which needs an absolute origin.
let base = "";

/** @param {string} origin — "" for same-origin, else e.g. "http://localhost:4317" */
export function setBaseUrl(origin) {
  base = origin.replace(/\/$/, "");
}

export class ApiError extends Error {
  /**
   * `body.error` FIRST: the server's refusal shape is the contract's
   * `McpToolError` (`{ error, state, retry_after_submit }`) and it has no
   * `message` field, so reading `message` first meant every toast said
   * "HTTP 409" where the server had said why. `message` is still read for the
   * non-JSON fallback `request()` builds below.
   */
  constructor(status, body) {
    super(body?.error ?? body?.message ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  // reads
  sessions: () => request("GET", "/api/sessions"),
  session: (id) => request("GET", `/api/sessions/${encodeURIComponent(id)}`),
  doc: (id, revision) =>
    request(
      "GET",
      `/api/docs/${encodeURIComponent(id)}` +
        (revision ? `?revision=${encodeURIComponent(revision)}` : ""),
    ),
  /** `all` includes resolved comments — the drawer's resolved section needs
   *  them; every other caller wants the open set. */
  comments: (doc_id, all = false) =>
    request(
      "GET",
      `/api/comments?doc_id=${encodeURIComponent(doc_id)}${all ? "&status=all" : ""}`,
    ),
  diff: (doc_id, from, to) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const s = q.toString();
    return request("GET", `/api/diff/${encodeURIComponent(doc_id)}${s ? `?${s}` : ""}`);
  },
  /** Every past turn on this document, newest first (PI-5). Each entry's `id`
   *  goes straight back as the `to` of `diff()`; the base is the server's to
   *  pick, so nothing here computes a `from`. */
  revisions: (doc_id) => request("GET", `/api/revisions/${encodeURIComponent(doc_id)}`),
  /**
   * A revision's narration audio — a URL, not a fetch. Every other read above
   * goes through `request()`, which throws `ApiError` on a non-2xx status, but
   * a 404 here is the ORDINARY case (no note was asked for, or the render is
   * still in flight or failed) rather than a fault, so this deliberately does
   * not call `request()` at all: there is no promise to reject and nothing for
   * a caller to forget to catch. The caller points an `<audio>` element's
   * `src` at the string directly and reads the element's own `loadedmetadata`
   * / `error` events, the same way an `<img src>` would.
   * @param {string} doc_id
   * @param {string} revision — the label `?revision=` accepts, same as `to`.
   */
  narrationUrl: (doc_id, revision) =>
    `${base}/api/narration/${encodeURIComponent(doc_id)}?revision=${encodeURIComponent(revision)}`,

  // writes
  /**
   * Add a document to an existing session (A1, PI-2). `blocks` is the starting
   * markdown, one string per block; the server mints the doc_id and the
   * block_ids. Nothing here names a path — the browser never may (SEC-2).
   *
   * `blocks` is OMITTED when the caller omitted it, never sent as `[]`, exactly
   * as src/mcp/tools.ts omits it: the contract's `STARTER_BLOCKS` default is then
   * what decides how many blocks a new document starts with, rather than being
   * talked past by a value that happens to normalize to the same thing.
   * @param {string} session_id
   * @param {{ title: string, blocks?: string[] }} input
   */
  addDoc: (session_id, { title, blocks }) =>
    request(
      "POST",
      `/api/sessions/${encodeURIComponent(session_id)}/docs`,
      blocks === undefined ? { title } : { title, blocks },
    ),
  /**
   * Anchored selection comment: the contract's `CommentCreateRaw`. The
   * client sends RENDERED offsets; the server owns the mapping (D4).
   *
   * `audio`, when given, is voice INPUT riding along (src/contract/comment.ts
   * `CommentAudioSchema`), never the comment itself. It is always sent as
   * `null` rather than omitted when there is none, matching every other
   * optional field on this call: one shape, not two.
   * @param {{ doc_id: string, block_id: string, rendered_offsets: [number, number],
   *           quoted_text: string, text: string, delivery?: string,
   *           audio?: { pcm_b64: string, sample_rate: number } | null }} input
   */
  createSelectionComment: ({
    doc_id,
    block_id,
    rendered_offsets,
    quoted_text,
    text,
    delivery,
    audio,
  }) =>
    request("POST", "/api/comments", {
      doc_id,
      block_id,
      rendered_offsets,
      quoted_text,
      text,
      delivery: delivery ?? "queued",
      audio: audio ?? null,
    }),
  /**
   * Whole-document comment (A4): same endpoint, `anchor: null`. `audio` is
   * the same voice-input field as `createSelectionComment` above.
   * @param {{ doc_id: string, text: string, delivery?: "interrupt" | "queued" | "ambient",
   *           parent_id?: string | null,
   *           audio?: { pcm_b64: string, sample_rate: number } | null }} input
   */
  createGlobalComment: ({ doc_id, text, delivery, parent_id, audio }) =>
    request("POST", "/api/comments", {
      doc_id,
      anchor: null,
      text,
      delivery: delivery ?? "queued",
      parent_id: parent_id ?? null,
      audio: audio ?? null,
    }),
  /**
   * A reply is a NEW comment row carrying `parent_id`, never a mutation.
   * `audio` is the same voice-input field as above (src/contract/comment.ts
   * `CommentAudioSchema`, wired into `ReplySchema` in src/server/routes/write.ts).
   * @param {string} id
   * @param {string} text
   * @param {{ pcm_b64: string, sample_rate: number } | null} [audio]
   */
  replyComment: (id, text, audio) =>
    request("POST", `/api/comments/${encodeURIComponent(id)}/reply`, {
      text,
      audio: audio ?? null,
    }),
  resolveComment: (id) => request("POST", `/api/comments/${encodeURIComponent(id)}/resolve`, {}),
  /** One committed block edit — one `user_edit` event. USER_EDITING only; any
   *  other state comes back 409 with the `McpToolError` shape, by design. */
  patchBlocks: (doc_id, ops) =>
    request("PATCH", `/api/blocks/${encodeURIComponent(doc_id)}`, { ops }),
  submit: (session_id) => request("POST", "/api/submit", { session_id }),
  /** Take the document back from a turn (PI-4): SUBMITTED or CLAUDE_TURN ->
   *  USER_EDITING. From USER_EDITING the server answers 409 — the control is
   *  disabled there, and the state check is the engine's either way. */
  cancel: (session_id) => request("POST", "/api/cancel", { session_id }),
  /** Export the document's markdown (A8). No path: the server names the file
   *  and lands it in the project's artifacts/ directory, then tells us where
   *  — the toolbar's job is to report that, not to choose it. */
  exportDoc: (doc_id, path) =>
    request("POST", `/api/export/${encodeURIComponent(doc_id)}`, path ? { path } : {}),
};
