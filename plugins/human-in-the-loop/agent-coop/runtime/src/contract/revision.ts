// The revision list — `GET /api/revisions/:doc_id` (PI-5).
//
// The turn summary was always persisted: the reducer writes it to the `revision`
// projection from the `snapshot` event (src/engine/projections.ts). What was
// missing was any way to READ it back. The browser held summaries in a Map that
// died with the page, and the diff screen was reachable only by being thrown
// onto it once, by the `revision_created` SSE frame — so a turn's diff and its
// summary were view-once, and a reload lost both.
//
// This endpoint is the reopen path. Every entry names a label the diff endpoint
// accepts as `to`, and the diff's own base rule (PI-1: the user's last submit at
// or before `to`) then bounds that turn from below — which is what makes "the
// diff of any past turn" a query rather than a thing the client has to
// reconstruct from a revision ordering it should not know about.
import { z } from "zod";
import { idString, textString, tokenString } from "./limits.ts";

export const RevisionSchema = z.object({
  /**
   * The revision label, which is the ONE identifier for a revision that crosses
   * the seam: the same string the `revision_created` SSE frame carries, and the
   * one `?to=` and `?revision=` accept.
   *
   * Deliberately not the `revision` row's primary key. A snapshot is
   * session-scoped while a revision row is per-document, so in a multi-doc
   * session the reducer suffixes the key per document (`rev-x:0`, `rev-x:1`,
   * src/engine/projections.ts). That suffix is storage's business: a client shown
   * it could not match it against the frame it was told about.
   */
  revision_id: idString(),
  doc_id: idString(),
  /** Log position the label points at. On the wire so the ordering the UI shows
   *  is the log's, not a re-sort of timestamps. */
  seq: z.number().int(),
  /** Claude's own words for the turn that closed here. Empty is possible: a
   *  snapshot may carry an empty summary, and that is not the same as absent. */
  turn_summary: textString(),
  /**
   * The turn note: markdown, an interpretation of the turn rather than a label
   * for it, written by a `note_written` event after the turn closed.
   *
   * NULL means no note was ever asked for, which is the common case — notes are
   * on demand, so most revisions will never have one. That is why it is nullable
   * rather than defaulting to `turn_summary`: an empty note and a one-line
   * summary dressed up as a note are different claims, and only one of them is
   * true.
   */
  turn_note: textString().nullable().default(null),
  /** The same content flattened for an ear (`note_written.narration`): tables
   *  become sentences, fences become descriptions. NULL whenever `turn_note` is,
   *  because one event writes both. It is what the audio is rendered FROM, so a
   *  reader who would rather skim can read exactly what was spoken. */
  narration: textString().nullable().default(null),
  created_at: tokenString(),
});
export type Revision = z.infer<typeof RevisionSchema>;

export const RevisionListSchema = z.object({
  doc_id: idString(),
  /** Newest first: the list is a history, and the turn a user wants to reread is
   *  overwhelmingly the last one. */
  revisions: z.array(RevisionSchema),
  contract_version: tokenString(),
});
export type RevisionList = z.infer<typeof RevisionListSchema>;

/**
 * Body of `POST /api/notes/:doc_id` (src/server/routes/write.ts `createNote`),
 * which dispatches one `note_written` event (src/contract/events.ts) for a
 * document that already exists.
 *
 * `revision_id` is the revision LABEL this note attaches to — the same string
 * this file's own `RevisionSchema.revision_id` reports, never a revision row's
 * storage id. An unknown label is not validated by this schema: the engine's
 * own read-only phase (src/engine/engine.ts) refuses it as `unknown_revision`,
 * the same referential check every other event's foreign id gets.
 */
export const NoteWriteSchema = z.object({
  revision_id: idString(),
  note: textString(),
  narration: textString(),
});
export type NoteWrite = z.infer<typeof NoteWriteSchema>;
