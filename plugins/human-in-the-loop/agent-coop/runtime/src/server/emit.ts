// Event -> SSE catalog projection. One place decides which catalog rows a
// committed event produces, so no handler hand-rolls a broadcast.
import type { Event, SessionState, SseEvent } from "../contract/index.ts";
import { liveComment } from "./anchors.ts";
import type { ServerContext } from "./context.ts";
import { getComment } from "./queries.ts";

/** Only the two fields this projection needs; keeps it callable from a test. */
type EmitContext = Pick<ServerContext, "db" | "engine">;

export function sseEventsFor(
  ctx: EmitContext,
  event: Event,
  transition: { from: SessionState; to: SessionState } | null,
  noop: boolean,
): SseEvent[] {
  const out: SseEvent[] = [];

  if (transition !== null) {
    out.push({
      event: "state_changed",
      data: { session_id: event.session_id, from: transition.from, to: transition.to },
    });
  }
  if (noop) return out;

  switch (event.type) {
    case "doc_added":
      out.push({
        event: "doc_added",
        data: { session_id: event.session_id, doc_id: event.doc_id, title: event.title },
      });
      break;

    case "snapshot":
      out.push({
        event: "revision_created",
        data: {
          session_id: event.session_id,
          revision_id: event.revision_id,
          turn_summary: event.turn_summary,
        },
      });
      break;

    // Was missing entirely (the defect this case fixes): note_written had a
    // real log event and no SSE frame, so a note written after the auto-
    // navigate to the diff never reached a page already open on it. Forwards
    // the event's own fields verbatim, the same choice src/contract/sse.ts
    // makes and explains for why the frame carries the text rather than an
    // identity a client would have to refetch.
    case "note_written":
      out.push({
        event: "note_written",
        data: {
          doc_id: event.doc_id,
          revision_id: event.revision_id,
          note: event.note,
          narration: event.narration,
        },
      });
      break;

    case "comment_create": {
      // comment_create carries no comment_id: the event_id IS the id (P2).
      const comment = liveComment(ctx, getComment(ctx.db, event.event_id));
      if (comment !== null) out.push({ event: "comment_added", data: comment });
      break;
    }

    case "comment_reply": {
      const comment = liveComment(ctx, getComment(ctx.db, event.comment_id));
      if (comment !== null) out.push({ event: "comment_added", data: comment });
      break;
    }

    case "comment_resolve":
      out.push({
        event: "comment_resolved",
        data: { comment_id: event.comment_id, resolved_by: event.resolved_by },
      });
      break;

    case "claude_apply":
      // One row per op, for live turn-diff rendering.
      for (const op of event.ops) {
        out.push({ event: "apply_progress", data: { doc_id: event.doc_id, block_id: op.block_id } });
      }
      break;

    case "transcript_done":
      out.push({ event: "transcript_done", data: { attachment_id: event.attachment_id } });
      break;

    case "transcript_failed":
      out.push({
        event: "transcript_failed",
        data: { attachment_id: event.attachment_id, reason: event.reason },
      });
      break;

    case "transcript_retry":
      out.push({ event: "transcript_retry", data: { attachment_id: event.attachment_id } });
      break;

    default:
      break; // user_edit, submit, pull, export, attachment_add, transcript_manual
  }
  return out;
}
