"""Entry point.

The stdout guard runs before anything else, including the imports below, and is
lifted immediately before the transport takes over. Both halves are load-bearing;
the reasons are measured, not assumed, and are recorded in docs/stdout.md.

Short version: the SDK diverts fd 1 to stderr while it serves, so stray writes
during serving miss the wire. It cannot help before serving starts, because it has
not claimed the descriptor yet. The guard covers that window; releasing it hands
the real stdout back so the transport claims the right descriptor.

This matters more here than in the memory server: LanceDB and model2vec pull in
numpy, pyarrow and a tokenizer, and any of them printing a warning at import time
would land straight on the wire.
"""

import os
import sys

_SAVED_STDOUT_FD = os.dup(1)
os.dup2(2, 1)  # anything writing to "stdout" during import lands on stderr
sys.stdout = sys.stderr


def _release_stdout() -> None:
    """Give fd 1 back so the stdio transport claims the real stdout, not stderr."""
    os.dup2(_SAVED_STDOUT_FD, 1)
    os.close(_SAVED_STDOUT_FD)
    sys.stdout = sys.__stdout__


def main() -> int:
    import argparse
    import logging

    from rag.server import build_server

    parser = argparse.ArgumentParser(
        prog="rag", description="MCP server for per-project document retrieval."
    )
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8082)
    args = parser.parse_args()

    logging.basicConfig(
        stream=sys.stderr, level=logging.INFO, format="%(levelname)s %(name)s %(message)s"
    )

    server = build_server()
    _release_stdout()

    if args.transport == "stdio":
        server.run()
    else:
        server.run(transport="streamable-http", host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
