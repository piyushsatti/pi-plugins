// One esbuild invocation bundling web/src/app.js -> web/dist/app.js, plus the
// two static files the page needs. No vendoring, no hand-copied deps
// (ui-design §Build).
//
// `splitting` is what makes mermaid affordable (A9). It used to be `external`,
// which kept it out of the bundle by leaving `import("mermaid")` in the output —
// a bare specifier no browser can resolve, so the diagram could never draw. With
// splitting on, the dynamic import in web/src/components/mermaid-block.js becomes
// its own chunk (and mermaid's own per-diagram imports become more chunks): app.js
// stays small, and the diagram library is fetched by the first page that has a
// diagram on it. Every chunk lands in web/dist, which is what src/server/static.ts
// serves, so nothing else has to know they exist.
//
// It also regenerates web/src/contract.gen.js from src/contract first — the one
// hand-copy web/ used to contain (B2/CQ5), now an artifact.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { generateContractModule } from "./gen-contract.ts";

const repoRoot = join(import.meta.dir, "..");
const webRoot = join(repoRoot, "web");
const outdir = join(webRoot, "dist");

export const buildOptions: esbuild.BuildOptions = {
  entryPoints: [join(webRoot, "src", "app.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  // `outdir` rather than `outfile`: splitting emits chunks beside the entry.
  // The entry keeps its name (index.html asks for /app.js by name).
  outdir,
  splitting: true,
  logLevel: "silent",
};

/**
 * Empty web/dist. Its own function, and named for the deletion, because it IS a
 * recursive delete: chunk names carry a content hash, so a rebuild leaves the
 * previous build's chunks behind for ever unless the directory goes.
 *
 * It used to be the first two lines of `copyStatic`, which is how a function
 * called "copy two files" deleted a directory — the one call anybody would think
 * safe to make on its own. Nothing in web/dist is a source; it is all output
 * (README §Structure), which is what makes the delete correct here and nowhere
 * else.
 */
export function cleanDist(): void {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
}

/** The two static files the page needs, beside the bundle. Copies, nothing more:
 *  it creates the directory if it is missing and deletes nothing. */
export function copyStatic(): void {
  mkdirSync(outdir, { recursive: true });
  cpSync(join(webRoot, "index.html"), join(outdir, "index.html"));
  cpSync(join(webRoot, "app.css"), join(outdir, "app.css"));
}

export async function build(watch = false): Promise<void> {
  // Before esbuild sees web/src: the contract's enums are regenerated so a bundle
  // can never be built against a stale copy of them (B2/CQ5).
  generateContractModule();
  cleanDist();
  copyStatic();
  if (!watch) {
    await esbuild.build(buildOptions);
    return;
  }
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
}

if (import.meta.main) {
  await build(process.argv.includes("--watch"));
  console.log(`built ${outdir}`);
}
