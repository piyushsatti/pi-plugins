// Write endpoints — contract-design.md §MCP tools table and §Additional
// user-facing HTTP endpoints. Every one of these is a body-validated shell
// around exactly one `dispatch`: the turn gate, the projections and the SSE
// rows all belong to the engine, never to a handler.
import { z } from "zod";
import {
  ApplyPayloadSchema,
  AttachmentCreateSchema,
  CommentAudioSchema,
  CommentCreateRawSchema,
  DeliverySchema,
  DocAddSchema,
  MAX_TEXT_LEN,
  NoteWriteSchema,
  SessionActionSchema,
  contract_version,
  idString,
  pathString,
  textString,
  type ApplyResult,
  type Block,
  type BlockOp,
  type CommentAnchor,
  type CommentAudio,
  type PullBatch,
  type TurnActionResult,
} from "../../contract/index.ts";
import { BlockOpSchema } from "../../contract/blocks.ts";
import { ActorSchema } from "../../contract/comment.ts";
import { createAnchor, revisionRowIdForLabel } from "../../engine/index.ts";
import { ExportPathError, resolveExportPath, writeMarkdown, type ExportResult } from "../../export/index.ts";
import { TranscribeError, backendFor as transcribeBackendFor } from "../../transcribe/index.ts";
import type { TranscriptResult } from "../../transcribe/index.ts";
import { liveComment, liveComments } from "../anchors.ts";
import { MAX_BACKUPS, backupTo } from "../backup.ts";
import { MAX_CONCURRENT_TRANSCRIPTIONS, dispatch, sessionOfDoc, type ServerContext } from "../context.ts";
import { failDomain } from "../errors.ts";
import { fail, json, parseBody } from "../http.ts";
import { startNarrationRender } from "../notes.ts";
import { mapRenderedOffsetToSource } from "../offsets.ts";
import {
  openRootCommentsForSession,
  documentsForSession,
  getComment,
  getDocument,
  getSession,
  lastRevisionSeq,
  pendingInterrupts,
  turnStartedAtSeq,
} from "../queries.ts";

// --- bodies the contract does not name as a type ---------------------------

// Bodies the contract does not name as a type still take the contract's length
// caps (SEC-6): the numbers live in src/contract/limits.ts, never here.
const BlockPatchSchema = z.object({ ops: z.array(BlockOpSchema) });
const SnapshotSchema = z.object({ turn_summary: textString() });
/** `path` is optional: with none, the export lands in `artifacts/` under a
 *  slug of the document title (see `exportDoc`). */
const ExportSchema = z.object({ path: pathString().optional() });
// `audio` on both this and GlobalCommentSchema below is voice INPUT
// (src/contract/comment.ts `CommentAudioSchema`), never stored: `resolveCommentText`
// below turns it into the comment's actual text, before `createComment` and
// `replyComment` ever dispatch, see that function's own comment for why the
// timing is not optional.
const ReplySchema = z.object({ text: textString(), audio: CommentAudioSchema.nullable().optional() });
const ResolveSchema = z.object({ resolved_by: ActorSchema.default("user") });
const TranscriptSchema = z.object({ text: textString() });

/** A whole-document comment (A4): same endpoint, no anchor to resolve. */
const GlobalCommentSchema = z.object({
  doc_id: idString(),
  anchor: z.null(),
  text: textString(),
  delivery: DeliverySchema.default("queued"),
  parent_id: idString().nullable().default(null),
  audio: CommentAudioSchema.nullable().optional(),
});

const CommentPostSchema = z.union([CommentCreateRawSchema, GlobalCommentSchema]);

// --- voice input --------------------------------------------------------------

/**
 * base64 -> the Int16 PCM samples a transcribe backend expects
 * (src/transcribe/seam.ts `transcribe`). Reads through a `DataView` rather
 * than constructing `new Int16Array(bytes.buffer, bytes.byteOffset, …)`
 * directly: `Buffer.from(b64, "base64")` is not guaranteed to land at an
 * even `byteOffset` into its underlying `ArrayBuffer` (Bun/Node's small-
 * allocation pool packs buffers back to back with no alignment guarantee),
 * and the `Int16Array` constructor throws on an odd one. `DataView` has no
 * such requirement.
 */
