"""Ingest, hybrid search and status against a real LanceDB index on disk.

These are not mocked. The point of the hybrid design is that the two halves fail
differently, and a mock would hide exactly that.
"""

import pytest

from rag import store


@pytest.fixture(scope="module")
def project(tmp_path_factory):
    root = tmp_path_factory.mktemp("project")
    (root / "docs").mkdir()
    (root / "docs" / "gateway.md").write_text(
        "# Gateway\n\n"
        "One OpenAI-compatible endpoint in front of every model.\n\n"
        "## Health check\n\n"
        "Run `curl -sf http://localhost:4000/health/liveliness` to tell dead from idle.\n\n"
        "## Overhead\n\n"
        "Proxying autocomplete costs seven milliseconds at the median.\n"
    )
    (root / "docs" / "storage.md").write_text(
        "# Storage\n\n"
        "Documents are chunked by heading and embedded locally.\n\n"
        "## Retention\n\n"
        "Old snapshots are pruned after ninety days.\n"
    )
    (root / "README.md").write_text("# Project\n\nA thing that does something.\n")
    # Must be ignored: excluded directory, and a non-document extension.
    (root / ".venv").mkdir()
    (root / ".venv" / "junk.md").write_text("# Junk\n\nShould never be indexed.\n")
    (root / "main.py").write_text("print('not a document')\n")

    store.ingest(root)
    return root


def test_ingest_indexes_documents_and_skips_excluded_paths(project):
    state = store.status(project)
    assert state["indexed"] is True
    assert state["files"] == 3, state["sources"]
    assert state["chunks"] > 5
    assert not any("junk" in s for s in state["sources"])
    assert not any(s.endswith(".py") for s in state["sources"])


def test_discover_excludes_old_pi_state(tmp_path):
    (tmp_path / "README.md").write_text("# Included\n", encoding="utf-8")
    state = tmp_path / ".pi/rag"
    state.mkdir(parents=True)
    (state / "receipt.md").write_text("# Internal\n", encoding="utf-8")

    assert [path.relative_to(tmp_path).as_posix() for path in store.discover(tmp_path)] == [
        "README.md"
    ]


def test_status_distinguishes_missing_from_empty(tmp_path):
    state = store.status(tmp_path)
    assert state["indexed"] is False
    assert state["chunks"] == 0
    assert "hint" in state, "a missing index must say what to do about it"


def test_full_text_half_finds_an_exact_identifier(project):
    """Weak static embeddings miss literal strings. This is what the text half is for."""
    hits = store.search(project, "liveliness")
    assert hits, "an exact identifier present in the corpus must be findable"
    assert any("liveliness" in h.text for h in hits)
    assert any("text" in h.found_by for h in hits)


def test_vector_half_finds_a_paraphrase(project):
    """No shared keyword with the source line, so only the vector side can match."""
    hits = store.search(project, "how long are old backups kept before deletion")
    assert hits
    assert any("ninety days" in h.text for h in hits)


def test_results_report_which_half_found_them(project):
    hits = store.search(project, "health check")
    assert hits
    assert all(h.found_by in {"text", "vector", "text+vector"} for h in hits)


def test_search_on_an_unindexed_root_is_empty_not_an_error(tmp_path):
    assert store.search(tmp_path, "anything") == []


def test_reingesting_replaces_rather_than_duplicates(project):
    before = store.status(project)["chunks"]
    store.ingest(project)
    assert store.status(project)["chunks"] == before, "re-ingest must not double the corpus"
