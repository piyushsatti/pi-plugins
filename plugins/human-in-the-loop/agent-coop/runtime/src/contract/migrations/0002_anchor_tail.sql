-- 0002_anchor_tail.sql — PI-6: a comment anchor pins BOTH ends of its run.
-- Source: contract-design.md §Comment anchor (src/contract/anchor.ts).
--
-- Nullable, and it stays nullable forever rather than being backfilled: a Yjs
-- relative position cannot be reconstructed for a row that never recorded one.
-- A NULL tail resolves to anchor_state 'detached' (src/server/anchors.ts), which
-- is the honest answer for an anchor whose extent was never stored. Defaulting
-- it to the head, or re-deriving it from quoted_text's length, would recreate
-- exactly the confidently-wrong highlight this migration exists to remove.
--
-- No PRAGMA here: foreign_keys is per-connection state, set by src/engine/db.ts
-- on every open (SEC-1).

ALTER TABLE comment ADD COLUMN relative_position_end TEXT;
