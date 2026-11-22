// The append-only event log (db-design §1). Row shape only — the transaction
// that wraps an append lives in engine.ts, because the append and every
// projection write it implies must share one transaction.
import type { Database } from "bun:sqlite";
import { EventSchema, type Event } from "../contract/index.ts";

type EventRow = {
  event_id: string;
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  client_edit_id: string | null;
  created_at: string;
};

const BASE_KEYS = new Set(["event_id", "session_id", "seq", "created_at", "type"]);

/** payload = the type-specific remainder past EventBase, as JSON (db-design §1). */
export function toRow(event: Event): EventRow {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) if (!BASE_KEYS.has(k)) payload[k] = v;
  return {
    event_id: event.event_id,
    session_id: event.session_id,
    seq: event.seq,
    type: event.type,
    payload: JSON.stringify(payload),
    client_edit_id: "client_edit_id" in event ? event.client_edit_id : null,
    created_at: event.created_at,
  };
}

export function fromRow(row: EventRow): Event {
  return EventSchema.parse({
    event_id: row.event_id,
    session_id: row.session_id,
    seq: row.seq,
    type: row.type,
    created_at: row.created_at,
    ...JSON.parse(row.payload),
  });
}

export function nextSeq(db: Database, session_id: string): number {
  const row = db
    .query<{ next: number }, [string]>(
      "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM event WHERE session_id = ?",
    )
    .get(session_id)!;
  return row.next;
}

export function insertEvent(db: Database, event: Event): void {
  const r = toRow(event);
  db.run(
    `INSERT INTO event (event_id, session_id, seq, type, payload, client_edit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [r.event_id, r.session_id, r.seq, r.type, r.payload, r.client_edit_id, r.created_at],
  );
}

export function readEvents(db: Database, session_id: string, afterSeq = -1): Event[] {
  return db
    .query<EventRow, [string, number]>(
      "SELECT * FROM event WHERE session_id = ? AND seq > ? ORDER BY seq",
    )
    .all(session_id, afterSeq)
    .map(fromRow);
}

export function findByClientEditId(db: Database, client_edit_id: string): Event | null {
  const row = db
    .query<EventRow, [string]>("SELECT * FROM event WHERE client_edit_id = ?")
    .get(client_edit_id);
  return row ? fromRow(row) : null;
}
