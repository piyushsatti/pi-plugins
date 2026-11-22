// Read endpoints — contract-design.md §MCP tools table (GET rows) and
// §Additional user-facing HTTP endpoints. Pure reads: none of these appends an
// event, so none of them is state-gated.
import {
  TurnWaitTimeoutSchema,
  contract_version,
  type DiffBase,
  type RevisionList,
  type TurnDiff,
} from "../../contract/index.ts";
import { diffAtSeqs, blocksAt, revisionRowIdForLabel, turnDiff, turnDiffBase } from "../../engine/index.ts";
import { liveComments, liveThread } from "../anchors.ts";
import type { ServerContext } from "../context.ts";
import { fail, json } from "../http.ts";
import { narrationPath } from "../notes.ts";
import { backendFor } from "../../speech/index.ts";
import {
  commentThreadsInRange,
  commentsForDoc,
  commentsForSession,
  documentsForSession,
  getAttachment,
  getDocument,
  getSession,
  listSessions,
  maxSeq,
  pendingSubmit,
  revisionSeqForDoc,
  revisionsForDoc,
  type SubmittedSession,
} from "../queries.ts";
import { withWordDiff } from "../worddiff.ts";

/** When this process came up. Module scope, so it is the process's own start
 *  time and not the time of the first probe. */
const STARTED_AT = new Date().toISOString();

/** GET /api/health — the `/agent-coop` skill's health-check (contract-design
 *  §`/agent-coop` skill, 1). Deliberately trivial: it proves an agent-coop server of a
 *  known contract version owns this port, so the skill can decide to start one
 *  or not without knowing anything else about agent-coop. */
export function health(ctx: ServerContext): Response {
  return json({
    ok: true as const,
    contract_version,
    sessions: listSessions(ctx.db).length,
    db_path: ctx.dbPath,
    started_at: STARTED_AT,
  });
}

export function sessions(ctx: ServerContext): Response {
  return json({ sessions: listSessions(ctx.db), contract_version });
}

export function session(ctx: ServerContext, id: string): Response {
  const s = getSession(ctx.db, id);
  if (s === null) return fail(404, `unknown session ${id}`);
  return json({
    session: s,
    docs: documentsForSession(ctx.db, id),
    comments: liveComments(ctx, commentsForSession(ctx.db, id, true)),
    contract_version,
  });
}

/** GET /api/docs/:id?revision= — current blocks, or the blocks as of a
 *  revision label, reconstructed by replaying updates (D1). */
export function doc(ctx: ServerContext, id: string, url: URL): Response {
  const meta = getDocument(ctx.db, id);
  if (meta === null) return fail(404, `unknown doc ${id}`);
  const revision = url.searchParams.get("revision");
  if (revision !== null) {
    // Same per-document label resolution the diff uses: the SSE payload carries
    // the bare label even when the reducer suffixed it per doc.
    const seq = revisionSeqForDoc(ctx.db, id, revision);
    if (seq === null) return fail(404, `unknown revision ${revision}`);
    return json({ doc: meta, blocks: blocksAt(ctx.db, id, seq), revision, contract_version });
  }
  return json({ doc: meta, blocks: ctx.engine.blocks(id), revision: null, contract_version });
}

/**
 * GET /api/turn/pending?session_id= — is a submit waiting to be pulled?
 * (PI-3, the submit trigger.)
 *
 * The instant answer to the same question `/api/turn/wait` holds open. Pure
 * read: it appends no event and changes no state, and it never consumes the
 * submit it reports — only `POST /api/pull` does.
 *
 * `session_id` is optional because a caller may be watching every session rather
 * than one. Named and unknown is a 404; named and not waiting is
 * `pending: false`, not an error.
 *
 * `submit_seq` rides along so a repeating caller can tell one submit from the
 * next; see TurnPendingSchema.
 */
export function turnPending(ctx: ServerContext, url: URL): Response {
  const wanted = url.searchParams.get("session_id");
  if (wanted !== null && getSession(ctx.db, wanted) === null) {
    return fail(404, `unknown session ${wanted}`);
  }
  return json(answerPending(pendingSubmit(ctx.db, wanted ?? undefined)));
}

/** The one place a `TurnPending` body is built, shared by `pending` and `wait`:
 *  the two answer the same question and a second literal would let their shapes
 *  drift apart. */
function answerPending(submit: SubmittedSession | null) {
  return {
    pending: submit !== null,
    session_id: submit?.session_id ?? null,
    submit_seq: submit?.submit_seq ?? null,
    contract_version,
  };
}

