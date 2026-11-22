"""stdout must carry JSON-RPC and nothing else, and a real client must be able to use it.

This is the single most common way an MCP server fails: one stray write and the
client's parser desyncs. The failure is silent from the server's side, so it needs
a test rather than care.

The session is driven over a live pipe rather than piped in one shot, because
closing stdin immediately races the transport's writer and later responses never
arrive. A real harness holds the pipe open; so does this.
"""

import json
import os
import subprocess
import sys
import tempfile

PROBE_ROOT = tempfile.mkdtemp(prefix="rag-probe-")

INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "0"},
    },
}


def spawn():
    env = dict(os.environ, RAG_PROBE="1", PYTHONUNBUFFERED="1")
    return subprocess.Popen(
        [sys.executable, "-m", "rag"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=env,
    )


def run_session() -> tuple[list[dict], list[str]]:
    """Drive a full session. Returns (json messages, any non-JSON stdout lines)."""
    proc = spawn()
    messages: list[dict] = []
    impure: list[str] = []

    def send(obj: dict) -> None:
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def recv() -> dict | None:
        while True:
            line = proc.stdout.readline()
            if not line:
                return None
            if not line.startswith("{"):
                impure.append(line.rstrip())
                continue
            return json.loads(line)

    try:
        send(INIT)
        messages.append(recv())
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        messages.append(recv())
        send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "status", "arguments": {"project_root": PROBE_ROOT}},
            }
        )
        messages.append(recv())
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:  # pragma: no cover
            proc.kill()

    return [m for m in messages if m], impure


def test_stdout_carries_only_json_rpc(tmp_path):
    _, impure = run_session()
    assert impure == [], f"non-JSON reached stdout and would desync a client: {impure}"


def test_a_real_client_can_handshake_list_and_call(tmp_path):
    """Connecting is not using. This asserts the whole round trip over the wire."""
    messages, _ = run_session()
    init, listed, called = messages

    assert init["result"]["serverInfo"]["name"] == "rag"
    assert {t["name"] for t in listed["result"]["tools"]} == {"ingest", "search", "status"}
    assert all(t.get("description") for t in listed["result"]["tools"])

    payload = json.loads(called["result"]["content"][0]["text"])
    assert payload["indexed"] is False, "an unindexed root must say so, not error"
    assert "hint" in payload


def test_server_meets_older_protocol_revisions(tmp_path):
    """Many harnesses means old clients. The server must not insist on the newest revision."""
    for offered in ("2024-11-05", "2025-06-18"):
        proc = spawn()
        try:
            request = dict(INIT)
            request["params"] = dict(INIT["params"], protocolVersion=offered)
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            reply = json.loads(proc.stdout.readline())
        finally:
            proc.stdin.close()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:  # pragma: no cover
                proc.kill()

        assert reply["result"]["protocolVersion"] == offered, (
            f"offered {offered}, server answered {reply['result']['protocolVersion']}"
        )
