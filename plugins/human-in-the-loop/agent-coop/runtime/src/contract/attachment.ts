// Attachment wire shapes — contract-design.md §Attachment.
//
// A10 ships in the contract from P1 on, and v1 DOES write these (CQ1): the
// endpoints exist — `POST /api/attachments`, `PATCH /api/attachments/:id/transcript`,
// `POST /api/attachments/:id/retry` in src/server/routes/write.ts — and their
// events project into the `attachment` table (src/engine/projections.ts). What
// v1 has no producer for is a browser UI that calls them, and no `agent_coop_attachment`
// ingest tool: Claude can read an attachment, never create one.
import { z } from "zod";
import { idString, pathString, textString } from "./limits.ts";

export const AttachmentKindSchema = z.enum(["image", "audio"]);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const AttachmentSourceSchema = z.enum(["ui", "phone", "cli"]);
export type AttachmentSource = z.infer<typeof AttachmentSourceSchema>;

export const TranscriptStatusSchema = z.enum(["n/a", "pending", "done", "failed"]);
export type TranscriptStatus = z.infer<typeof TranscriptStatusSchema>;

export const AttachmentCreateSchema = z.object({
  session_id: idString(),
  doc_id: idString().nullable(),
  comment_id: idString().nullable(),
  kind: AttachmentKindSchema,
  source: AttachmentSourceSchema,
  storage_path: pathString(),
});
export type AttachmentCreate = z.infer<typeof AttachmentCreateSchema>;

export const AttachmentSchema = AttachmentCreateSchema.extend({
  attachment_id: idString(),
  transcript_status: TranscriptStatusSchema,
  transcript_text: textString().nullable(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
