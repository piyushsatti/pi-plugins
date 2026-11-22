// src/export — A8, db-design §5. Walk the document's current blocks,
// concatenate their raw markdown, write the file. The only DB write is the
// `export` event (and the `document.export_path` projection it produces),
// appended by the server AFTER the bytes are on disk — so the log never claims
// an export that did not land.
//
// Knows nothing about HTTP: it takes blocks and a path and returns where it
// wrote. The endpoint in src/server/routes/write.ts owns the event.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { MAX_PATH_LEN, type Block } from "../contract/index.ts";
import { blocksToMarkdown } from "./markdown.ts";

export * from "./markdown.ts";

export type ExportResult = { path: string; bytes: number };

/** A rejected export target (SEC-3). Carries no filesystem detail beyond the
 *  path the caller already supplied. */
export class ExportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportPathError";
  }
}

/** A document title -> a safe file name. Only used when no path is given. */
export function defaultFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug === "" ? "document" : slug}.md`;
}

/**
 * The real location `p` names, for containment purposes.
 *
 * `p` usually does not exist yet (that is the point of an export) and
 * `realpathSync` fails on a missing path — so this resolves the deepest
 * ancestor that DOES exist and re-attaches the rest. Symlinks in the existing
 * part are followed, which is the whole reason this is not a string comparison:
 * a symlink inside `artifacts/` pointing at `/etc` has an innocent-looking
 * textual path and a containment-breaking real one.
 */
function realLocation(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(head)) {
      const real = realpathSync(head);
      return tail.length === 0 ? real : join(real, ...tail);
    }
    const parent = dirname(head);
    if (parent === head) return resolve(p); // reached the root; nothing left to resolve
    tail.unshift(basename(head));
    head = parent;
  }
}

/** True when `target` is `root` itself or something underneath it. Both sides
 *  must already be real locations, or a symlink defeats the check. */
function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Where an export lands: always inside `artifactsDir` (SEC-3).
 *
 * A relative path resolves under it; an absolute path is accepted only when it
 * already points inside it. Anything else — a `../` climb, an absolute path
 * elsewhere, a symlink pointing out — throws `ExportPathError`. Containment is
 * decided on the resolved, symlink-followed location of both sides, never on a
 * string prefix of what the caller typed.
 *
 * The value returned is the resolved (not realpath'd) target, so the caller
 * gets back the path it asked for rather than a rewritten one.
 */
export function resolveExportPath(
  artifactsDir: string,
  title: string,
  requested?: string | null,
): string {
  const raw = requested === undefined || requested === null || requested.trim() === ""
    ? defaultFileName(title)
    : requested;
  if (raw.length > MAX_PATH_LEN) {
    throw new ExportPathError(`export path is longer than ${MAX_PATH_LEN} characters`);
  }
  if (raw.includes("\0")) throw new ExportPathError("export path contains a NUL byte");

  const target = isAbsolute(raw) ? resolve(raw) : resolve(join(artifactsDir, raw));
  const root = realLocation(artifactsDir);
  if (!contains(root, realLocation(target))) {
    throw new ExportPathError(`export path escapes the artifacts directory: ${raw}`);
  }
  return target;
}

/** Write the blocks' markdown to `path`, creating the directory if needed. */
export function writeMarkdown(blocks: Block[], path: string): ExportResult {
  const text = blocksToMarkdown(blocks);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return { path, bytes: Buffer.byteLength(text, "utf8") };
}
