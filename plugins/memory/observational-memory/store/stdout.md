# Why the stdout guard exists

An MCP stdio server speaks JSON-RPC on stdout. One stray write desyncs the client's
parser, and the server sees nothing wrong, so the failure is silent from this side.
This is the most common way these servers break.

The SDK helps, but not completely. Everything below was measured on 2026-09-03
against `mcp` 2.1.1 on Python 3.13, using a raw JSON-RPC client with no SDK on the
client side, so it tests the wire rather than the library talking to itself.

## What the SDK does

`mcp.server.stdio.stdio_server()` claims fd 1 while it serves: it keeps a private
duplicate for the wire and points fd 1 itself at stderr, restoring it on exit. So a
stray write during serving misses the wire, including writes from C extensions and
child processes that never touch `sys.stdout`.

## The two holes

| Stray write happens | Default buffering | Unbuffered | With the guard |
|---|---|---|---|
| At import, before serving | lands on stdout | lands on stdout, as the **first line** | stderr |
| During serving, from a tool | lands on stdout | stderr | stderr |

**Buffering.** Python block-buffers stdout when it is a pipe. A `print()` during
serving sits in the buffer while fd 1 points at stderr, then flushes at process exit
after fd 1 has been restored, landing on the real stdout. The corruption surfaces at
an unpredictable moment against an unrelated message, which is worse than an
immediate error.

**Import time.** The SDK cannot help before it has claimed the descriptor. Anything
printing while modules load writes straight to the wire.

## What this repo does

`__main__.py` duplicates fd 1, points fd 1 at stderr, and sets `sys.stdout` to
stderr, all before importing anything else. Immediately before the transport starts,
`_release_stdout()` hands fd 1 back, so the SDK claims the real stdout rather than a
stderr-backed descriptor.

Order matters in both directions. Guarding without releasing sends JSON-RPC to
stderr, because the SDK's private duplicate would be a duplicate of stderr.

Verified: with a `print()` at import time in `server.py`, the line appeared on stderr,
stdout held nothing but JSON-RPC, and a full handshake plus tool call still passed.

## Rules that follow

- Log through `logging` to stderr. Never `print()`.
- Registrations set `PYTHONUNBUFFERED=1`, covering Python-level writes during serving.
- `tests/memory/test_stdout.py` asserts stdout purity across a whole session, so a
  future dependency that prints at import is caught here rather than in a harness.
