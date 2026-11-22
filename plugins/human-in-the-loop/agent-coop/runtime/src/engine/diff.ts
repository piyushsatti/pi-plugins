// Structural block diff between two reconstructed documents (db-design §3.4),
// plus the two questions PI-1 added: what the diff is FROM, and who wrote each
// change.
//
// This is a plain data-level diff over two walked Block[] results, keyed by
// block_id — never a Yjs-level operation, and never a heuristic content match.
// The wire shapes live in src/contract/diff.ts; nothing here defines one.
import type { Database } from "bun:sqlite";
import type { Actor, Block, BlockChange, BlockDiff, DiffBase } from "../contract/index.ts";
import { readEvents } from "./log.ts";
import { blocksAt } from "./replay.ts";

/** Diff two block lists structurally, in `to` order with removals appended.
 *  Pure: it sees no log, so it attributes nothing (`author` stays absent). */
export function diffBlocks(from: Block[], to: Block[]): BlockDiff {
  const fromById = new Map(from.map((b) => [b.block_id, b]));
  const toById = new Map(to.map((b) => [b.block_id, b]));
  const changes: BlockChange[] = [];

  for (const t of to) {
    const f = fromById.get(t.block_id);
    if (f === undefined) {
      changes.push({ change: "added", block_id: t.block_id, to: t });
    } else if (f.content !== t.content) {
      changes.push({ change: "modified", block_id: t.block_id, from: f, to: t });
    } else if (f.order !== t.order) {
      changes.push({ change: "moved", block_id: t.block_id, from: f, to: t });
    } else {
      changes.push({ change: "unchanged", block_id: t.block_id, from: f, to: t });
    }
  }
  for (const f of from) {
    if (!toById.has(f.block_id)) changes.push({ change: "removed", block_id: f.block_id, from: f });
  }

  const pick = (k: BlockChange["change"]) =>
    changes.filter((c) => c.change === k).map((c) => c.block_id);
  return {
    changes,
    added: pick("added"),
    removed: pick("removed"),
    modified: pick("modified"),
    moved: pick("moved"),
  };
}

/** Diff a document between two log positions by reconstructing both (D1).
 *  Unattributed — `turnDiff` is the attributed form. */
export function diffAtSeqs(db: Database, doc_id: string, fromSeq: number, toSeq: number): BlockDiff {
  return diffBlocks(blocksAt(db, doc_id, fromSeq), blocksAt(db, doc_id, toSeq));
}

// --- what the diff is FROM (PI-1) -------------------------------------------

/** The seq of the user's most recent `submit` at or before `atSeq`, or null. */
export function lastSubmitSeq(db: Database, session_id: string, atSeq: number): number | null {
  return (
    db
      .query<{ seq: number | null }, [string, number]>(
        "SELECT MAX(seq) AS seq FROM event WHERE session_id = ? AND type = 'submit' AND seq <= ?",
      )
      .get(session_id, atSeq)?.seq ?? null
  );
}

/**
 * The seq at which a document first had content: the earliest `document_updates`
 * row for it. Inclusive, so reconstructing AT this seq yields the imported
 * blocks — which is the whole point. Diffing a fresh import against the empty
 * document would report every block as added and say nothing about the turn.
 *
 * -1 for a document with no updates at all: there is nothing to be the base of,
 * and reconstructing at -1 is the empty document.
 */
export function documentAddedSeq(db: Database, doc_id: string): number {
  return (
    db
      .query<{ seq: number | null }, [string]>(
        "SELECT MIN(seq) AS seq FROM document_updates WHERE document_id = ?",
      )
      .get(doc_id)?.seq ?? -1
  );
}

/**
 * Where a turn diff of `doc_id` ending at `toSeq` starts: the user's last
 * submit, or the document's own first state when they have not submitted yet.
 *
 * Both branches are inclusive of the seq they name, so everything the user had
 * already seen sits in the base and only what happened afterwards is a change.
 */
export function turnDiffBase(
  db: Database,
  doc_id: string,
  toSeq: number,
): { from_seq: number; base: DiffBase } {
  const session_id = sessionOfDoc(db, doc_id);
  const submitted = session_id === null ? null : lastSubmitSeq(db, session_id, toSeq);
  if (submitted !== null) return { from_seq: submitted, base: "last_submit" };
  return { from_seq: documentAddedSeq(db, doc_id), base: "document_added" };
}

// --- who wrote each change (PI-1) -------------------------------------------

/**
 * Attribute each change to the actor whose event produced it.
 *
 * The rule, in order: the last event in `(fromSeq, toSeq]` whose ops NAME the
 * block owns the change; failing that, the last event in the range that wrote
 * this document at all, because a block can change position without any op
 * naming it (someone inserted a block above it). A change no event in the range
 * explains keeps NO author rather than being handed to a guess.
 *
 * `user_edit` is the user by definition and `claude_apply` is Claude by
 * definition — the turn gate enforces that, so no actor column is consulted.
 *
 * `doc_added` is skipped, and that is a real limitation rather than a tidy rule:
 * the event names no actor because nothing at that seam can authenticate one
 * (the endpoint is reachable by both the browser and the MCP shim, with no auth
 * in v1). So a document added mid-turn reads as wholly added — true, since the
 * user has not seen it — with NO author, which is the honest answer. Nothing
 * here invents one.
 */
export function attributeChanges(
  db: Database,
  doc_id: string,
  fromSeq: number,
  toSeq: number,
  changes: BlockChange[],
): BlockChange[] {
  const session_id = sessionOfDoc(db, doc_id);
  if (session_id === null) return changes;

  const byBlock = new Map<string, Actor>();
  let lastWriter: Actor | undefined;
  for (const event of readEvents(db, session_id, fromSeq)) {
    if (event.seq > toSeq) break;
    if (event.type !== "user_edit" && event.type !== "claude_apply") continue;
    if (event.doc_id !== doc_id) continue;
    const actor: Actor = event.type === "user_edit" ? "user" : "claude";
    lastWriter = actor;
    for (const op of event.ops) byBlock.set(op.block_id, actor);
  }

  return changes.map((c) => {
    if (c.change === "unchanged") return c;
    const author = byBlock.get(c.block_id) ?? lastWriter;
    return author === undefined ? c : { ...c, author };
  });
}

/** The attributed diff the turn-diff screen reads: structural classification
 *  plus an author per change (PI-1). */
export function turnDiff(db: Database, doc_id: string, fromSeq: number, toSeq: number): BlockDiff {
  const diff = diffAtSeqs(db, doc_id, fromSeq, toSeq);
  return { ...diff, changes: attributeChanges(db, doc_id, fromSeq, toSeq, diff.changes) };
}

function sessionOfDoc(db: Database, doc_id: string): string | null {
  return (
    db
      .query<{ session_id: string }, [string]>("SELECT session_id FROM document WHERE id = ?")
      .get(doc_id)?.session_id ?? null
  );
}
