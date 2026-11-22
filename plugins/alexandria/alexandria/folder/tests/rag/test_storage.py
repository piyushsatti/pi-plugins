"""Canonical index location: rag's own state folder, never the project."""

from __future__ import annotations

import pytest

from rag import storage
from rag.tools import status


@pytest.fixture
def state(tmp_path, monkeypatch):
    home = tmp_path / "state"
    monkeypatch.setenv("RAG_STATE_DIR", str(home))
    return home


def test_index_lives_in_state_folder_keyed_by_project(tmp_path, state):
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()

    index = storage.resolve_index(alpha)
    assert index.parent.parent == state.resolve() / "projects"
    assert index.name == "index"
    assert index.parent.name.startswith("alpha-")
    assert storage.resolve_index(alpha) == index
    assert storage.resolve_index(beta) != index
    assert not (alpha / ".pi").exists()
    assert not (alpha / ".local-state").exists()


def test_default_state_folder_is_local_state(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("RAG_STATE_DIR", raising=False)
    project = tmp_path / "project"
    project.mkdir()

    index = storage.resolve_index(project)
    assert index.is_relative_to((home / ".local/state/rag/projects").resolve())


def test_project_root_and_override_must_be_absolute(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="project_root must be an absolute path"):
        storage.resolve_index("relative/project")
    monkeypatch.setenv("RAG_STATE_DIR", "relative/state")
    with pytest.raises(ValueError, match="RAG_STATE_DIR must be an absolute path"):
        storage.resolve_index(tmp_path)


def test_storage_refuses_symlinked_state(tmp_path, state):
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    projects = state / "projects"
    projects.parent.mkdir(parents=True)
    projects.symlink_to(outside, target_is_directory=True)

    with pytest.raises(storage.StoragePathError, match="symlinked rag state"):
        storage.resolve_index(project)

    assert list(outside.iterdir()) == []


def test_status_reports_index_location_without_creating_it(tmp_path, state):
    project = tmp_path / "project"
    project.mkdir()

    result = status(str(project))
    assert result["indexed"] is False
    assert result["index"] == str(storage.resolve_index(project))
    assert not storage.resolve_index(project).exists()
