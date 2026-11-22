"""Embeddings, computed in this process.

No document text leaves the machine. That rules out every hosted embedding API and
is the reason this is not routed through the model gateway.

model2vec rather than sentence-transformers: static embeddings, no torch, roughly
30 MB of model, and it runs on CPU without competing with vLLM for the 16 GB of
unified memory this laptop has. The vectors are weaker than a full transformer's,
which is precisely why retrieval is hybrid: the full-text half carries the exact
identifiers and config keys that weak vectors miss.

Swapping this out means changing this module and reindexing. Nothing else imports
the model.
"""

from __future__ import annotations

import os
import sys
from functools import lru_cache

import numpy as np

#: MIT-licensed, and the smallest of the potion family that is still useful.
DEFAULT_MODEL = "minishlab/potion-base-8M"


def model_name() -> str:
    return os.environ.get("RAG_EMBED_MODEL", DEFAULT_MODEL)


@lru_cache(maxsize=2)
def _load(name: str):
    """Load once per process. The first call downloads the model if it is not cached.

    stdout is redirected to stderr for the duration. The download prints progress
    bars and hub warnings, and this runs inside a tool call, which is exactly when
    the process's stdout is the JSON-RPC wire. Observed: "Fetching 10 files" bars
    and an unauthenticated-requests warning on a cold cache.
    """
    from contextlib import redirect_stdout

    from model2vec import StaticModel

    with redirect_stdout(sys.stderr):
        return StaticModel.from_pretrained(name)


def dimensions() -> int:
    return int(_load(model_name()).dim)


def encode(texts: list[str]) -> np.ndarray:
    """Return L2-normalised float32 vectors, one row per text.

    Normalising here means cosine similarity and inner product agree, so the table's
    distance metric cannot silently disagree with what the scores mean.
    """
    if not texts:
        return np.zeros((0, dimensions()), dtype=np.float32)
    vectors = np.asarray(_load(model_name()).encode(texts), dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return vectors / norms
