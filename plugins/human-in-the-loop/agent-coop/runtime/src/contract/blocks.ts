// Block and BlockOp wire shapes — contract-design.md §agent_coop_pull batch return.
// Schemas only, no logic (repo-design §Architecture → folder mapping).
// Every string is length-capped through ./limits.ts (SEC-6).
import { z } from "zod";
import { idString, textString } from "./limits.ts";

export const BlockSchema = z.object({
  block_id: idString(),
  content: textString(),
  order: z.number().int(),
});
export type Block = z.infer<typeof BlockSchema>;

export const BlockOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("insert"),
    block_id: idString(),
    after_block_id: idString().nullable(),
    content: textString(),
  }),
  z.object({
    op: z.literal("replace"),
    block_id: idString(),
    content: textString(),
  }),
  z.object({
    op: z.literal("delete"),
    block_id: idString(),
  }),
]);
export type BlockOp = z.infer<typeof BlockOpSchema>;
