# Reference distribution and maintenance

> Native plugin note, 2026-10-22: the importer and selection below belong to an earlier, retired build that is not part of this repository. This folder's `references/source/` is a byte-for-byte copy of its output; `tests/test_manifold.py` checks every file against the hashes in `references/source-manifest.json`. Paths below are relative to that build.

The ontology authority remains `Knowledge/standards/manifold`. This plugin owns
application methods, lenses, role instructions, templates and worked assistance
examples and global establishment/storage policy; it does not independently maintain
Manifold's meanings. It makes no claim
of a released standard version. Plugin version 0.1.0 followed the earlier build's plugin
version convention and is unrelated to standard acceptance or revision identity.

The build-time selection is `scripts/manifold-reference-selection.json` in the
repository. It selects 39 owning/reference documents and scoped decisions, not the
whole Knowledge collection. It excludes transcripts, task/event ledgers, private
case records and most research/review history. Process/history excerpts omit
unneeded development sections; most owning pages omit historical semantic-review
footers. The reconciliation and acceptance map preserve the interpretation of those
historical findings without copying every historical review. Original hypothetical
learning/payroll and report cases are retained as interpretation aids.

`vendor/upstream/manifold/source/` retains the selected original files unchanged.
Its `provenance.json` records import time, Knowledge HEAD, dirty/untracked state and
per-file SHA-256 hashes. At this import the collection is untracked, so HEAD alone
is explicitly insufficient. Source document IDs, raw file hashes and excerpt spans
identify the actual imported text. Source frontmatter authorship is retained in
[the runtime manifest](references/source-manifest.json); unknown authorship is not
silently reassigned to the plugin author. Imported source copyright and MIT license
are preserved in [LICENSE-MIT.txt](references/LICENSE-MIT.txt).

Excerpt offsets are zero-based JavaScript UTF-16 string indices into the decoded
source, with an exclusive end; hashes cover the UTF-8 encoding of those exact spans.

The deterministic build-time importer projects selected body spans into
`src/plugins/manifold/references/source/`. It adds source/standing notices and
rewrites Markdown destinations for portability, including normalized heading anchors.
Links outside the selected text resolve to [explicit unavailable source locators](references/source-locators.md),
not broken private-checkout paths. Those locators are provenance, not a source-text
fallback. Each output hash is recorded alongside the original file/excerpt hash,
source identity, page status and provision-level standing. Textual definitions remain
source excerpts; routing summaries cannot supersede them.

To reproduce/check from the retained vendor snapshot, run from the repository root:

```sh
node --import tsx scripts/manifold-references.ts --check
node --import tsx scripts/manifold-references.ts
```

To update from an authorized canonical checkout:

```sh
node --import tsx scripts/manifold-references.ts --import /path/to/Knowledge/standards/manifold
```

Before importing, read relevant owning changes and later scoped decisions, then review
the selection and standing annotations. Import refreshes only this selected vendor
snapshot and generated references; it never writes to Knowledge. Review the source
hash changes, excerpt/link changes, provision standing and affected skill assumptions.
Record the new reference basis, rerun package checks and affected behavioral cases,
and preserve previous evaluation receipts at their old basis. A substantive source
conflict requires a scoped question; do not silently fix an ontology in this plugin.
Do not manually edit generated references. Update an erroneous source meaning through
its canonical owner in a separately authorized task.
Removed selections are pruned from the generated `references/source/` subtree, and
`--check` rejects obsolete files there. Retained vendor originals can remain as
historical provenance; the current selection and manifest define the runtime basis.

The normal repository compiler copies canonical plugin content into disposable
`dist/codex/manifold`, `dist/claude/manifold` and `dist/pi/manifold` packages and adds
package provenance/checksums. It needs neither the Knowledge checkout nor network
access. The importer is a development command, not an installed runtime service.
No background refresh, global install or publication is part of this implementation.