function decodePcm16(pcm_b64: string): Int16Array {
  const bytes = Buffer.from(pcm_b64, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(bytes.byteLength / 2);
  // Little-endian: the same convention `encodeInt16Wav` (src/audio/wav.ts)
  // frames samples in on the way out to whisper.
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

/**
 * One transcription call, bounded by `ctx.transcribeTimeoutMs`
 * (TRANSCRIBE_TIMEOUT_MS, src/server/context.ts). Enforced by ABORTING the
 * backend through `opts.signal`, never by racing a timer against its promise
 * and abandoning whichever side loses. `TranscribeBackend.transcribe`'s own
 * header (src/transcribe/seam.ts) has the full argument for why the old race
 * was the actual defect, not just a style choice: only the backend holding
 * the temp WAV's path and the whisper-cli subprocess's handle can release
 * either on a timeout, and a caller that merely stops awaiting leaves both
 * alive. This function's returned promise now only settles once the backend
 * itself has, cleanup included, which is also load-bearing for
 * MAX_CONCURRENT_TRANSCRIPTIONS: `resolveCommentText` tracks this exact
 * promise in `ctx.transcriptions` for its lifetime, so undoing the old
 * abandon-on-timeout is what makes that count mean "processes actually
 * alive" rather than "requests this handler has stopped waiting on".
 *
 * A timeout is raised as a `TranscribeError`, the SAME type a backend itself
 * throws, rather than a second error type: `resolveCommentText` below has
 * exactly one catch, because "the backend failed" and "the backend was too
 * slow" are the one thing they are to a browser waiting on this request:
 * audio did not become text. `timedOut` distinguishes the two SOURCES of a
 * rejection after `controller.abort()`: this function's own message is used
 * only when its own timer is what fired the abort, so a backend that rejects
 * for a real reason of its own (a whisper-cli crash, say) is never relabelled
 * as a timeout.
 */
async function transcribeBounded(
  ctx: ServerContext,
  pcm: Int16Array,
  sampleRate: number,
): Promise<TranscriptResult> {
  const backend = ctx.transcribeBackend ?? transcribeBackendFor();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.transcribeTimeoutMs);
  try {
    return await backend.transcribe(pcm, sampleRate, { signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new TranscribeError(`transcription timed out after ${ctx.transcribeTimeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type ResolvedCommentText = { ok: true; text: string } | { ok: false; response: Response };

/**
 * Voice input becomes the comment's FINAL text HERE, before `createComment`
 * or `replyComment` ever dispatches. It has to: the event log is append-only
 * and a comment body is never mutated once it exists (the reply route makes
 * the identical argument for itself below, "a reply is a new row, never a
 * mutation", so there is no "create the comment now, fill in the
 * transcript later" available to either endpoint. `comment_create`/
 * `comment_reply` must receive finished text or nothing at all.
 *
 * `audio` absent or null is the ordinary typed-only path and costs nothing
 * beyond the check.
 */
async function resolveCommentText(
  ctx: ServerContext,
  typed: string,
  audio: CommentAudio | null | undefined,
  session_id: string,
): Promise<ResolvedCommentText> {
  if (audio == null) return { ok: true, text: typed };

  // Admission control BEFORE spawning anything (adversarial review of voice
  // input): each transcription is its own whisper-cli process holding the
  // whole model (MAX_CONCURRENT_TRANSCRIPTIONS, src/server/context.ts), so
  // refusing here costs nothing, where refusing after the spawn would already
  // have paid for the thing this exists to prevent. Refused by name rather
  // than queued: queueing behind a request that can itself take
  // TRANSCRIBE_TIMEOUT_MS just hides the wait, it does not remove it.
  if (ctx.transcriptions.size >= MAX_CONCURRENT_TRANSCRIPTIONS) {
    const state = ctx.engine.state(session_id)!;
    return {
      ok: false,
      response: failDomain({
        code: "transcribe_busy",
        message: `too many voice comments transcribing at once (limit ${MAX_CONCURRENT_TRANSCRIPTIONS}); wait for one to finish and try again`,
        state,
      }),
    };
  }

  let work: Promise<TranscriptResult> | undefined;
  let transcript: string;
  try {
    const pcm = decodePcm16(audio.pcm_b64);
    work = transcribeBounded(ctx, pcm, audio.sample_rate);
    // Held in ctx.transcriptions for exactly this promise's own lifetime (the
    // `finally` below), so the check above always answers "how many are
    // running right now", never "how many were ever started". See that
    // field's own comment in src/server/context.ts for why this differs from
    // how `backups`/`narrations` are capped.
    ctx.transcriptions.add(work);
    transcript = (await work).text;
  } catch (err) {
    const message = err instanceof TranscribeError ? err.message : `transcription failed: ${String(err)}`;
    // Looked up, never guessed (src/server/http.ts `fail`'s own rule for
    // `state`): both callers below already resolved this session_id from a
    // row that exists, so this read cannot come back null. The typed text
    // the caller sent is untouched by this refusal: it was never read again
    // after being handed to this function, so the browser's own copy is
    // still exactly what the user typed.
    const state = ctx.engine.state(session_id)!;
    return { ok: false, response: failDomain({ code: "transcribe_failed", message, state }) };
  } finally {
    if (work !== undefined) ctx.transcriptions.delete(work);
  }

  // Audio was sent, so an empty transcript is a failure the user must see,
  // never a success that quietly falls back to whatever was typed
  // (adversarial review: the voice half was vanishing with no signal in the
  // body, a frame, or a status, and the client destroyed the recording on
  // what it read as full success). Refused by name, ahead of the join below,
  // so this fires even when `typed` is non-empty, the case that used to slip
  // through as a 201. The client keeps the typed text and the recording on
  // this refusal, so nothing is lost and the user can retry the recording.
  if (transcript === "") {
    const state = ctx.engine.state(session_id)!;
    return {
      ok: false,
      response: failDomain({ code: "transcript_empty", message: "nothing was heard in the recording", state }),
    };
  }

  // Typed text first, a blank line, then the transcript. Transcript is
  // guaranteed non-empty at this point (the check above already refused the
  // empty case), so this never produces an empty string the way the old
  // three-way collapse had to guard against.
  const text = typed === "" ? transcript : `${typed}\n\n${transcript}`;
  // parseBody only capped the TYPED half, before this join (SEC-6): a
  // full-length typed comment plus any transcript at all is now over
  // MAX_TEXT_LEN, and dispatching it would hit EventSchema.parse inside
  // src/engine/engine.ts with a raw ZodError, surfacing as an unhandled 500
  // instead of a named refusal. Checked here, the one place the join happens.
  if (text.length > MAX_TEXT_LEN) {
    return {
      ok: false,
      response: fail(400, `comment text is ${text.length} characters after adding the transcript, over the ${MAX_TEXT_LEN} limit`),
    };
  }
  return { ok: true, text };
}

// --- endpoints --------------------------------------------------------------

// There is no createSession handler. Creating a session names a local
// filesystem path (the markdown file a document starts from), and nothing the
// browser can reach may name one (SEC-2): a page the user visits would
// otherwise get agent-coop to read an arbitrary file and serve it back through
// GET /api/docs/:id. Sessions are created by the CLI — scripts/up.ts, against
// the database while no server holds it — which keeps the single-writer rule.

/**
 * POST /api/sessions/:id/docs — put a second document in an existing session
 * (A1, PI-2). Body is `DocAdd`; one `doc_added` event carries the document row
 * and the blocks it starts with.
 *
 * This is not the session-create endpoint SEC-2 forbids, and the difference is
 * the whole reason it can exist: no field here names a filesystem path. The
 * document's `source_path` stays null, the doc_id and every block_id are minted
 * server-side, and the starting content arrives inline in the body. There is
 * nothing for a page the user visits to point at a local file with.
 *
 * Allowed in any state: adding a document writes no existing document, so the
 * turn gate has nothing to protect here.
 */
export async function addDoc(ctx: ServerContext, session_id: string, req: Request): Promise<Response> {
  if (getSession(ctx.db, session_id) === null) return fail(404, `unknown session ${session_id}`);
  const body = await parseBody(req, DocAddSchema, ctx.engine.state(session_id) ?? undefined);
  if (!body.ok) return body.response;

  const doc_id = ctx.newId("doc");
  // One insert per starting block, each after the previous one, so the
  // document's order is the order the caller sent.
  const ops: BlockOp[] = [];
  let after: string | null = null;
  for (const content of body.value.blocks) {
    const block_id = ctx.newId("blk");
    ops.push({ op: "insert", block_id, after_block_id: after, content });
    after = block_id;
  }

  const result = dispatch(ctx, { type: "doc_added", session_id, doc_id, title: body.value.title, ops });
  if (!result.ok) return result.response;
  return json(
    { doc: getDocument(ctx.db, doc_id), blocks: ctx.engine.blocks(doc_id), contract_version },
    201,
  );
}

/** POST /api/pull/:session_id — SUBMITTED or CLAUDE_TURN -> CLAUDE_TURN. */
export async function pull(ctx: ServerContext, session_id: string): Promise<Response> {
  if (getSession(ctx.db, session_id) === null) return fail(404, `unknown session ${session_id}`);
  const result = dispatch(ctx, { type: "pull", session_id });
  if (!result.ok) return result.response;

  const docs = documentsForSession(ctx.db, session_id);
  const since = lastRevisionSeq(ctx.db, session_id);
  const edits: BlockOp[] = [];
  for (const event of ctx.engine.events(session_id, since)) {
    if (event.type === "user_edit") edits.push(...event.ops);
  }

  const batch: PullBatch = {
    session_id,
    turn_started_at_seq: turnStartedAtSeq(ctx.db, session_id),
    docs: docs.map((d) => ({ doc_id: d.id, blocks: ctx.engine.blocks(d.id) })),
    // Open ROOTS only: a reply is not a thread waiting on an answer, and it never
    // resolves, so including one meant it rode back in every later batch
    // (PULL-ROOTS-ONLY, src/contract/pull.ts).
    comments: liveComments(ctx, openRootCommentsForSession(ctx.db, session_id)),
    user_edits_since_last_revision: edits,
    contract_version,
  };
  return json(batch);
}

/** PATCH /api/blocks/:doc_id — user block edits, USER_EDITING only. */
export async function patchBlocks(
  ctx: ServerContext,
  doc_id: string,
  req: Request,
): Promise<Response> {
  const session_id = sessionOfDoc(ctx, doc_id);
  if (session_id === null) return fail(404, `unknown doc ${doc_id}`);
  const body = await parseBody(req, BlockPatchSchema, ctx.engine.state(session_id) ?? undefined);
  if (!body.ok) return body.response;

  const result = dispatch(ctx, { type: "user_edit", session_id, doc_id, ops: body.value.ops });
  if (!result.ok) return result.response;
  return json({ doc_id, blocks: ctx.engine.blocks(doc_id), contract_version });
}

/** POST /api/apply/:doc_id — Claude's block writes, CLAUDE_TURN only. */
export async function apply(ctx: ServerContext, doc_id: string, req: Request): Promise<Response> {
  const session_id = sessionOfDoc(ctx, doc_id);
  if (session_id === null) return fail(404, `unknown doc ${doc_id}`);
  const body = await parseBody(req, ApplyPayloadSchema, ctx.engine.state(session_id) ?? undefined);
  if (!body.ok) return body.response;
  if (body.value.doc_id !== doc_id) return fail(400, "doc_id in body does not match the URL");

  const result = dispatch(ctx, {
    type: "claude_apply",
    session_id,
    doc_id,
    ops: body.value.ops,
    client_edit_id: body.value.client_edit_id,
  });
  if (!result.ok) return result.response;

  const byId = new Map<string, Block>(ctx.engine.blocks(doc_id).map((b) => [b.block_id, b]));
  const applied_block_map: Record<string, Block> = {};
  for (const op of body.value.ops) {
    const block = byId.get(op.block_id);
    if (block !== undefined) applied_block_map[op.block_id] = block;
  }
  const payload: ApplyResult = {
    applied_block_map,
    pending_interrupts: pendingInterrupts(ctx.db, session_id),
  };
  return json(payload);
}

/**
 * POST /api/comments — body is `CommentCreateRaw` (anchored) or the global
 * shape with `anchor: null` (A4). Rendered offsets are mapped to source
 * offsets HERE, server-side, and the Yjs relative position is encoded from
 * them (D4): the client never computes a position.
 */
export async function createComment(ctx: ServerContext, req: Request): Promise<Response> {
  const body = await parseBody(req, CommentPostSchema);
  if (!body.ok) return body.response;
  const raw = body.value;

  const session_id = sessionOfDoc(ctx, raw.doc_id);
  if (session_id === null) return fail(404, `unknown doc ${raw.doc_id}`);

  // The anchor is resolved FIRST, from the block state at SUBMIT time, before
  // resolveCommentText below spends any time transcribing (adversarial
  // review: the natural reading is "resolve the text first", which is
  // exactly backwards here). `rendered_offsets` on the wire were computed by
  // the browser at selection time; for a typed comment the gap to here is
  // milliseconds, but a voice comment now spends up to TRANSCRIBE_TIMEOUT_MS
  // in resolveCommentText, and comments are legal during a Claude turn, the
  // exact window in which blocks are being rewritten. Resolving the anchor
  // AFTER that wait would encode a position against whatever now sits at
  // these offsets, not the words the user selected, while still reporting
  // `anchor_state: "attached"`. `createAnchor` itself is safe against a
  // rewrite that happens LATER, because it binds to actual Yjs character
  // identity (see its own header): what it cannot survive is being handed
  // the WRONG offsets to begin with, computed against content the user never
  // saw. Resolving here also means a block that is already gone 404s before
  // a transcription is even started, instead of after paying for one that
  // was always going to be thrown away.
  let anchor: CommentAnchor | null = null;
  let parent_id: string | null = null;

  if ("rendered_offsets" in raw) {
    const doc = ctx.engine.getDoc(raw.doc_id);
    const block = ctx.engine.blocks(raw.doc_id).find((b) => b.block_id === raw.block_id);
    if (block === undefined) return fail(404, `unknown block_id ${raw.block_id}`);
    // Two endpoints, two independent mappings (ui-design step 3).
    const start = mapRenderedOffsetToSource(block.content, raw.rendered_offsets[0]);
    const end = mapRenderedOffsetToSource(block.content, raw.rendered_offsets[1], "end");
    anchor = {
      ...createAnchor(doc, raw.block_id, [Math.min(start, end), Math.max(start, end)]),
      // quoted_text is the client's snapshot of what it highlighted; it is
      // display-only and never re-matched, so the client's copy is kept.
      quoted_text: raw.quoted_text,
    };
  } else {
    parent_id = raw.parent_id;
  }

  // Voice input resolved to its FINAL text second, see resolveCommentText's
  // own comment for why the append-only log leaves no later point to do this
  // at. The anchor above is already fixed by now, so however long this takes
  // it no longer has anything to say about where the anchor points.
  const resolved = await resolveCommentText(ctx, raw.text, raw.audio, session_id);
  if (!resolved.ok) return resolved.response;
  const text = resolved.text;

  const result = dispatch(ctx, {
    type: "comment_create",
    session_id,
    doc_id: raw.doc_id,
    comment: { doc_id: raw.doc_id, anchor, text, delivery: raw.delivery, parent_id },
  });
  if (!result.ok) return result.response;
  // The event_id is the comment_id (the contract's comment_create carries no id).
  return json(
    { comment: liveComment(ctx, getComment(ctx.db, result.event.event_id)), contract_version },
    201,
  );
}

/** POST /api/comments/:id/reply — a reply is a new row, never a mutation. */
export async function replyComment(ctx: ServerContext, id: string, req: Request): Promise<Response> {
  const parent = getComment(ctx.db, id);
  if (parent === null) return fail(404, `unknown comment ${id}`);
  const body = await parseBody(req, ReplySchema);
  if (!body.ok) return body.response;

  // Same rule as createComment above, same reason: resolved before dispatch,
  // because a reply is a new row and never a mutation, which means there is
  // no later point at which this row's text could still be completed.
  const resolved = await resolveCommentText(ctx, body.value.text, body.value.audio, parent.session_id);
  if (!resolved.ok) return resolved.response;

  const comment_id = ctx.newId("cmt");
  const result = dispatch(ctx, {
    type: "comment_reply",
    session_id: parent.session_id,
    comment_id,
    parent_id: id,
    text: resolved.text,
  });
  if (!result.ok) return result.response;
  return json({ comment: liveComment(ctx, getComment(ctx.db, comment_id)), contract_version }, 201);
}

/** POST /api/comments/:id/resolve — valid from ANY state, any actor (D7). */
export async function resolveComment(
  ctx: ServerContext,
  id: string,
  req: Request,
): Promise<Response> {
  const comment = getComment(ctx.db, id);
  if (comment === null) return fail(404, `unknown comment ${id}`);
  const body = await parseBody(req, ResolveSchema);
  if (!body.ok) return body.response;

  const result = dispatch(ctx, {
    type: "comment_resolve",
    session_id: comment.session_id,
    comment_id: id,
    resolved_by: body.value.resolved_by,
  });
  if (!result.ok) return result.response;
  return json({ comment: liveComment(ctx, getComment(ctx.db, id)), contract_version });
}

/** POST /api/submit — USER_EDITING -> SUBMITTED. */
export async function submit(ctx: ServerContext, req: Request): Promise<Response> {
  const body = await parseBody(req, SessionActionSchema);
  if (!body.ok) return body.response;
  const { session_id } = body.value;
  if (getSession(ctx.db, session_id) === null) return fail(404, `unknown session ${session_id}`);

  const result = dispatch(ctx, { type: "submit", session_id });
  if (!result.ok) return result.response;
  return turnAction(ctx, session_id);
}

/**
 * POST /api/cancel — SUBMITTED or CLAUDE_TURN -> USER_EDITING (PI-4).
 *
 * The user's way back out of a turn. Without it an accidental submit, or a Claude
 * session that died holding CLAUDE_TURN, leaves every block read-only with no
 * control anywhere on the surface that reopens them: the user's only recourse was
 * the terminal, which is the exact failure agent-coop exists to remove.
 *
 * Deliberately NOT symmetric with `pull`: this endpoint is user-side only and
 * has no MCP tool. Claude ending its own turn is `agent_coop_snapshot`, which records
 * what it did; a Claude-callable cancel would be a way to drop a turn off the
 * record.
 *
 * Legality is the reducer's (src/engine/reducer.ts) — cancelling from
 * USER_EDITING is a 409 from there, not a check here. Nothing is undone: blocks
 * Claude already applied stay applied, and the next turn diff shows them as
 * Claude's, because they are.
 */
export async function cancel(ctx: ServerContext, req: Request): Promise<Response> {
  const body = await parseBody(req, SessionActionSchema);
  if (!body.ok) return body.response;
  const { session_id } = body.value;
  if (getSession(ctx.db, session_id) === null) return fail(404, `unknown session ${session_id}`);

  const result = dispatch(ctx, { type: "cancel", session_id });
  if (!result.ok) return result.response;
  return turnAction(ctx, session_id);
}

/** The shared body of the two turn actions: the state read BACK from the engine,
 *  never a constant the handler assumed (contract §TurnActionResult). */
function turnAction(ctx: ServerContext, session_id: string): Response {
  const payload: TurnActionResult = {
    session_id,
    state: ctx.engine.state(session_id)!,
    contract_version,
  };
  return json(payload);
}

/** POST /api/snapshot/:session_id — CLAUDE_TURN -> USER_EDITING, then the
 *  post-commit backup, off the request thread (D21). */
export async function snapshot(
  ctx: ServerContext,
  session_id: string,
  req: Request,
): Promise<Response> {
  if (getSession(ctx.db, session_id) === null) return fail(404, `unknown session ${session_id}`);
  const body = await parseBody(req, SnapshotSchema, ctx.engine.state(session_id) ?? undefined);
  if (!body.ok) return body.response;

  const revision_id = ctx.newId("rev");
  const result = dispatch(ctx, {
    type: "snapshot",
    session_id,
    turn_summary: body.value.turn_summary,
    revision_id,
  });
  if (!result.ok) return result.response;

  // Bounded, not accumulated (SEC-4): the array exists so tests and a shutdown
  // can await in-flight backups, and an unbounded one is a leak for the process
  // lifetime. Older entries have already settled; dropping the reference does
  // not cancel anything.
  ctx.backups.push(backupTo(ctx.dbPath, ctx.backupDir, revision_id));
  if (ctx.backups.length > MAX_BACKUPS) {
    ctx.backups.splice(0, ctx.backups.length - MAX_BACKUPS);
  }
  return json({
    session_id,
    revision_id,
    turn_summary: body.value.turn_summary,
    state: ctx.engine.state(session_id),
    contract_version,
  });
}

/**
 * POST /api/notes/:doc_id — attach a turn note and its narration to a past
 * revision (src/contract/events.ts `note_written`). Body is `NoteWrite`
 * (src/contract/revision.ts). Legal in every session state — the reducer's own
 * note on this (src/engine/reducer.ts): the note describes a turn that has
 * ALREADY closed, so it always arrives after the fact, most often in
 * USER_EDITING. Gating it the way `claude_apply` is gated would refuse it
 * every single time.
 *
 * Responds BEFORE the audio render starts, and never awaits it on this path.
 * `say` on a long note can outlive an MCP client's own request timeout, and a
 * held response then fails the WHOLE tool call with JSON-RPC -32001 — the
 * exact failure that got the rev-2 wait tool deleted (CLAUDE.md, "NO MCP TOOL
 * MAY WAIT"). The note text is already durable by the time this returns (the
 * dispatch below already committed it); the audio is a regenerable cache that
 * is allowed to still be rendering when the caller moves on.
 */
export async function createNote(ctx: ServerContext, doc_id: string, req: Request): Promise<Response> {
  const session_id = sessionOfDoc(ctx, doc_id);
  if (session_id === null) return fail(404, `unknown doc ${doc_id}`);
  const body = await parseBody(req, NoteWriteSchema, ctx.engine.state(session_id) ?? undefined);
  if (!body.ok) return body.response;

  const result = dispatch(ctx, {
    type: "note_written",
    session_id,
    doc_id,
    revision_id: body.value.revision_id,
    note: body.value.note,
    narration: body.value.narration,
  });
  // An unknown revision label refuses here as `unknown_revision` (404) through
  // the engine's own read-only validation phase (src/engine/engine.ts) — there
  // is no separate check to duplicate in this handler.
  if (!result.ok) return result.response;

  // Built now, returned last: nothing below this line is awaited before the
  // response goes out (see the function doc above for why).
  const response = json({ doc_id, revision_id: body.value.revision_id, contract_version });

  // Non-null: the dispatch above only succeeds once the engine's own read-only
  // validation phase has found this exact row, and projectEvent's note_written
  // case (src/engine/projections.ts) re-resolves the identical lookup to write
  // the note onto it.
  const rowId = revisionRowIdForLabel(ctx.db, doc_id, body.value.revision_id);
  if (rowId !== null) {
    startNarrationRender(ctx, doc_id, body.value.revision_id, rowId, body.value.narration);
  }

  return response;
}

/**
 * POST /api/export/:doc_id — write the document's markdown to disk, then
 * append the `export` event (A8, db-design §5).
 *
 * Bytes first, event second: an event that records a file which failed to
 * write would be a log that lies, and the log is the source of truth. A file
 * written whose event then fails is merely a stray file.
 *
 * `path` is optional. Omitted, the export lands in the container's
 * `artifacts/` under a slug of the document title — which is what the toolbar
 * control sends, since the user picking a path is not part of the UX
 * (ui-design §Export UX: the toolbar *reports* where it landed).
 */
export async function exportDoc(ctx: ServerContext, doc_id: string, req: Request): Promise<Response> {
  const session_id = sessionOfDoc(ctx, doc_id);
  if (session_id === null) return fail(404, `unknown doc ${doc_id}`);
  const meta = getDocument(ctx.db, doc_id)!;
  const body = await parseBody(req, ExportSchema);
  if (!body.ok) return body.response;

  let path: string;
  try {
    path = resolveExportPath(ctx.artifactsDir, meta.title, body.value.path);
  } catch (err) {
    if (err instanceof ExportPathError) return fail(400, err.message);
    throw err;
  }

  let written: ExportResult;
  try {
    written = writeMarkdown(ctx.engine.blocks(doc_id), path);
  } catch (err) {
    return fail(500, `export failed to write ${path}: ${String(err)}`);
  }

  const result = dispatch(ctx, { type: "export", session_id, doc_id, path: written.path });
  if (!result.ok) return result.response;
  return json({ doc_id, path: written.path, bytes: written.bytes, contract_version });
}

/** POST /api/attachments — origin-agnostic ingest (A10 schema; no v1 UI). */
export async function addAttachment(ctx: ServerContext, req: Request): Promise<Response> {
  const body = await parseBody(req, AttachmentCreateSchema);
  if (!body.ok) return body.response;
  if (getSession(ctx.db, body.value.session_id) === null) {
    return fail(404, `unknown session ${body.value.session_id}`);
  }
  const result = dispatch(ctx, {
    type: "attachment_add",
    session_id: body.value.session_id,
    attachment: body.value,
  });
  if (!result.ok) return result.response;
  return json({ attachment_id: result.event.event_id, contract_version }, 201);
}

/** PATCH /api/attachments/:id/transcript — the manual-transcript path. There
 *  is no comment-text path for manual transcripts (contract-design). */
export async function patchTranscript(
  ctx: ServerContext,
  id: string,
  req: Request,
): Promise<Response> {
  const row = ctx.db
    .query<{ session_id: string }, [string]>("SELECT session_id FROM attachment WHERE attachment_id = ?")
    .get(id);
  if (row === null) return fail(404, `unknown attachment ${id}`);
  const body = await parseBody(req, TranscriptSchema);
  if (!body.ok) return body.response;

  const result = dispatch(ctx, {
    type: "transcript_manual",
    session_id: row.session_id,
    attachment_id: id,
    text: body.value.text,
  });
  if (!result.ok) return result.response;
  return json({ attachment_id: id, transcript_status: "done", contract_version });
}

/** POST /api/attachments/:id/retry — re-queue a failed transcription. */
export function retryTranscript(ctx: ServerContext, id: string): Response {
  const row = ctx.db
    .query<{ session_id: string }, [string]>("SELECT session_id FROM attachment WHERE attachment_id = ?")
    .get(id);
  if (row === null) return fail(404, `unknown attachment ${id}`);

  const result = dispatch(ctx, {
    type: "transcript_retry",
    session_id: row.session_id,
    attachment_id: id,
  });
  if (!result.ok) return result.response;
  return json({ attachment_id: id, transcript_status: "pending", contract_version });
}

export { getDocument };