/**
 * GET /api/turn/wait?session_id=&timeout_ms= — the same question as
 * `/api/turn/pending`, held open until it can be answered yes (LOOP-1).
 *
 * This is agent-coop's ONE wake channel, and it is deliberately dumb: it answers a
 * question and holds. Everything that WAITS is on the harness side of the seam —
 * `scripts/watch.ts`, run by the Monitor tool from the `/agent-coop` skill — because a
 * held MCP client request fails the whole tool call with JSON-RPC `-32001`. No
 * `agent_coop_*` tool reaches this route, on purpose (src/mcp/tools.ts).
 *
 * It waits on the broadcaster, not on the database. The submit that matters has
 * already been through `dispatch`, which sends `state_changed` after the commit
 * (src/server/context.ts), so the wake-up is the same event the browser gets and
 * there is no polling loop and no second definition of "a submit happened".
 *
 * Bounded on purpose: `TURN_WAIT_MAX_TIMEOUT_MS` is the ceiling and the caller
 * loops. See TurnWaitTimeoutSchema for why an out-of-range timeout is clamped
 * rather than refused.
 *
 * Still a pure read: it appends no event and consumes nothing, so a wait that
 * returns `pending: true` leaves the submit exactly where `POST /api/pull` can
 * find it.
 */
export async function turnWait(ctx: ServerContext, url: URL, signal?: AbortSignal): Promise<Response> {
  const wanted = url.searchParams.get("session_id");
  if (wanted !== null && getSession(ctx.db, wanted) === null) {
    return fail(404, `unknown session ${wanted}`);
  }
  const timeoutMs = TurnWaitTimeoutSchema.parse(url.searchParams.get("timeout_ms"));
  const answer = () => pendingSubmit(ctx.db, wanted ?? undefined);

  // Already waiting: answer now. Nothing below this line runs in that case, so
  // the common "the user submitted while I was working" path costs one query.
  const now = answer();
  if (now !== null) return json(answerPending(now));

  // No `await` between that read and the subscribe below, and the server is
  // single-threaded, so a submit cannot land in the gap and be missed. Adding a
  // re-check after subscribing would be dead code, not belt-and-braces.
  const submit = await new Promise<SubmittedSession | null>((resolve) => {
    // Not unref'd: an unref'd timer lets the process exit with the request still
    // held open, which is a hung caller rather than a tidy shutdown.
    const timer = setTimeout(() => finish(null), timeoutMs);
    const unsubscribe = ctx.sse.subscribe((event) => {
      if (event.event !== "state_changed" || event.data.to !== "SUBMITTED") return;
      if (wanted !== null && event.data.session_id !== wanted) return;
      // Re-read rather than trusting the frame: the frame says a transition
      // happened, the projection says what is true now. A frame whose submit is
      // already gone by the time we look (pulled or cancelled in between) keeps
      // WAITING rather than answering `pending: false` early — the documented
      // promise is "held open until a submit is visible, or the timeout", and
      // returning false with time left on the clock would break it.
      const found = answer();
      if (found !== null) finish(found);
    });
    // A caller that hung up is not owed an answer, and holding its timer and its
    // listener for the rest of the timeout would let a reconnecting client stack
    // them up. Registered after the two things it has to tear down, so an
    // already-aborted signal cannot fire `finish` before they exist.
    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    function finish(value: SubmittedSession | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve(value);
    }
    if (signal?.aborted === true) finish(null);
  });
  return json(answerPending(submit));
}

export function comments(ctx: ServerContext, url: URL): Response {
  const doc_id = url.searchParams.get("doc_id");
  if (doc_id === null) return fail(400, "doc_id query parameter is required");
  if (getDocument(ctx.db, doc_id) === null) return fail(404, `unknown doc ${doc_id}`);
  const all = url.searchParams.get("status") === "all";
  return json({ comments: liveComments(ctx, commentsForDoc(ctx.db, doc_id, !all)), contract_version });
}

export function attachment(ctx: ServerContext, id: string): Response {
  const a = getAttachment(ctx.db, id);
  if (a === null) return fail(404, `unknown attachment ${id}`);
  return json({ attachment: a, contract_version });
}

