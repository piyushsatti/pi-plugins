"""Versioned markdown memory store with optimistic concurrency."""

from __future__ import annotations

import fcntl
import hashlib
import os
import re
import tempfile
import uuid
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Any, Literal

import yaml
from state_paths import memory_root as configured_memory_root
from pydantic import BaseModel, ConfigDict, Field, field_validator

SCHEMA_VERSION = 3
FENCE = "---"
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$")
FILENAME_PATTERN = re.compile(
    r"^(?P<created>\d{4}-\d{2}-\d{2})-(?P<type>[a-z]+)_(?P<slug>[a-z0-9-]+)\.md$"
)


def today() -> date:
    return datetime.now().astimezone().date()


def root() -> Path:
    return configured_memory_root()


class ScopeV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    depth: int = Field(ge=0)
    role: str


class Scope(ScopeV2):
    key: str = Field(min_length=1)


class Provenance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    adapter: str = Field(min_length=1)
    source_ref: str = Field(min_length=1)
    hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class FrontmatterV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    created: date
    type: str
    scope: ScopeV2
    genericity: Literal["generic", "specific"]
    last_updated: date
    schema_version: Literal[2]

    @field_validator("type")
    @classmethod
    def _type_is_a_bare_word(cls, value: str) -> str:
        if not value or not value.isalpha() or not value.islower():
            raise ValueError(f"type must be a single lowercase word, got {value!r}")
        return value


class Frontmatter(FrontmatterV2):
    schema_version: Literal[3] = 3
    id: str
    scope: Scope
    provenance: list[Provenance] = Field(min_length=1)
    status: Literal["active", "deprecated", "tombstone"] = "active"

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        if not ID_PATTERN.fullmatch(value):
            raise ValueError("id must be 3-128 safe identifier characters")
        return value

    def render(self) -> str:
        payload = self.model_dump(mode="json")
        return (
            FENCE + "\n" + yaml.safe_dump(payload, sort_keys=False).rstrip() + "\n" + FENCE + "\n"
        )


class Entry(BaseModel):
    name: str
    path: Path
    frontmatter: Frontmatter | FrontmatterV2
    body: str
    content_hash: str

    @property
    def stable_id(self) -> str | None:
        return self.frontmatter.id if isinstance(self.frontmatter, Frontmatter) else None

    @property
    def title(self) -> str:
        for line in self.body.splitlines():
            if line.startswith("# "):
                return line[2:].strip()
        return self.name

    @property
    def summary(self) -> str:
        for line in self.body.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                return stripped
        return ""


class MalformedEntry(Exception):
    pass


class ConflictError(Exception):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith(FENCE):
        raise MalformedEntry("file does not open with a frontmatter fence")
    parts = text.split(f"\n{FENCE}\n", 1)
    if len(parts) != 2:
        raise MalformedEntry("frontmatter fence is not closed")
    loaded = yaml.safe_load(parts[0][len(FENCE) :].strip("\n")) or {}
    if not isinstance(loaded, dict):
        raise MalformedEntry("frontmatter is not a mapping")
    return loaded, parts[1].lstrip("\n")


def load(path: Path) -> Entry:
    raw = path.read_bytes()
    data, body = split_frontmatter(raw.decode("utf-8"))
    version = data.get("schema_version")
    if version == 2:
        frontmatter: Frontmatter | FrontmatterV2 = FrontmatterV2(**data)
    elif version == 3:
        frontmatter = Frontmatter(**data)
    else:
        raise MalformedEntry(f"unsupported schema_version {version!r}; review required")
    return Entry(
        name=path.stem,
        path=path,
        frontmatter=frontmatter,
        body=body,
        content_hash=sha256_bytes(raw),
    )


def scan(directory: Path | None = None) -> tuple[list[Entry], list[tuple[str, str]]]:
    directory = directory or root()
    entries: list[Entry] = []
    problems: list[tuple[str, str]] = []
    if not directory.is_dir():
        return entries, [(str(directory), "store directory does not exist")]
    for path in sorted(directory.glob("*.md")):
        try:
            entries.append(load(path))
        except Exception as exc:  # noqa: BLE001
            problems.append((path.name, str(exc)))
    return entries, problems


def filename_for(created: date, type: str, slug: str) -> str:
    if not SLUG_PATTERN.fullmatch(slug):
        raise ValueError(f"slug must be lowercase kebab-case, got {slug!r}")
    return f"{created.isoformat()}-{type}_{slug}.md"


def _revision_key(stable_id: str) -> str:
    """Map the exact stable ID to a collision-resistant private directory name."""
    return sha256_bytes(stable_id.encode("utf-8"))


