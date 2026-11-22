-- 0003_turn_note.sql — the turn note and its spoken form, beside the one-line
-- summary the snapshot already writes.
--
-- Both nullable, and they stay nullable for ever rather than being backfilled.
-- A note is written only when the user asks for one, so MOST revisions will
-- never have either column set, and that is the honest state rather than a gap
-- to fill in. Defaulting them to the turn summary would be worse than NULL: the
-- summary is one line written to label a revision, and presenting it as a note
-- would claim an interpretation nobody made.
--
-- `turn_note` is markdown for the eye; `narration` is the same content flattened
-- into linear prose for an ear. They are stored separately because they are
-- different artifacts, not two renderings of one string: the note keeps its
-- tables and fences, and the narration has already had them turned into
-- sentences. Deriving one from the other later would mean re-deciding, per read,
-- something that was decided once when the note was written.
--
-- The audio is deliberately NOT here. It is a derived cache, regenerable from
-- `narration` at any time, so it lives as a file under the container's
-- `data/narration/` and never touches the log or a projection.
--
-- No PRAGMA here: foreign_keys is per-connection state, set by src/engine/db.ts
-- on every open (SEC-1).

ALTER TABLE revision ADD COLUMN turn_note TEXT;
ALTER TABLE revision ADD COLUMN narration TEXT;
