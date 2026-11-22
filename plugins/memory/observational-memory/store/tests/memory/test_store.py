"""Versioned store safety and migration preview."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from hashlib import sha256

import pytest

from memory import store
from memory.admin import migration_preview


def test_root_defaults_to_local_state_and_honours_override(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("MEMORY_ROOT", raising=False)

    assert store.root() == (home / ".local/state/memory").resolve()

    existing = tmp_path / "existing-store"
    monkeypatch.setenv("MEMORY_ROOT", str(existing))
    assert store.root() == existing.resolve()


def test_root_rejects_relative_memory_override(monkeypatch):
    monkeypatch.setenv("MEMORY_ROOT", "relative/memory")
    with pytest.raises(ValueError, match="MEMORY_ROOT must be an absolute path"):
        store.root()


@pytest.fixture
def scope():
    return store.Scope(key="project:alpha", depth=2, role="repo")


@pytest.fixture
def provenance():
    return [store.Provenance(adapter="fixture", source_ref="case-1", hash="0" * 64)]


def test_v3_round_trip_has_stable_identity_and_explicit_scope(tmp_path, scope, provenance):
    saved = store.save(
        "thing",
        "reference",
        "# Thing\n\nDetail.",
        "specific",
        scope,
        provenance,
        stable_id="mem-test-001",
        directory=tmp_path,
    )
    loaded = store.load(saved.path)
    assert loaded.stable_id == "mem-test-001"
    assert loaded.frontmatter.scope == scope
    assert loaded.frontmatter.schema_version == 3
    assert loaded.frontmatter.status == "active"


def test_schema_v2_is_read_without_rewrite(tmp_path):
    path = tmp_path / "2026-09-01-reference_old.md"
    original = b"""---
created: 2026-09-01
type: reference
scope: {depth: 0, role: home}
genericity: specific
last_updated: 2026-09-01
schema_version: 2
---

# Old
"""
    path.write_bytes(original)
    entry = store.load(path)
    assert entry.frontmatter.schema_version == 2
    assert entry.stable_id is None
    assert path.read_bytes() == original


def test_explicit_v2_migration_retains_exact_legacy_revision(tmp_path, provenance):
    path = tmp_path / "2026-09-01-reference_old.md"
    original = b"""---
created: 2026-09-01
type: reference
scope: {depth: 0, role: home}
genericity: specific
last_updated: 2026-09-01
schema_version: 2
---

# Old
"""
    path.write_bytes(original)
    legacy_hash = sha256(original).hexdigest()
    migrated = store.migrate_v2(
        path,
        slug="old",
        type="reference",
        body="# Old\n",
        genericity="specific",
        scope=store.Scope(key="home", depth=0, role="home"),
        provenance=provenance,
        stable_id="mem-legacy",
        status="active",
        created=date.fromisoformat("2026-09-01"),
        last_updated=date.fromisoformat("2026-09-01"),
        expected_hash=legacy_hash,
    )
    assert migrated.frontmatter.schema_version == 3
    revision = store.load_revision("mem-legacy", legacy_hash, tmp_path)
    assert revision.frontmatter.schema_version == 2
    assert revision.path.read_bytes() == original


def test_v2_migration_preserves_hash_pinned_filename_when_type_prefix_differs(tmp_path, provenance):
    path = tmp_path / "2026-09-01-workflow_old.md"
    original = b"""---
created: 2026-09-01
type: workflow
scope: {depth: 0, role: home}
genericity: specific
last_updated: 2026-09-01
schema_version: 2
---

