"""Chunking follows headings, because that is where the meaning is."""

from rag import chunk

DOC = """# Gateway

The gateway fronts every model.

## Health check

Distinguishes dead from idle:

```bash
# this hash is a shell comment, not a heading
curl -sf http://localhost:4000/health/liveliness
```

## Autocomplete

### Backend

Served by vLLM on Metal.
"""


def test_each_heading_becomes_its_own_chunk():
    chunks = chunk.split(DOC, source="gateway.md")
    paths = [c.heading_path for c in chunks]
    assert paths == [
        "Gateway",
        "Gateway > Health check",
        "Gateway > Autocomplete",
        "Gateway > Autocomplete > Backend",
    ]


def test_a_hash_inside_a_fenced_block_is_not_a_heading():
    chunks = chunk.split(DOC, source="gateway.md")
    health = next(c for c in chunks if c.heading_path.endswith("Health check"))
    assert "shell comment" in health.text
    assert not any("shell comment" in c.heading_path for c in chunks)


def test_the_heading_path_is_searchable_alongside_the_body():
    chunks = chunk.split(DOC, source="gateway.md")
    backend = next(c for c in chunks if c.heading_path.endswith("Backend"))
    # A section titled "Backend" under "Autocomplete" must be findable by either word.
    assert "Autocomplete" in backend.indexed_text
    assert "vLLM" in backend.indexed_text


def test_an_oversized_section_is_split_on_blank_lines():
    body = "\n\n".join(f"Paragraph {i} with some filler text." * 4 for i in range(120))
    chunks = chunk.split(f"# Big\n\n{body}\n", source="big.md")
    assert len(chunks) > 1
    assert all(len(c.text) <= chunk.MAX_CHARS * 1.5 for c in chunks)
    assert all(c.heading_path == "Big" for c in chunks)


def test_a_document_with_no_headings_still_produces_a_chunk():
    chunks = chunk.split("Just prose, no headings at all.\n", source="flat.md")
    assert len(chunks) == 1
    assert chunks[0].heading_path == ""
    assert "Just prose" in chunks[0].text
