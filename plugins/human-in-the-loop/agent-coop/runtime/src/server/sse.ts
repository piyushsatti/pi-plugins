// SSE fan-out — contract-design.md §SSE event catalog. One channel,
// /api/events, emitted by the same process that writes (R4): there is no
// second writer and therefore no cross-process fan-out problem.
import { SseEventSchema, type SseEvent, type SseEventName } from "../contract/index.ts";

type Sink = (frame: string) => void;

/** Comment-frame interval. Must stay well under the server's idleTimeout. */
export const HEARTBEAT_MS = 20_000;

/** Wire framing for one catalog event. */
export function frame(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export class Broadcaster {
  private readonly sinks = new Set<Sink>();
  private readonly listeners = new Set<(e: SseEvent) => void>();

  get clientCount(): number {
    return this.sinks.size;
  }

  /** In-process listeners currently registered. A long poll that failed to
   *  unsubscribe shows up here and nowhere else, so a test can prove the
   *  teardown rather than assume it. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Validate against the catalog, then fan out. An event that does not parse
   *  is a contract bug and must fail loudly here, not silently on the client. */
  send(event: SseEvent): void {
    const parsed = SseEventSchema.parse(event) as SseEvent;
    const text = frame(parsed);
    for (const sink of this.sinks) {
      try {
        sink(text);
      } catch {
        this.sinks.delete(sink); // client went away mid-write
      }
    }
    for (const listener of this.listeners) listener(parsed);
  }

  /** In-process subscription: the same catalog rows the browsers get, delivered
   *  to code inside this process. `GET /api/turn/wait` (routes/read.ts) waits on
   *  it rather than polling SQLite, and the tests read it. Listeners run
   *  synchronously inside `send`, and unsubscribing from within one is safe —
   *  deleting from a Set mid-iteration is defined. */
  subscribe(fn: (e: SseEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The HTTP response for GET /api/events. */
  response(): Response {
    const encoder = new TextEncoder();
    let sink: Sink;
    const sinks = this.sinks;
    // Heartbeat keeps the stream non-idle so the server can keep a bounded
    // idleTimeout instead of disabling it globally for every connection.
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sink = (text) => controller.enqueue(encoder.encode(text));
        sinks.add(sink);
        controller.enqueue(encoder.encode(": connected\n\n"));
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            if (heartbeat !== null) clearInterval(heartbeat);
          }
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
      },
      cancel() {
        if (heartbeat !== null) clearInterval(heartbeat);
        sinks.delete(sink);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
}

export type { SseEvent, SseEventName };