@contextmanager
def write_lock(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".memory.lock").open("a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        yield


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _render(frontmatter: Frontmatter, body: str) -> bytes:
    return (frontmatter.render() + "\n" + body.strip() + "\n").encode("utf-8")


def find_by_id(directory: Path, stable_id: str) -> Entry | None:
    entries, problems = scan(directory)
    if problems:
        raise MalformedEntry(f"store has unreadable entries: {problems}")
    matches = [entry for entry in entries if entry.stable_id == stable_id]
    if len(matches) > 1:
        raise ConflictError(f"duplicate stable id {stable_id!r}")
    return matches[0] if matches else None


def revisions(stable_id: str, directory: Path | None = None) -> list[str]:
    revision_dir = (directory or root()) / ".revisions" / _revision_key(stable_id)
    return sorted(path.stem for path in revision_dir.glob("*.md")) if revision_dir.is_dir() else []


def load_revision(stable_id: str, revision_hash: str, directory: Path | None = None) -> Entry:
    if not re.fullmatch(r"[0-9a-f]{64}", revision_hash):
        raise ValueError("revision_hash must be a sha256 hex digest")
    path = (directory or root()) / ".revisions" / _revision_key(stable_id) / f"{revision_hash}.md"
    if not path.is_file():
        raise FileNotFoundError(f"no revision {revision_hash!r} for {stable_id!r}")
    entry = load(path)
    if entry.content_hash != revision_hash:
        raise ConflictError(f"revision content hash mismatch for {stable_id!r}")
    if entry.stable_id is not None and entry.stable_id != stable_id:
        raise ConflictError(f"revision identity mismatch for {stable_id!r}")
    return entry


def migrate_v2(
    path: Path,
    *,
    slug: str,
    type: str,
    body: str,
    genericity: Literal["generic", "specific"],
    scope: Scope,
    provenance: list[Provenance],
    stable_id: str,
    status: Literal["active", "deprecated", "tombstone"],
    created: date,
    last_updated: date,
    expected_hash: str,
) -> Entry:
    """Explicitly migrate one hash-pinned schema-2 file, retaining its exact bytes."""
    directory = path.parent
    with write_lock(directory):
        current = load(path)
        if current.frontmatter.schema_version != 2:
            raise ConflictError("legacy migration source is no longer schema 2")
        if current.content_hash != expected_hash:
            raise ConflictError(
                f"legacy hash conflict: expected {expected_hash}, found {current.content_hash}"
            )
        # Validate the reviewed v3 identity fields, but keep the exact hash-pinned
        # legacy path. Some valid legacy records have a historical filename type
        # prefix that differs from their reviewed semantic type.
        filename_for(created, type, slug)
        if current.frontmatter.created != created:
            raise ConflictError("legacy migration cannot change created")
        if current.body.strip() != body.strip():
            raise ConflictError("legacy migration body differs from reviewed source")
        if find_by_id(directory, stable_id) is not None:
            raise ConflictError(f"stable id already exists: {stable_id!r}")
        revision_dir = directory / ".revisions" / _revision_key(stable_id)
        atomic_write(revision_dir / f"{current.content_hash}.md", path.read_bytes())
        frontmatter = Frontmatter(
            created=created,
            type=type,
            scope=scope,
            genericity=genericity,
            last_updated=last_updated,
            id=stable_id,
            provenance=provenance,
            status=status,
        )
        atomic_write(path, _render(frontmatter, body))
        return load(path)


def save(
    slug: str,
    type: str,
    body: str,
    genericity: Literal["generic", "specific"],
    scope: Scope,
    provenance: list[Provenance],
    *,
    stable_id: str | None = None,
    status: Literal["active", "deprecated", "tombstone"] = "active",
    created: date | None = None,
    last_updated: date | None = None,
    expected_hash: str | None = None,
    directory: Path | None = None,
) -> Entry:
    """Create or compare-and-swap replace a schema-3 entry."""
    directory = directory or root()
    stable_id = stable_id or f"mem-{uuid.uuid4()}"
    written_on = today()
    with write_lock(directory):
        existing = find_by_id(directory, stable_id)
        if existing:
            if expected_hash is None:
                raise ConflictError("expected_hash is required when replacing an existing record")
            current = load(existing.path)
            if current.content_hash != expected_hash:
                raise ConflictError(
                    f"hash conflict for {stable_id}: expected {expected_hash}, found {current.content_hash}"
                )
            match = FILENAME_PATTERN.fullmatch(existing.path.name)
            if not match or match.group("type") != type or match.group("slug") != slug:
                raise ConflictError("replacement cannot change the record filename identity")
            record_created = current.frontmatter.created
            if created and created != record_created:
                raise ConflictError("replacement cannot change created")
            path = existing.path
            revision_dir = directory / ".revisions" / _revision_key(stable_id)
            revision_path = revision_dir / f"{current.content_hash}.md"
            if not revision_path.exists():
                atomic_write(revision_path, current.path.read_bytes())
        else:
            if expected_hash is not None:
                raise ConflictError("expected_hash supplied for a record that does not exist")
            record_created = created or written_on
            path = directory / filename_for(record_created, type, slug)
            if path.exists():
                raise ConflictError(f"path already exists: {path.name}")
        frontmatter = Frontmatter(
            created=record_created,
            type=type,
            scope=scope,
            genericity=genericity,
            last_updated=last_updated or written_on,
            id=stable_id,
            provenance=provenance,
            status=status,
        )
        atomic_write(path, _render(frontmatter, body))
        return load(path)
