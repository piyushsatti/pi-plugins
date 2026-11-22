// PullBatch — contract-design.md §agent_coop_pull batch return.
import { z } from "zod";
import { idString, tokenString } from "./limits.ts";
import { BlockSchema, BlockOpSchema } from "./blocks.ts";
import { CommentSchema } from "./comment.ts";

/**
 * `comments` carries only ROOT comments — every row with `parent_id === null`
 * that is still open (PULL-ROOTS-ONLY).
 *
 * A reply is a comment row like any other, so a batch built from "every open
 * comment in the session" handed Claude its OWN replies back on the next pull,
 * as things to answer. They never resolve (nothing resolves a reply), so they
 * accumulate: every turn's replies ride along in every later turn's batch, and
 * the batch grows without bound while telling Claude to respond to itself.
 *
 * Filtering by AUTHOR is not available and never will be at this seam: the
 * `comment_reply` endpoint authenticates no actor (see the note on
 * `CommentThreadSchema` in ./comment.ts), so "drop Claude's replies" is a claim
 * the code cannot make. Structure is the only thing it can read, and structure
 * is enough: what needs answering is a thread, and a thread is named by its
 * root.
 *
 * The cost, stated rather than hidden: a reply the USER writes on an existing
 * thread does not reach the batch either. Its root does — it is still open — so
 * the thread is still in front of Claude, but the reply's text is not, and
 * reading it means reading the thread (`GET /api/comments?doc_id=`, which
 * carries every row). A batch cannot distinguish the two authors, so it has to
 * pick one failure, and re-asking a question is cheaper than answering yourself
 * for ever.
 */
export const PullBatchSchema = z.object({
  session_id: idString(),
  turn_started_at_seq: z.number().int(),
  docs: z.array(z.object({ doc_id: idString(), blocks: z.array(BlockSchema) })),
  comments: z.array(CommentSchema),
  user_edits_since_last_revision: z.array(BlockOpSchema),
  contract_version: tokenString(),
});
export type PullBatch = z.infer<typeof PullBatchSchema>;
