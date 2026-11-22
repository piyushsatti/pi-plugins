"""Heading-aware chunking for markdown.

Architecture pages, ADRs and runbooks put meaning in their heading structure, so a
fixed-size window cuts across the thing that carries it. A chunk here is one heading
plus the prose under it, carrying the full heading path so a retrieved fragment
still says where it came from.

Only oversized sections are split further, and then on blank lines, so a table or a
code block is not cut down the middle unless it is genuinely enormous on its own.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")

#: Characters, not tokens. A deliberate approximation: the embedding model truncates
#: anyway, and counting tokens would mean loading a tokenizer just to split text.
MAX_CHARS = 1800


@dataclass(frozen=True)
class Chunk:
    source: str
    heading_path: str
    text: str
    ordinal: int

    @property
    def indexed_text(self) -> str:
        """What actually gets embedded and searched.

        The heading path is prepended so that a section titled "Verification" under
        "Gateway" is findable by either word, which a bare body would not be.
        """
        return f"{self.heading_path}\n\n{self.text}" if self.heading_path else self.text


def _split_oversized(text: str, limit: int = MAX_CHARS) -> list[str]:
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for block in text.split("\n\n"):
        if size and size + len(block) > limit:
            parts.append("\n\n".join(current))
            current, size = [], 0
        current.append(block)
        size += len(block) + 2
    if current:
        parts.append("\n\n".join(current))
    return parts


def split(text: str, source: str) -> list[Chunk]:
    """Split one document into chunks, one per heading section."""
    sections: list[tuple[str, list[str]]] = []
    stack: list[str] = []
    body: list[str] = []
    path = ""
    in_fence = False

    def flush() -> None:
        if any(line.strip() for line in body) or path:
            sections.append((path, list(body)))

    for line in text.splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
        # A '#' inside a fenced block is a comment or a shell prompt, not a heading.
        match = None if in_fence else HEADING.match(line)
        if match:
            flush()
            level, title = len(match.group(1)), match.group(2)
            stack = stack[: level - 1]
            while len(stack) < level - 1:
                stack.append("")
            stack.append(title)
            path = " > ".join(part for part in stack if part)
            body = []
            continue
        body.append(line)
    flush()

    chunks: list[Chunk] = []
    for heading_path, lines in sections:
        section = "\n".join(lines).strip()
        if not section and not heading_path:
            continue
        for piece in _split_oversized(section):
            if not piece.strip() and not heading_path:
                continue
            chunks.append(
                Chunk(source=source, heading_path=heading_path, text=piece, ordinal=len(chunks))
            )
    return chunks


def split_file(path: Path, relative_to: Path | None = None) -> list[Chunk]:
    source = str(path.relative_to(relative_to)) if relative_to else str(path)
    return split(path.read_text(encoding="utf-8", errors="replace"), source=source)
