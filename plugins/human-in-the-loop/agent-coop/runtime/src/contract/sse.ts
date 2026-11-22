// SSE event catalog — contract-design.md §SSE event catalog.
// One channel (/api/events). Every row below has a v1 producer, transcript_*
// included: src/server/emit.ts is the one place an EVENT becomes SSE rows, and
// it broadcasts transcript_done / _failed / _retry (CQ1 — this comment used to
// claim otherwise). What has no v1 producer is the browser end: nothing in web/
// listens for the transcript_* rows yet: no browser captures audio and no
// dispatcher routes it (CLAUDE.md, the attachment dispatch rule).
//
// The narration_* pair is the exception to "emit.ts is the one place": those two
// frames have no event behind them at all, because the thing they report is a
// cache rather than a fact of the log. See the note on them below.
import { z } from "zod";
import { idString, textString, titleString } from "./limits.ts";
import { CommentSchema, ActorSchema } from "./comment.ts";
import { SessionStateSchema } from "./session.ts";

export const SseEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("state_changed"),
    data: z.object({ session_id: idString(), from: SessionStateSchema, to: SessionStateSchema }),
  }),
  z.object({
    event: z.literal("revision_created"),
    data: z.object({ session_id: idString(), revision_id: idString(), turn_summary: textString() }),
  }),
  z.object({ event: z.literal("comment_added"), data: CommentSchema }),
  z.object({
    event: z.literal("comment_resolved"),
    data: z.object({ comment_id: idString(), resolved_by: ActorSchema }),
  }),
  z.object({ event: z.literal("transcript_done"), data: z.object({ attachment_id: idString() }) }),
  z.object({
    event: z.literal("transcript_failed"),
    data: z.object({ attachment_id: idString(), reason: textString() }),
  }),
  z.object({ event: z.literal("transcript_retry"), data: z.object({ attachment_id: idString() }) }),
  z.object({
    event: z.literal("apply_progress"),
    data: z.object({ doc_id: idString(), block_id: idString() }),
  }),
  // A1/PI-2: a session's document list can change while a page is open.
  z.object({
    event: z.literal("doc_added"),
    data: z.object({ session_id: idString(), doc_id: idString(), title: titleString() }),
  }),
  // A turn note landing live (src/contract/events.ts `note_written`). This frame
  // was missing entirely until now: Claude auto-navigates the user to the diff
  // the moment it snapshots, the note is written after that, and with no frame
  // to carry it the reader saw no note until an unprompted reload.
  //
  // DECISION: carries the note and narration text itself, matching
  // `comment_added` above, rather than only `doc_id`/`revision_id` for the
  // view to refetch. Weighed against a refetch: both texts sit under the same
  // MAX_TEXT_LEN cap a comment already broadcasts whole, so this is not a new
  // order of magnitude; the frame is provably the freshest write, where a
  // refetch racing a second, overwriting `note_written` for the same revision
  // (legal by design, src/contract/events.ts's own comment on this event)
  // could read back the one being replaced; and
  // web/src/components/turn-note.js's `setRevision` already wants exactly
  // this shape, so carrying it here adds no second parsing path.
  z.object({
    event: z.literal("note_written"),
    data: z.object({
      doc_id: idString(),
      revision_id: idString(),
      note: textString(),
      narration: textString(),
    }),
  }),
  // The two frames below are the ONLY ones with no event behind them, and that is
  // deliberate rather than an oversight. Every other row here is produced by
  // src/server/emit.ts from a row of the log; these report the state of a derived
  // CACHE — the narration audio file — which is regenerable from
  // `revision.narration` and therefore never written to the log. A re-render of
  // the same text would otherwise append an event per attempt, for ever, to
  // record something no replay needs. src/server/notes.ts broadcasts them
  // directly, and it is the only thing that may.
  z.object({
    event: z.literal("narration_ready"),
    data: z.object({ doc_id: idString(), revision_id: idString(), duration_ms: z.number().int() }),
  }),
  // A failed render never blocks the note: the text is already readable, and this
  // frame only tells the browser to say why the audio is missing.
  z.object({
    event: z.literal("narration_failed"),
    data: z.object({ doc_id: idString(), revision_id: idString(), reason: textString() }),
  }),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
export type SseEventName = SseEvent["event"];

export const SSE_EVENT_NAMES = [
  "state_changed",
  "revision_created",
  "comment_added",
  "comment_resolved",
  "transcript_done",
  "transcript_failed",
  "transcript_retry",
  "apply_progress",
  "doc_added",
  "note_written",
  "narration_ready",
  "narration_failed",
] as const satisfies readonly SseEventName[];
