"""The stable four-tool API."""

import pytest

from memory.tools import REGISTRY, index, read, search, write


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_ROOT", str(tmp_path))
    return tmp_path


def payload(**overrides):
    data = {
        "slug": "thing",
        "type": "reference",
        "body": "# Thing\n\nNeedle detail.",
        "scope": {"key": "project:alpha", "depth": 2, "role": "repo"},
        "provenance": [{"adapter": "fixture", "source_ref": "case", "hash": "0" * 64}],
        "id": "mem-tool-001",
    }
    data.update(overrides)
    return data


def test_write_requires_explicit_scope(root):
    data = payload()
    data.pop("scope")
    with pytest.raises(TypeError):
        write(**data)
    assert list(root.glob("*.md")) == []


def test_index_read_search_and_revision(root):
    created = write(**payload())
    assert created["written"]
    assert index(scope_key="project:alpha")["count"] == 1
    assert search("needle", scope_key="project:alpha")["count"] == 1
    assert read("mem-tool-001")["hash"] == created["hash"]

    replaced = write(**payload(body="# Thing\n\nChanged.", expected_hash=created["hash"]))
    assert replaced["written"]
    old = read("mem-tool-001", revision_hash=created["hash"])
    assert "Needle" in old["body"]


def test_stale_hash_is_a_conflict(root):
    created = write(**payload())
    result = write(**payload(body="# Lost", expected_hash="f" * 64))
    assert not result["written"]
    assert "conflict" in result["error"].lower()
    assert read("mem-tool-001")["hash"] == created["hash"]


def test_registry_stays_four_tools_with_descriptions():
    assert [spec.name for spec in REGISTRY] == ["index", "read", "search", "write"]
    assert all(len(spec.description) > 40 for spec in REGISTRY)