# Old
"""
    path.write_bytes(original)
    legacy_hash = sha256(original).hexdigest()

    migrated = store.migrate_v2(
        path,
        slug="old",
        type="reference",
        body="# Old\n",
        genericity="specific",
        scope=store.Scope(key="home", depth=0, role="home"),
        provenance=provenance,
        stable_id="mem-legacy-mismatch",
        status="active",
        created=date.fromisoformat("2026-09-01"),
        last_updated=date.fromisoformat("2026-09-01"),
        expected_hash=legacy_hash,
    )

    assert migrated.path == path
    assert migrated.frontmatter.type == "reference"
    assert migrated.frontmatter.created == date.fromisoformat("2026-09-01")
    assert migrated.body == "# Old\n"
    revision = store.load_revision("mem-legacy-mismatch", legacy_hash, tmp_path)
    assert revision.path.read_bytes() == original


def test_unknown_schema_is_reported_for_review(tmp_path):
    (tmp_path / "unknown.md").write_text("---\nschema_version: 99\n---\n# x\n")
    entries, problems = store.scan(tmp_path)
    assert entries == []
    assert "unsupported schema_version 99" in problems[0][1]


def test_replace_requires_expected_hash_and_retains_revision(tmp_path, scope, provenance):
    first = store.save(
        "thing",
        "reference",
        "# Before",
        "specific",
        scope,
        provenance,
        stable_id="mem-test-002",
        directory=tmp_path,
    )
    with pytest.raises(store.ConflictError):
        store.save(
            "thing",
            "reference",
            "# Unsafe",
            "specific",
            scope,
            provenance,
            stable_id="mem-test-002",
            directory=tmp_path,
        )
    second = store.save(
        "thing",
        "reference",
        "# After",
        "specific",
        scope,
        provenance,
        stable_id="mem-test-002",
        expected_hash=first.content_hash,
        directory=tmp_path,
    )
    assert second.body.startswith("# After")
    assert store.load_revision("mem-test-002", first.content_hash, tmp_path).body.startswith(
        "# Before"
    )


def test_concurrent_replacements_do_not_last_write_win(tmp_path, scope, provenance):
    first = store.save(
        "thing",
        "reference",
        "# Base",
        "specific",
        scope,
        provenance,
        stable_id="mem-test-003",
        directory=tmp_path,
    )

    def replace(body):
        try:
            return store.save(
                "thing",
                "reference",
                body,
                "specific",
                scope,
                provenance,
                stable_id="mem-test-003",
                expected_hash=first.content_hash,
                directory=tmp_path,
            ).body
        except store.ConflictError:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(replace, ["# One", "# Two"]))
    assert results.count("conflict") == 1
    assert store.load(first.path).body.strip() in {"# One", "# Two"}


def test_duplicate_stable_ids_block_mutation(tmp_path, scope, provenance):
    first = store.save(
        "one",
        "reference",
        "# One",
        "specific",
        scope,
        provenance,
        stable_id="mem-duplicate",
        directory=tmp_path,
    )
    (tmp_path / "2026-09-06-reference_two.md").write_bytes(first.path.read_bytes())
    with pytest.raises(store.ConflictError, match="duplicate stable id"):
        store.save(
            "one",
            "reference",
            "# Changed",
            "specific",
            scope,
            provenance,
            stable_id="mem-duplicate",
            expected_hash=first.content_hash,
            directory=tmp_path,
        )


def test_revision_histories_do_not_alias_similar_stable_ids(tmp_path, scope, provenance):
    colon = store.save(
        "colon",
        "reference",
        "# Colon before",
        "specific",
        scope,
        provenance,
        stable_id="mem:a",
        directory=tmp_path,
    )
    underscore = store.save(
        "underscore",
        "reference",
        "# Underscore before",
        "specific",
        scope,
        provenance,
        stable_id="mem_a",
        directory=tmp_path,
    )
    store.save(
        "colon",
        "reference",
        "# Colon after",
        "specific",
        scope,
        provenance,
        stable_id="mem:a",
        expected_hash=colon.content_hash,
        directory=tmp_path,
    )
    store.save(
        "underscore",
        "reference",
        "# Underscore after",
        "specific",
        scope,
        provenance,
        stable_id="mem_a",
        expected_hash=underscore.content_hash,
        directory=tmp_path,
    )
    assert store.revisions("mem:a", tmp_path) == [colon.content_hash]
    assert store.revisions("mem_a", tmp_path) == [underscore.content_hash]
    with pytest.raises(FileNotFoundError):
        store.load_revision("mem:a", underscore.content_hash, tmp_path)
    colon_revision_dir = tmp_path / ".revisions" / sha256(b"mem:a").hexdigest()
    mismatched = colon_revision_dir / f"{underscore.content_hash}.md"
    mismatched.write_bytes(
        store.load_revision("mem_a", underscore.content_hash, tmp_path).path.read_bytes()
    )
    with pytest.raises(store.ConflictError, match="identity mismatch"):
        store.load_revision("mem:a", underscore.content_hash, tmp_path)


def test_migration_preview_is_reviewable_and_does_not_write(tmp_path):
    path = tmp_path / "2026-09-01-reference_old.md"
    path.write_text("""---
created: 2026-09-01
type: reference
scope: {depth: 1, role: repo}
genericity: specific
last_updated: 2026-09-01
schema_version: 2
---
# Old
""")
    before = sha256(path.read_bytes()).hexdigest()
    unresolved = migration_preview(tmp_path)
    proposed = migration_preview(tmp_path, "project:alpha")
    assert unresolved["records"][0]["disposition"] == "review"
    assert proposed["records"][0]["record"]["scope"]["key"] == "project:alpha"
    assert proposed["records"][0]["expected_hash"] == before
    assert proposed["manifest"]["approved"] is False
    assert proposed["manifest"]["candidates"][0]["source_schema_version"] == 2
    assert proposed["manifest"]["candidates"][0]["record"]["body"].startswith("# Old")
    assert sha256(path.read_bytes()).hexdigest() == before


def test_migration_preview_maps_only_explicit_legacy_home_scope(tmp_path):
    path = tmp_path / "2026-09-01-reference_home.md"
    path.write_text("""---
created: 2026-09-01
type: reference
scope: {depth: 0, role: home}
genericity: specific
last_updated: 2026-09-01
schema_version: 2
---
# Home
""")
    before = path.read_bytes()
    proposed = migration_preview(tmp_path)
    assert proposed["records"][0]["disposition"] == "proposed"
    assert proposed["records"][0]["record"]["scope"] == {
        "key": "home",
        "depth": 0,
        "role": "home",
    }
    assert path.read_bytes() == before


def test_migration_preview_keeps_noncanonical_filename_in_review(tmp_path):
    path = tmp_path / "workflow_pending_cleanup.md"
    path.write_text("""---
created: 2026-09-01
type: workflow
scope: {depth: 0, role: home}
genericity: specific
last_updated: 2026-09-01
schema_version: 2
---
# Pending cleanup
""")
    before = path.read_bytes()
    preview = migration_preview(tmp_path)
    assert preview["records"][0]["disposition"] == "review"
    assert "filename" in preview["records"][0]["reason"]
    assert "record" not in preview["records"][0]
    assert preview["manifest"]["candidates"] == []
    assert path.read_bytes() == before
