// The Event union — contract-design.md §The event log (R2). 17 members.
// Field names here are law; db-design and ui-design cite them verbatim.
import { z } from "zod";
import { idString, pathString, textString, titleString, tokenString } from "./limits.ts";
import { BlockOpSchema } from "./blocks.ts";
import { CommentCreateSchema, ActorSchema } from "./comment.ts";
import { AttachmentCreateSchema } from "./attachment.ts";

export const EventBaseSchema = z.object({
  event_id: idString(),
  session_id: idString(),
  seq: z.number().int(),
  created_at: tokenString(),
});
export type EventBase = z.infer<typeof EventBaseSchema>;

const base = EventBaseSchema.shape;

export const EventSchema = z.discriminatedUnion("type", [
  // A second document joining a session (A1, PI-2). The `document` row and the
  // blocks it starts with land from ONE event, so a doc added mid-session
  // reaches replay the same way the seeded one does. It names no filesystem
  // path: `source_path` stays null, which is what keeps the HTTP endpoint
  // behind it browser-safe (SEC-2).
  z.object({ ...base, type: z.literal("doc_added"), doc_id: idString(), title: titleString(), ops: z.array(BlockOpSchema) }),
  z.object({ ...base, type: z.literal("user_edit"), doc_id: idString(), ops: z.array(BlockOpSchema) }),
  z.object({ ...base, type: z.literal("comment_create"), doc_id: idString(), comment: CommentCreateSchema }),
  z.object({ ...base, type: z.literal("comment_reply"), comment_id: idString(), parent_id: idString(), text: textString() }),
  z.object({ ...base, type: z.literal("comment_resolve"), comment_id: idString(), resolved_by: ActorSchema }),
  z.object({ ...base, type: z.literal("submit") }),
  // The user taking the document back (PI-4). SUBMITTED or CLAUDE_TURN ->
  // USER_EDITING. It is on the log rather than a projection poke because the
  // turn boundary is the log's business: without it an accidental submit, or a
  // Claude session that died mid-turn, leaves the document read-only with no
  // way out of the browser at all.
  z.object({ ...base, type: z.literal("cancel") }),
  z.object({ ...base, type: z.literal("pull") }),
  z.object({ ...base, type: z.literal("claude_apply"), doc_id: idString(), ops: z.array(BlockOpSchema), client_edit_id: idString() }),
  z.object({ ...base, type: z.literal("snapshot"), turn_summary: textString(), revision_id: idString() }),
  // A turn note and its spoken form, written AFTER the turn they describe closed.
  // `revision_id` is the LABEL (`rev-x`), never a revision row's primary key: the
  // label is the only revision identifier that crosses a seam, and the projection
  // finds the per-document row from it with `revisionLabel` (src/engine/projections.ts).
  // Writing a second one for the same revision is legal and overwrites the
  // projection — the log keeps both, which is how a re-narration stays auditable.
  z.object({
    ...base,
    type: z.literal("note_written"),
    doc_id: idString(),
    revision_id: idString(),
    note: textString(),
    narration: textString(),
  }),
  z.object({ ...base, type: z.literal("export"), doc_id: idString(), path: pathString() }),
  z.object({ ...base, type: z.literal("attachment_add"), attachment: AttachmentCreateSchema }),
  z.object({ ...base, type: z.literal("transcript_done"), attachment_id: idString(), text: textString() }),
  z.object({ ...base, type: z.literal("transcript_manual"), attachment_id: idString(), text: textString() }),
  z.object({ ...base, type: z.literal("transcript_failed"), attachment_id: idString(), reason: textString() }),
  z.object({ ...base, type: z.literal("transcript_retry"), attachment_id: idString() }),
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];

// Enumerated so tests, the reducer's state matrix, and the DDL CHECK can all
// derive from one list rather than three hand-kept copies.
export const EVENT_TYPES = [
  "doc_added",
  "user_edit",
  "comment_create",
  "comment_reply",
  "comment_resolve",
  "submit",
  "cancel",
  "pull",
  "claude_apply",
  "snapshot",
  "note_written",
  "export",
  "attachment_add",
  "transcript_done",
  "transcript_manual",
  "transcript_failed",
  "transcript_retry",
] as const satisfies readonly EventType[];
