// Compaction Worker (D11). Pure CPU: it receives the exact update blobs the
// main thread pinned, merges them, and hands one blob back. It never touches
// SQLite — bun:sqlite is synchronous and the main thread owns every write.
import * as Y from "yjs";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ updates: Uint8Array[] }>) => {
  const started = performance.now();
  const merged = Y.mergeUpdates(e.data.updates.map((u) => new Uint8Array(u)));
  self.postMessage({ merged, ms: performance.now() - started });
};
