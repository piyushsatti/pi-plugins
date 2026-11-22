// ApplyPayload / ApplyResult — contract-design.md §claude_apply payload.
import { z } from "zod";
import { idString } from "./limits.ts";
import { BlockSchema, BlockOpSchema } from "./blocks.ts";

export const ApplyPayloadSchema = z.object({
  doc_id: idString(),
  ops: z.array(BlockOpSchema),
  client_edit_id: idString(), // idempotency key; retries with same id are no-ops
});
export type ApplyPayload = z.infer<typeof ApplyPayloadSchema>;

export const ApplyResultSchema = z.object({
  applied_block_map: z.record(idString(), BlockSchema),
  pending_interrupts: z.number().int(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;
