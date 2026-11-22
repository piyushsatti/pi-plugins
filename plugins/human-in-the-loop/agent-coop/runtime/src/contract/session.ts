// Session state, session/document read shapes, MCP error shape.
// contract-design.md §Overview (state machine), §MCP error shape (D15).
//
// There is no session-create wire shape here, and that is deliberate (SEC-2):
// creating a session names a local filesystem path, and the browser is never
// allowed to name one. Sessions are made by the CLI (scripts/up.ts) against the
// database while no server holds it, never over HTTP.
import { z } from "zod";
import { idString, pathString, textString, titleString, tokenString } from "./limits.ts";

export const SessionStateSchema = z.enum(["USER_EDITING", "SUBMITTED", "CLAUDE_TURN"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionStatusSchema = z.enum(["active", "archived"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: idString(),
  title: titleString(),
  created_at: tokenString(),
  status: SessionStatusSchema,
  state: SessionStateSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const DocumentSchema = z.object({
  id: idString(),
  session_id: idString(),
  title: titleString(),
  source_path: pathString().nullable(),
  export_path: pathString().nullable(),
  created_at: tokenString(),
});
export type DocumentMeta = z.infer<typeof DocumentSchema>;

/**
 * The starting blocks of a document nobody supplied content for: ONE empty
 * block (ENTRY-1).
 *
 * The one place that rule is written. It was written three times — here as
 * `DocAddSchema`'s default, in scripts/up.ts for the session's first document,
 * and in web/src/views/session-list.js for the add-document form — so "a new
 * document has one empty block" could have become three different answers.
 * Every surface now reaches this constant or reaches the default it feeds:
 * scripts/up.ts imports it (its document precedes any event, so it never passes
 * through the schema), and the MCP shim and the web form both OMIT `blocks`
 * rather than sending `[]`, so the default below is what answers.
 *
 * Frozen, and spread wherever it is used: a default that handed the same array
 * to every caller would let one of them mutate it for all the others.
 */
export const STARTER_BLOCKS: readonly string[] = Object.freeze([""]);

/**
 * Body of `POST /api/sessions/:id/docs` — a second document in an existing
 * session (A1, PI-2). Every layer below the API was already multi-doc; this is
 * the shape that lets anything put a second document in a session.
 *
 * Deliberately narrower than session creation, which is why this one CAN be an
 * endpoint while `POST /api/sessions` still cannot (SEC-2): it names no
 * filesystem path. `blocks` is the document's starting markdown, one string per
 * block, sent inline. The server mints the doc_id and every block_id, so a
 * caller can neither collide with an existing id nor name a file to read.
 *
 * An empty `blocks` becomes ONE empty block, and absent means the same thing
 * (ENTRY-1). Not a convenience: the document view edits blocks that EXIST and
 * has no insert control, so a document with zero blocks cannot be typed into by
 * anyone and the only way out of one is to add a second document. The
 * normalization is here, in the contract, rather than in the route or the MCP
 * tool, because every caller of every surface needs it and two copies of "and
 * if it is empty, use one blank" would drift.
 */
export const DocAddSchema = z.object({
  title: titleString(),
  blocks: z
    .array(textString())
    .default(() => [...STARTER_BLOCKS])
    .transform((blocks) => (blocks.length === 0 ? [...STARTER_BLOCKS] : blocks)),
});
export type DocAdd = z.infer<typeof DocAddSchema>;

/** Body of `GET /api/health` — the `/agent-coop` skill's step 1. Answers exactly one
 *  question ("is an agent-coop server already the thing on this port?") and carries
 *  the numbers a start decision needs, nothing more. */
export const HealthSchema = z.object({
  ok: z.literal(true),
  contract_version: tokenString(),
  sessions: z.number(),
  db_path: pathString(),
  started_at: tokenString(),
});
export type Health = z.infer<typeof HealthSchema>;

/**
 * The one failure shape, on every non-2xx body and on the transport failures no
 * server ever answered (D15).
 *
 * `state` is OPTIONAL, and that is the point: it is the session's projected
 * state, so it exists only when a session was looked up. A refusal that never
 * reached one — an unreachable server, a malformed body, an unknown tool, an
 * unknown session — has no state to report, and the default it used to carry
 * ("USER_EDITING") was a claim nobody had checked. Claude reads `state` to
 * decide whether to wait for a submit, so a wrong one is worse than none: it
 * says the document is editable when the caller does not know that.
 *
 * Absent therefore means "not known", never "USER_EDITING". Anything reading it
 * must handle the absence rather than defaulting it back.
 */
export const McpToolErrorSchema = z.object({
  error: textString(),
  state: SessionStateSchema.optional(),
  retry_after_submit: z.boolean(),
});
export type McpToolError = z.infer<typeof McpToolErrorSchema>;
