// Length caps on every string that crosses the seam (SEC-6). The event log is
// append-only and is never compacted, so an unbounded string on any write
// endpoint is permanent growth in the source of truth — the cap belongs here,
// in the contract, so HTTP, MCP and the reducer all get the same one.
//
// The numbers are CHARACTERS (Zod's `.max()` counts UTF-16 code units), not
// bytes: a cap of 65_536 admits up to ~192 KiB of UTF-8 in the worst case. That
// is deliberate — the cap exists to bound growth, and a byte-exact bound would
// need a second validation pass that buys nothing here. The byte-level bound is
// `MAX_REQUEST_BODY_BYTES`, enforced by the HTTP server itself.
import { z } from "zod";

/** Identifiers: session, document, block, comment, attachment, revision. */
export const MAX_ID_LEN = 256;
/** Filesystem paths (`source_path`, `storage_path`, an export target). */
export const MAX_PATH_LEN = 4_096;
/** Human-authored bodies: comment text, block content, turn summary, transcript. */
export const MAX_TEXT_LEN = 65_536;
/** Short human-authored labels: session and document titles. */
export const MAX_TITLE_LEN = 1_024;
/** Opaque machine strings: a Yjs relative position, an ISO timestamp. */
export const MAX_TOKEN_LEN = 4_096;

/** Whole-request byte cap, handed to Bun.serve. Generous enough for an
 *  attachment upload (A10) and for a comment carrying MAX_AUDIO_B64_LEN of
 *  voice audio, the two large bodies agent-coop accepts. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Base64 of 16 kHz mono Int16 PCM samples, riding a comment's `audio` field
 * (src/contract/comment.ts `CommentAudioSchema`). Base64 costs 4/3 the raw
 * size, so 12M characters is roughly nine megabytes of samples: at 16 kHz
 * mono 16-bit that is about 4 minutes 55 seconds of speech, comfortably
 * inside MAX_REQUEST_BODY_BYTES while still bounding what a single request
 * can carry. A voice comment past that length is a recording,
 * not a comment, and belongs to the attachment path this feature does not
 * use.
 */
export const MAX_AUDIO_B64_LEN = 12 * 1024 * 1024;

export const idString = () => z.string().min(1).max(MAX_ID_LEN);
export const pathString = () => z.string().min(1).max(MAX_PATH_LEN);
export const textString = () => z.string().max(MAX_TEXT_LEN);
export const titleString = () => z.string().max(MAX_TITLE_LEN);
export const tokenString = () => z.string().max(MAX_TOKEN_LEN);
export const audioB64String = () => z.string().max(MAX_AUDIO_B64_LEN);