/**
 * GET /api/diff/:doc_id?from=&to= — a structural block diff of two
 * reconstructions (D1), with a word-level diff on each modified block. Wire
 * shape: `TurnDiff` in src/contract/diff.ts.
 *
 * `to` is a revision label and defaults to the document's current state.
 *
 * `from` defaults to **the state at the user's most recent submit** (PI-1), not
 * to the previous revision: the question the screen answers is "what changed
 * since I last handed this over", and the base is therefore the last thing the
 * user saw. Before any submit it is the document's own first state, so a fresh
 * import is the base rather than a page of "added". Both actors can have
 * written since, so `turnDiff` attributes each change (`author`).
 *
 * Naming `from` explicitly asks a different question — a plain
 * revision-to-revision comparison — and gets no attribution, because the range
 * it spans is not one the log describes as a turn.
 */
export function diff(ctx: ServerContext, doc_id: string, url: URL): Response {
  const meta = getDocument(ctx.db, doc_id);
  if (meta === null) return fail(404, `unknown doc ${doc_id}`);

  const toLabel = url.searchParams.get("to");
  const to = toLabel === null ? maxSeq(ctx.db, meta.session_id) : revisionSeqForDoc(ctx.db, doc_id, toLabel);
  if (to === null) return fail(404, `unknown revision ${toLabel}`);

  const fromLabel = url.searchParams.get("from");
  let from: number | null;
  let base: DiffBase;
  if (fromLabel !== null) {
    from = revisionSeqForDoc(ctx.db, doc_id, fromLabel);
    base = "explicit";
    if (from === null) return fail(404, `unknown revision ${fromLabel}`);
  } else {
    ({ from_seq: from, base } = turnDiffBase(ctx.db, doc_id, to));
  }

  const payload: TurnDiff = {
    doc_id,
    from_seq: from,
    to_seq: to,
    base,
    diff: withWordDiff(
      base === "explicit"
        ? diffAtSeqs(ctx.db, doc_id, from, to)
        : turnDiff(ctx.db, doc_id, from, to),
    ),
    // PI-7: the turn's conversation, not only its block edits. Empty for an
    // explicit revision-to-revision diff, which is not a turn — see
    // TurnDiffSchema.threads.
    threads:
      base === "explicit"
        ? []
        : commentThreadsInRange(ctx.db, doc_id, from, to).map((t) => liveThread(ctx, t)),
    contract_version,
  };
  return json(payload);
}

/**
 * GET /api/revisions/:doc_id — every past turn on this document, newest first
 * (PI-5). Wire shape: `RevisionList` in src/contract/revision.ts.
 *
 * This is what makes the turn diff re-openable. The summary was always stored by
 * the reducer; the browser just had no way to ask for it, so both the summary and
 * the diff lived only in the page that happened to receive the `revision_created`
 * frame and died with it.
 *
 * Each entry's `id` goes straight back as `?to=` on the diff endpoint. The lower
 * bound is not the client's business: the diff's own base rule (the user's last
 * submit at or before `to`, PI-1) bounds the turn from below, which is why this
 * list carries no `from`.
 */
export function revisions(ctx: ServerContext, doc_id: string): Response {
  if (getDocument(ctx.db, doc_id) === null) return fail(404, `unknown doc ${doc_id}`);
  const payload: RevisionList = {
    doc_id,
    revisions: revisionsForDoc(ctx.db, doc_id),
    contract_version,
  };
  return json(payload);
}

/**
 * GET /api/narration/:doc_id?revision=<label> — the audio rendered from a past
 * turn's note (src/server/notes.ts). A pure read: nothing here appends an
 * event, and the file itself is a cache, not the source of truth.
 *
 * A missing file is the ORDINARY case, not a fault: the render may still be
 * running, may have already failed (the browser was already told why over the
 * `narration_failed` SSE frame), or nobody ever asked for narration on this
 * revision. All three look the same from here — try again later, or don't.
 */
export async function narration(ctx: ServerContext, doc_id: string, url: URL): Promise<Response> {
  if (getDocument(ctx.db, doc_id) === null) return fail(404, `unknown doc ${doc_id}`);
  const label = url.searchParams.get("revision");
  if (label === null) return fail(400, "revision query parameter is required");
  const rowId = revisionRowIdForLabel(ctx.db, doc_id, label);
  if (rowId === null) return fail(404, `unknown revision ${label}`);

  // Path AND content type both come from the backend, so the two can never
  // disagree. Switching AGENT_COOP_VOICE orphans any cache the previous backend
  // wrote, which costs nothing: the audio is derived and re-renders on request.
  const backend = ctx.speechBackend ?? backendFor();
  const file = Bun.file(narrationPath(ctx.narrationDir, rowId, backend.ext));
  if (!(await file.exists())) return fail(404, `no narration audio for revision ${label} yet`);
  return new Response(file, { headers: { "content-type": backend.mime } });
}
