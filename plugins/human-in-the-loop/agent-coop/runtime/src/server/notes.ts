// The narration audio cache and its background render.
//
// The audio is a derived CACHE, never a fact of the log: it is regenerable at
// any time from `revision.narration` (migrations/0003_turn_note.sql), so
// nothing in this module writes an event or a projection. That is also why its
// two SSE frames (narration_ready/narration_failed, src/contract/sse.ts) are
// broadcast DIRECTLY from here rather than through src/server/emit.ts —
// emit.ts's whole job is mapping a committed LOG EVENT to its SSE rows, and
// there is no event behind either of these two. This module is the only one
// that may send them.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { backendFor, synthesize } from "../speech/index.ts";
import type { ServerContext } from "./context.ts";

/**
 * In-flight renders kept on `ctx.narrations` are bounded the same way
 * `ctx.backups` is (src/server/routes/write.ts `snapshot`, SEC-4 reasoning):
 * unbounded promise accumulation is a leak for the process lifetime. Ten in
 * flight is far more than one person's session ever has open at once.
 */
export const MAX_NARRATION_RENDERS = 10;

/**
 * Where a revision's narration audio lives, named from the revision ROW id
 * (never the label — the two are not interchangeable; see the suffix rule in
 * src/engine/projections.ts).
 *
 * The FILENAME is DERIVED, never caller-supplied — no request chooses it — so,
 * unlike an export target (SEC-3, src/export/index.ts), there is no containment
 * check to do here. Never import from src/export for that reason; it solves a
 * different problem (a caller naming an arbitrary path) than this function has.
 *
 * The DIRECTORY comes from the context, exactly as `backupDir` and
 * `artifactsDir` do, and for exactly their reason: a module-level constant would
 * resolve to the real `../data/narration` in every process that imported it,
 * INCLUDING the test suite. That is not hypothetical — a version of this file
 * read the constant directly, so `bun test` wrote audio into the live data
 * directory and then deleted the whole of it on the way out. Any writable
 * location agent-coop touches has to be reachable through the context, or a test run
 * is a data-loss event. tests/qa/render-qa.ts refuses to start for the same
 * reason.
 */
export function narrationPath(narrationDir: string, revisionRowId: string, ext: string): string {
  return join(narrationDir, `${revisionRowId.replace(/:/g, "-")}${ext}`);
}

/**
 * Render one revision's narration audio and report the outcome over SSE.
 *
 * NEVER throws into its caller. src/server/routes/write.ts `createNote` starts
 * this only AFTER its own HTTP response has already gone out, so there is no
 * request left to fail — every failure here, including an unavailable
 * backend, ends in a `narration_failed` broadcast rather than a rejected
 * promise nobody is positioned to catch.
 */
export async function renderNarration(
  ctx: Pick<ServerContext, "sse" | "speechBackend" | "narrationDir">,
  doc_id: string,
  revision_id: string,
  revisionRowId: string,
  text: string,
): Promise<void> {
  try {
    await mkdir(ctx.narrationDir, { recursive: true });
    // The backend owns its container, so the path is computed from the SAME
    // backend that is about to write it. Reading a constant here instead would
    // name a `.m4a` file whatever the engine actually emitted.
    const backend = ctx.speechBackend ?? backendFor();
    const result = await synthesize(
      text,
      narrationPath(ctx.narrationDir, revisionRowId, backend.ext),
      backend,
    );
    ctx.sse.send({
      event: "narration_ready",
      data: { doc_id, revision_id, duration_ms: result.duration_ms },
    });
  } catch (err) {
    // A failed render never blocks the note itself — the text already landed
    // in the same request that kicked this off. This frame only tells the
    // browser why the audio specifically is still missing.
    ctx.sse.send({
      event: "narration_failed",
      data: { doc_id, revision_id, reason: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Kick off a render without waiting for it, tracked on `ctx.narrations` —
 * bounded exactly like `ctx.backups` (src/server/routes/write.ts `snapshot`):
 * capped at MAX_NARRATION_RENDERS, newest last. Dropping an older entry only
 * releases the reference; the render it points at keeps running and still
 * reports itself over SSE when it finishes, whether or not anything is still
 * holding its promise.
 */
export function startNarrationRender(
  ctx: ServerContext,
  doc_id: string,
  revision_id: string,
  revisionRowId: string,
  text: string,
): void {
  ctx.narrations.push(renderNarration(ctx, doc_id, revision_id, revisionRowId, text));
  if (ctx.narrations.length > MAX_NARRATION_RENDERS) {
    ctx.narrations.splice(0, ctx.narrations.length - MAX_NARRATION_RENDERS);
  }
}
