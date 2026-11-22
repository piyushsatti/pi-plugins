// The turn-diff wire shape — `GET /api/diff/:doc_id` (B3: this shape was
// defined in src/engine and src/server and never in the contract, so the seam
// had no authority; it does now).
//
// PI-1 fixes what the diff is *of*. The base is the document as the user last
// SAW it — its state at their most recent `submit` — not the previous revision.
// Two consequences the old default got wrong:
//
//   - The first turn is not a whole-document rewrite. The blocks a session was
//     seeded with landed before the first submit, so they sit in the base.
//   - Edits the user made before submitting are in the base too. They are the
//     changes the user is least interested in reading back: they made them.
//
// Between that base and `to` both actors can have written, so a change carries
// `author`. The view paints Claude's changes as the turn and the user's own as
// muted context. An ABSENT `author` means the log does not attribute the change,
// never "nobody": either no attribution was computed (a plain
// revision-to-revision comparison, `from=` given explicitly) or the event
// behind it names no actor (`doc_added` — see src/engine/diff.ts). The field is
// optional precisely so that neither case can be dressed up as an attribution.
import { z } from "zod";
import { BlockSchema } from "./blocks.ts";
import { ActorSchema, CommentThreadSchema } from "./comment.ts";
import { idString, textString, tokenString } from "./limits.ts";

export const ChangeKindSchema = z.enum(["added", "removed", "modified", "moved", "unchanged"]);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

/** One run of a word-level diff inside a modified block (src/server/worddiff.ts). */
export const WordOpSchema = z.object({
  op: z.enum(["equal", "insert", "delete"]),
  text: textString(),
});
export type WordOp = z.infer<typeof WordOpSchema>;

/** Fields every change carries, whatever its kind. `words` is present only on
 *  `modified`; `author` only when the diff was attributed from the log. */
const changeBase = {
  block_id: idString(),
  author: ActorSchema.optional(),
  words: z.array(WordOpSchema).optional(),
};

// A union rather than one object with optional `from`/`to`: "added has no from"
// is then a type error at the construction site instead of a runtime surprise
// in the view.
export const BlockChangeSchema = z.discriminatedUnion("change", [
  z.object({ ...changeBase, change: z.literal("added"), to: BlockSchema }),
  z.object({ ...changeBase, change: z.literal("removed"), from: BlockSchema }),
  z.object({ ...changeBase, change: z.literal("modified"), from: BlockSchema, to: BlockSchema }),
  z.object({ ...changeBase, change: z.literal("moved"), from: BlockSchema, to: BlockSchema }),
  z.object({ ...changeBase, change: z.literal("unchanged"), from: BlockSchema, to: BlockSchema }),
]);
export type BlockChange = z.infer<typeof BlockChangeSchema>;

export const BlockDiffSchema = z.object({
  changes: z.array(BlockChangeSchema),
  added: z.array(idString()),
  removed: z.array(idString()),
  modified: z.array(idString()),
  moved: z.array(idString()),
});
export type BlockDiff = z.infer<typeof BlockDiffSchema>;

/**
 * Which rule picked `from_seq`. On the wire so the view can say what the diff
 * is against instead of guessing:
 *
 *   last_submit     the user's most recent submit at or before `to` (PI-1).
 *   document_added  no submit yet, so the document's own first state — the
 *                   import. The initial content is the base, never "added".
 *   explicit        the caller named `from=` itself; no attribution is computed.
 */
export const DiffBaseSchema = z.enum(["last_submit", "document_added", "explicit"]);
export type DiffBase = z.infer<typeof DiffBaseSchema>;

export const TurnDiffSchema = z.object({
  doc_id: idString(),
  from_seq: z.number().int(),
  to_seq: z.number().int(),
  base: DiffBaseSchema,
  diff: BlockDiffSchema,
  /**
   * Comment threads with activity inside `(from_seq, to_seq]` (PI-7) — a thread
   * is included when its root OR any of its replies was created in that window.
   *
   * The turn is not only the block edits. A turn that answered three comments
   * and changed no prose used to render as "nothing changed in this document",
   * with the answers sitting in a drawer on a different screen. They ride on the
   * diff because they are part of the same answer to "what happened this turn".
   *
   * Empty for an `explicit` diff: a revision-to-revision comparison the caller
   * asked for is not a turn, so there is no turn's conversation to attach.
   */
  threads: z.array(CommentThreadSchema),
  contract_version: tokenString(),
});
export type TurnDiff = z.infer<typeof TurnDiffSchema>;
