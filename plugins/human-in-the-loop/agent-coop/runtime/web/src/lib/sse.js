// Subscribes /api/events and dispatches contract-design's SSE catalog
// verbatim. No reconnect/backoff logic in the slice: a dropped stream is a
// loud console error, matching ui-design's "failures should be loud".
//
// The catalog is imported, not listed (B2/CQ5). The hand-written copy that used
// to be here had eight of the contract's nine names — `doc_added` was missing, so
// a document joining an open session updated nothing and no test could see it,
// because a name absent from an EventSource subscription fails silently. Adding
// a row to the contract now reaches the browser by regenerating, not by
// remembering.
import { SSE_EVENT_NAMES } from "../contract.gen.js";

// Re-exported so callers and tests read the catalog through the module that
// subscribes to it, rather than each reaching for the generated file.
export { SSE_EVENT_NAMES };

/**
 * @param {(name: string, data: unknown) => void} onEvent
 * @returns {{ close: () => void }}
 */
export function connect(onEvent, url = "/api/events") {
  const source = new EventSource(url);
  for (const name of SSE_EVENT_NAMES) {
    source.addEventListener(name, (ev) => {
      let data = null;
      try {
        data = JSON.parse(ev.data);
      } catch {
        console.error("agent-coop: unparseable SSE payload", name, ev.data);
        return;
      }
      onEvent(name, data);
    });
  }
  source.addEventListener("error", () => console.error("agent-coop: SSE stream error"));
  return { close: () => source.close() };
}
