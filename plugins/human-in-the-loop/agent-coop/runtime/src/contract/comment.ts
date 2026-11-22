// Comment wire shapes — contract-design.md §Comment.
import { z } from "zod";
import { audioB64String, idString, textString, tokenString } from "./limits.ts";
import { CommentAnchorSchema } from "./anchor.ts";

export const DeliverySchema = z.enum(["interrupt", "queued", "ambient"]);
export type Delivery = z.infer<typeof DeliverySchema>;

export const ActorSchema = z.enum(["user", "claude"]);
export type Actor = z.infer<typeof ActorSchema>;

export const CommentStatusSchema = z.enum(["open", "resolved"]);
export type CommentStatus = z.infer<typeof CommentStatusSchema>;

/**
 * anchor_state is an independent axis of status (db-design §2 comment). Three
 * values since PI-6, and the third exists so that "we cannot say where this
 * highlight goes" stops being reported as success:
 *
 *   attached  both ends resolved and still span at least one character. This is
 *             the ONLY value that permits a `<mark>`.
 *   detached  the anchor's head still resolves but the run does not: the tail
 *             failed, the two ends collapsed onto each other, or the anchor
 *             predates PI-6 and has no tail at all. The comment still points at
 *             a block; it no longer points at words.
 *   orphaned  the anchor's own position is gone — Yjs returned null, or the
 *             owning block was deleted.
 *
 * Neither `detached` nor `orphaned` ever carries `rendered_offsets`.
 */
export const AnchorStateSchema = z.enum(["attached", "detached", "orphaned"]);
export type AnchorState = z.infer<typeof AnchorStateSchema>;

/**
 * Voice INPUT riding along with a comment submission. Never stored, never
 * read back: it is discarded once the server transcribes it, which is why it
 * lives on the raw request shapes below and nowhere near CommentCreateSchema
 * or CommentSchema. Voice is an input METHOD here, not a stored artifact:
 * the server transcribes it BEFORE any event is appended, and
 * ONE comment is appended carrying the finished text, because the log is
 * append-only and a comment body is never mutated after the fact (same
 * argument the reply route makes for itself: "a reply is a new row, never a
 * mutation"). There is no "create the comment now, fill in the transcript
 * later" available to an append-only log, so the audio has to already be
 * text by the time `comment_create`/`comment_reply` dispatches.
 *
 * `sample_rate` is `z.literal(16000)` on purpose, not `z.number()`: whisper
 * wants 16 kHz, and the browser can resample to exactly that with an
 * OfflineAudioContext before sending. Accepting any other rate would put a
 * resampler in the server for a problem the client is already positioned to
 * solve, and a wrong rate would then either resample silently (nobody asked
 * for that trade) or transcribe at the wrong speed with nothing having said
 * why. `z.literal` makes a wrong rate a NAMED refusal at the schema, a 400,
 * instead of a transcript that is quietly wrong.
 */
export const CommentAudioSchema = z.object({
  pcm_b64: audioB64String(),
  sample_rate: z.literal(16000),
});
export type CommentAudio = z.infer<typeof CommentAudioSchema>;

// UI-submitted raw shape, before the server resolves the anchor (D4).
export const CommentCreateRawSchema = z.object({
  doc_id: idString(),
  block_id: idString(),
  rendered_offsets: z.tuple([z.number().int(), z.number().int()]),
  quoted_text: textString(),
  text: textString(),
  delivery: DeliverySchema,
  // Optional voice input, see CommentAudioSchema above. Absent for every
  // typed comment, which is most of them; null and undefined both mean "no
  // audio" so a caller need not distinguish "omitted" from "explicitly none".
  audio: CommentAudioSchema.nullable().optional(),
});
export type CommentCreateRaw = z.infer<typeof CommentCreateRawSchema>;

// The shape the reducer actually stores (`comment_create`'s payload,
// src/contract/events.ts) and CommentSchema below extends. Deliberately NO
// `audio` field here, and never add one: this is the shape that reaches the
// log and the shape a read echoes back, and CommentAudioSchema exists
// precisely so voice never has to be either.
export const CommentCreateSchema = z.object({
  doc_id: idString(),
  anchor: CommentAnchorSchema.nullable(), // null = global/whole-document (A4)
  text: textString(),
  delivery: DeliverySchema.default("queued"),
  parent_id: idString().nullable(),
});
export type CommentCreate = z.infer<typeof CommentCreateSchema>;

// Two read-only, server-computed fields ride on the wire `Comment`. Neither is
// ever accepted as input; both exist because the UI cannot derive them and
// ui-design requires both (P6 gap, see the note below).
//
//   anchor_state      the engine already stores it (db-design §2) and P5 simply
//                     never surfaced it — without it the panel cannot tag
//                     "anchor lost — text removed".
//   rendered_offsets  the anchor's CURRENT position in the block's rendered
//                     text, so the UI can paint the <mark>. The client must
//                     never decode a relative position and must never re-match
//                     `quoted_text`, so the only place this can come from is
//                     the server, which already owns the one mapping function.
//                     BOTH numbers are resolved from Yjs (PI-6): the second is
//                     the anchored tail, not `start + quoted_text.length`. null
//                     for a global comment and for any anchor that is not
//                     `attached`.
export const CommentSchema = CommentCreateSchema.extend({
  comment_id: idString(),
  session_id: idString(),
  status: CommentStatusSchema,
  resolved_by: ActorSchema.nullable(),
  anchor_state: AnchorStateSchema.default("attached"),
  rendered_offsets: z.tuple([z.number().int(), z.number().int()]).nullable().default(null),
  created_at: tokenString(),
});
export type Comment = z.infer<typeof CommentSchema>;

/**
 * One comment and its replies, as the turn-diff screen reads them (PI-7).
 *
 * Claude's replies used to exist only in the drawer of the document view, so a
 * user reading the diff of a turn could not see the answers that turn gave to
 * their comments without leaving the surface. `TurnDiff.threads` carries them.
 *
 * There is deliberately NO author field on a reply. The `comment_reply` seam
 * authenticates no actor (the endpoint is reachable by both the browser and the
 * MCP shim, with no auth in v1), exactly as with `doc_added` in
 * src/contract/diff.ts — so labelling a reply "by Claude" would be a claim the
 * code cannot make. The reply text is shown; its authorship is not asserted.
 */
export const CommentThreadSchema = z.object({
  root: CommentSchema,
  /** Direct replies (`parent_id === root.comment_id`), oldest first. */
  replies: z.array(CommentSchema),
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;
