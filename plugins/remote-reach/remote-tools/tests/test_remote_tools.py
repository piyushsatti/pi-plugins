"""Tests for bin/remote-tools. Standard library only. HOME is a temp dir, the remote commands are fake programs on
a temp PATH, and ssh is a fake script: it either records its argv or hands the request to the real gate.

Run from the plugin root:  python3 -B -m unittest discover -s tests -v
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
PLUGIN = Path(__file__).resolve().parent.parent
SCRIPT = PLUGIN / "bin" / "remote-tools"
OPS = PLUGIN / "ops.json"


def load_module():
    loader = importlib.machinery.SourceFileLoader("remote_tools_under_test", str(SCRIPT))
    spec = importlib.util.spec_from_loader("remote_tools_under_test", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


rt = load_module()

# One fake for every remote program: it records [name, *args] and says hello. `slowcmd` sleeps, `envdump` prints
# the names of the environment variables it was given.
FAKE_PROGRAM = """#!{python}
import json, os, sys, time
name = os.path.basename(sys.argv[0])
with open({log!r}, "a") as f:
    f.write(json.dumps([name, *sys.argv[1:]]) + "\\n")
if name == "slowcmd":
    time.sleep(float(sys.argv[1]) if len(sys.argv) > 1 else 30)
if name == "envdump":
    print(json.dumps(sorted(os.environ)))
print("out:" + name)
print("err:" + name, file=sys.stderr)
"""
PROGRAMS = ["docker", "systemctl", "journalctl", "uptime", "df", "free", "ps", "slowcmd", "envdump"]

# Fake ssh, recording mode: logs its argv, and answers by the container named in the request.
FAKE_SSH = """#!{python}
import json, os, sys, time
with open(os.environ["FAKE_SSH_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
request = sys.argv[-1]
if "container=sleepy" in request:
    time.sleep(60)
elif "container=flood" in request:
    sys.stdout.write("o" * 1000000)
    sys.stdout.flush()
    sys.stderr.write("e" * 300000)
elif "container=refuse" in request:
    print("remote-tools: refused (bad_request): no", file=sys.stderr)
    sys.exit(126)
else:
    print("hello from fake ssh")
"""

# Fake ssh, gate mode: the far side of a real connection. The request goes to the real gate with the shipped
# operations and the fake programs on PATH, the way sshd would hand it $SSH_ORIGINAL_COMMAND.
FAKE_SSH_TO_GATE = """#!{python}
import importlib.machinery, importlib.util, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("gate_side", {script!r})
spec = importlib.util.spec_from_loader("gate_side", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
mod._log = lambda record: None
env = {{"PATH": {fakebin!r}}}
sys.exit(mod.gate(sys.argv[-1], Path({ops!r}), sys.stdout.buffer, sys.stderr.buffer, env))
"""

# A sample call for every shipped operation, and the argvs the gate must run for it.
SAMPLES = {
    "docker-ps": ({}, [["docker", "ps", "--all", "--format",
                       '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}}}']]),
    "docker-inspect": ({"container": "web"}, [["docker", "inspect", "--format", "{{json .State}}", "--", "web"]]),
    "docker-logs": ({"container": "web", "lines": 50, "since": "2h"},
                    [["docker", "logs", "--tail", "50", "--since", "2h", "--", "web"]]),
    "service-status": ({"unit": "nginx.service"}, [["systemctl", "status", "--no-pager", "--lines=0", "--", "nginx.service"]]),
    "service-logs": ({"unit": "nginx", "lines": 10}, [["journalctl", "--no-pager", "--lines", "10", "--unit", "nginx"]]),
    "host-health": ({}, [["uptime"], ["df", "-h"], ["free", "-h"], ["ps", "-eo", "pid,user,%cpu,%mem,etime,comm", "--sort=-%cpu"]]),
}

# Requests the gate must refuse, without running anything.
BAD_REQUESTS = [
    "", "   ", "bash -i", "sh", "scp -t /tmp", "internal-sftp", "docker", "docker logs web",
    "docker-logs", "docker-logs web", "docker-logs container=", "docker-logs container=-x",
    "docker-logs container=--help", "docker-logs container=web;id", "docker-logs container=$(id)",
    "docker-logs container=`id`", "docker-logs container=web\nid", "docker-logs container=web\r",
    "docker-logs container='web'", 'docker-logs container="web"', "docker-logs container=web|id",
    "docker-logs container=web&id", "docker-logs container=we\tb", "docker-logs container=web lines=0",
    "docker-logs container=web lines=5001", "docker-logs container=web lines=abc", "docker-logs container=web lines=-1",
    "docker-logs container=web lines=1e3", "docker-logs container=web since=2x", "docker-logs container=web since=",
    "docker-logs container=web container=db", "docker-logs container=web extra=1", "docker-logs container=web lines",
    "docker-logs container=web =1", "docker-ps x=1", "docker-ps --all", "host-health ; id",
    "docker-logs container=" + "a" * 2000, "service-status unit=../../etc/shadow", "service-status unit=a b",
]


def write_ops(path: Path, data, mode=0o644) -> Path:
    path.write_text(json.dumps(data))
    path.chmod(mode)
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "home"
        self.home.mkdir()
        self.fakebin = root / "fakebin"
        self.fakebin.mkdir()
        self.run_log = root / "run.log"
        fake = self.fakebin / "_fake"
        fake.write_text(FAKE_PROGRAM.format(python=sys.executable, log=str(self.run_log)))
        fake.chmod(0o755)
        for name in PROGRAMS:
            (self.fakebin / name).symlink_to(fake)
        self.ops = root / "ops.json"
        shutil.copy(OPS, self.ops)
        self.ops.chmod(0o644)
        self.ssh_log = root / "ssh.log"
        self.ssh = root / "fake-ssh"
        self.ssh.write_text(FAKE_SSH.format(python=sys.executable))
        self.ssh.chmod(0o755)
        self.ssh_gate = root / "fake-ssh-to-gate"
        self.ssh_gate.write_text(FAKE_SSH_TO_GATE.format(python=sys.executable, script=str(SCRIPT),
                                                         fakebin=str(self.fakebin), ops=str(OPS)))
        self.ssh_gate.chmod(0o755)
        self.env = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "REMOTE_TOOLS_SSH": str(self.ssh), "FAKE_SSH_LOG": str(self.ssh_log),
        })
        self.env.start()
        self.state = self.home / ".local" / "state" / "remote-tools"
        self.logged = []
        self.log_patch = mock.patch.object(rt, "_log", self.logged.append)
        self.log_patch.start()

    def tearDown(self):
        self.log_patch.stop()
        self.env.stop()
        self.tmp.cleanup()

    # ---- gate side ----

    def gate(self, line, ops=None, env=None):
        out, err = io.BytesIO(), io.BytesIO()
        code = rt.gate(line, ops or self.ops, out, err, env or {"PATH": str(self.fakebin)})
        return code, out.getvalue().decode(), err.getvalue().decode()

    def ran(self):
        return [json.loads(l) for l in self.run_log.read_text().splitlines()] if self.run_log.exists() else []

    # ---- MCP side ----

    def install_local_ops(self):
        dest = self.home / ".local" / "share" / "remote-tools" / "ops.json"
        dest.parent.mkdir(parents=True)
        shutil.copy(OPS, dest)
        dest.chmod(0o644)

    def write_hosts(self, data, mode=0o600):
        self.state.mkdir(parents=True, exist_ok=True)
        p = self.state / "hosts.json"
        p.write_text(json.dumps(data))
        p.chmod(mode)
        return p

    def standard_hosts(self, **defaults):
        data = {"hosts": {"box": {"destination": "box-alias", "description": "test box"}}}
        if defaults:
            data["defaults"] = defaults
        return self.write_hosts(data)

    def ssh_calls(self):
        return [json.loads(l) for l in self.ssh_log.read_text().splitlines()] if self.ssh_log.exists() else []

    def audit_lines(self):
        p = self.state / "audit.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def call(self, name, args, srv=None):
        srv = srv or rt.Server()
        reply = srv.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
        res = reply["result"]
        return res["content"][0]["text"], res["isError"]


class Operations(Base):
    def test_shipped_ops_load(self):
        self.assertEqual(sorted(rt.load_ops(OPS)), sorted(SAMPLES))

    def test_every_op_has_a_sample(self):
        # A new operation in ops.json must get an exact-argv case above.
        self.assertEqual(set(json.loads(OPS.read_text())["ops"]), set(SAMPLES))

    def test_writable_ops_file_refused(self):
        self.ops.chmod(0o666)
        with self.assertRaises(rt.Refused) as e:
            rt.load_ops(self.ops)
        self.assertEqual(e.exception.code, "bad_config")

    def test_bad_definitions_refuse_the_whole_file(self):
        good = {"description": "d", "params": {"n": {"type": "text", "pattern": "^[a-z]+$"}}, "run": [["echo", {"param": "n"}]]}
        bad = [
            {**good, "extra": 1},
            {**good, "params": {"n": {"type": "text", "pattern": "[a-z]+"}}},
            {**good, "params": {"n": {"type": "text", "pattern": "^[a-z+$"}}},
            {**good, "params": {"n": {"type": "float"}}},
            {**good, "params": {"n": {"type": "int", "min": 5, "max": 1}}},
            {**good, "params": {"n": {"type": "int", "min": 1, "max": 5, "default": 9}}},
            {**good, "params": {"n": {"type": "text", "pattern": "^a$"}, "unused": {"type": "text", "pattern": "^a$"}}},
            {**good, "run": [["echo", {"param": "other"}]]},
            {**good, "run": [[{"param": "n"}]]},
            {**good, "run": [["echo; rm", {"param": "n"}]]},
            {**good, "run": [["echo", {"param": "n", "flag": "--x;y"}]]},
            {**good, "run": []},
            {**good, "timeout": 301},
        ]
        for i, op in enumerate(bad):
            data = {"ops": {"fine": good, "broken": op}}
            with self.subTest(i=i), self.assertRaises(rt.Refused) as e:
                rt.load_ops(write_ops(self.ops, data))
            self.assertEqual(e.exception.code, "bad_ops")
        with self.assertRaises(rt.Refused):
            rt.load_ops(write_ops(self.ops, {"ops": {"Bad Name": good}}))


class Gate(Base):
    def test_docker_ps_formats_only_safe_fields_as_json(self):
        code, _, err = self.gate("docker-ps")
        self.assertEqual(code, 0, err)
        template = self.ran()[0][-1]
        fields = re.findall(r"{{json \.([A-Za-z]+)}}", template)
        self.assertEqual(fields, ["ID", "Names", "Image", "State", "Status"])
        values = {"ID": "abc123", "Names": 'web"quoted', "Image": "redis", "State": "running", "Status": "Up 1 hour",
                  "Command": "redis-server --requirepass s3cret", "Labels": "password=s3cret"}
        rendered = re.sub(r"{{json \.([A-Za-z]+)}}", lambda m: json.dumps(values[m[1]]), template)
        self.assertEqual(json.loads(rendered), {k: values[k] for k in fields})
        self.assertNotIn("s3cret", rendered)

    def test_exact_argv_for_every_op(self):
        for name, (values, argvs) in SAMPLES.items():
            with self.subTest(op=name):
                self.run_log.unlink(missing_ok=True)
                code, out, err = self.gate(rt.format_request(name, values))
                self.assertEqual(code, 0, err)
                self.assertEqual(self.ran(), argvs)

    def test_defaults_and_optional_params(self):
        code, _, _ = self.gate("docker-logs container=web")
        self.assertEqual(code, 0)
        self.assertEqual(self.ran(), [["docker", "logs", "--tail", "200", "--", "web"]])

    def test_order_of_params_does_not_matter(self):
        self.gate("docker-logs since=30m container=web lines=7")
        self.assertEqual(self.ran(), [["docker", "logs", "--tail", "7", "--since", "30m", "--", "web"]])

    def test_bad_requests_refused_and_nothing_runs(self):
        for line in BAD_REQUESTS:
            with self.subTest(line=line):
                code, out, err = self.gate(line)
                self.assertEqual(code, rt.EXIT_REFUSED)
                self.assertIn("remote-tools: refused (", err)
                self.assertEqual(out, "")
        self.assertEqual(self.ran(), [])

    def test_no_command_lists_the_operations(self):
        code, _, err = self.gate(None)
        self.assertEqual(code, rt.EXIT_REFUSED)
        self.assertIn("no_command", err)
        self.assertIn("docker-logs", err)

    def test_bad_ops_file_runs_nothing(self):
        write_ops(self.ops, {"ops": {"x": {"description": "d"}}})
        code, _, err = self.gate("docker-ps")
        self.assertEqual(code, rt.EXIT_REFUSED)
        self.assertIn("bad_ops", err)
        self.assertEqual(self.ran(), [])

    def test_every_call_is_logged(self):
        self.gate("docker-ps")
        self.gate("bash -i")
        self.assertEqual([r["event"] for r in self.logged], ["start", "end", "refused"])
        self.assertEqual(self.logged[0]["op"], "docker-ps")
        self.assertEqual(self.logged[1]["exit_code"], 0)
        self.assertEqual(self.logged[2]["code"], "unknown_op")
        self.assertEqual(self.logged[2]["request"], "bash -i")

    def test_log_goes_to_syslog(self):
        self.log_patch.stop()
        try:
            with mock.patch.object(rt, "syslog") as sl:
                self.gate("docker-ps")
        finally:
            self.log_patch.start()
        sl.openlog.assert_called_with("remote-tools", 0, sl.LOG_USER)
        self.assertEqual(json.loads(sl.syslog.call_args_list[0].args[1])["event"], "start")

    def test_only_the_given_environment_reaches_the_command(self):
        write_ops(self.ops, {"ops": {"env": {"description": "d", "params": {}, "run": [["envdump"]]}}})
        with mock.patch.dict(os.environ, {"SECRET_FROM_SSHD": "x", "LD_PRELOAD": "/evil.so"}):
            code, out, _ = self.gate("env", env={"PATH": str(self.fakebin), "LANG": "C.UTF-8"})
        self.assertEqual(code, 0)
        given = [k for k in json.loads(out.splitlines()[0]) if k != "__CF_USER_TEXT_ENCODING"]  # macOS adds it to every process
        self.assertEqual(given, ["LANG", "PATH"])

    def test_safe_env_replaces_path(self):
        self.assertNotIn("~", rt.SAFE_ENV["PATH"])
        self.assertEqual(set(rt.SAFE_ENV), {"PATH", "LANG", "SYSTEMD_PAGER", "PAGER"})

    def test_timeout_kills_and_exits_124(self):
        write_ops(self.ops, {"ops": {"slow": {"description": "d", "params": {}, "run": [["slowcmd"], ["uptime"]], "timeout": 1}}})
        start = time.monotonic()
        code, _, err = self.gate("slow")
        self.assertLess(time.monotonic() - start, 10)
        self.assertEqual(code, rt.EXIT_TIMEOUT)
        self.assertIn("timed out after 1s", err)
        self.assertEqual([r[0] for r in self.ran()], ["slowcmd"])  # the rest of the op does not run

    def test_timeout_is_shared_by_all_commands(self):
        write_ops(self.ops, {"ops": {"slow": {"description": "d", "params": {},
                                            "run": [["slowcmd", "1.2"], ["slowcmd", "1.2"], ["uptime"]], "timeout": 2}}})
        for output_delay, ran in [(0, [["slowcmd", "1.2"], ["slowcmd", "1.2"]]), (1, [["slowcmd", "1.2"]])]:
            with self.subTest(output_delay=output_delay):
                self.run_log.unlink(missing_ok=True)

                class Output(io.BytesIO):
                    def write(self, data):
                        result = super().write(data)
                        if data == b"out:slowcmd\n":
                            time.sleep(output_delay)
                        return result

                out, err = Output(), io.BytesIO()
                start = time.monotonic()
                code = rt.gate("slow", self.ops, out, err, {"PATH": str(self.fakebin)})
                elapsed = time.monotonic() - start
                self.assertEqual(code, rt.EXIT_TIMEOUT)
                self.assertIn(b"timed out after 2s", err.getvalue())
                self.assertLess(elapsed, 2 + rt.KILL_GRACE)
                self.assertEqual(self.ran(), ran)

    def test_several_commands_get_headers(self):
        code, out, _ = self.gate("host-health")
        self.assertEqual(code, 0)
        self.assertIn("$ uptime\nout:uptime\n$ df -h\nout:df\n", out)

    def test_missing_program_is_reported(self):
        empty = Path(self.tmp.name) / "empty"
        empty.mkdir()
        code, _, err = self.gate("docker-ps", env={"PATH": str(empty)})
        self.assertEqual(code, rt.EXIT_REFUSED)
        self.assertIn("remote-tools: docker:", err)

    def test_no_shell_anywhere(self):
        source = SCRIPT.read_text()
        self.assertNotIn("shell=True", source)
        self.assertNotIn("os.system", source)
        self.assertEqual(source.count("subprocess.Popen("), 1)
        self.assertIn("shell=False", source)


class McpTools(Base):
    def setUp(self):
        super().setUp()
        self.install_local_ops()

    def tools(self):
        return {t["name"]: t for t in rt.Server().handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]}

    def test_tools_follow_ops(self):
        tools = self.tools()
        self.assertEqual(sorted(tools), sorted(["list_hosts"] + [n.replace("-", "_") for n in SAMPLES]))
        logs = tools["docker_logs"]["inputSchema"]
        self.assertEqual(logs["required"], ["host", "container"])
        self.assertEqual(logs["properties"]["lines"], {"type": "integer", "minimum": 1, "maximum": 5000, "default": 200,
                                                       "description": "How many lines from the end."})
        self.assertFalse(logs["additionalProperties"])
        for t in tools.values():
            self.assertIs(t["annotations"]["readOnlyHint"], True, t["name"])
            self.assertIs(t["annotations"]["destructiveHint"], False, t["name"])

    def test_exact_ssh_argv(self):
        self.standard_hosts()
        text, err = self.call("docker_logs", {"host": "box", "container": "web", "lines": 50, "since": "2h"})
        self.assertFalse(err, text)
        self.assertEqual(self.ssh_calls(), [[*rt.SSH_OPTIONS, "--", "box-alias", "docker-logs container=web lines=50 since=2h"]])
        self.assertIn("hello from fake ssh", text)
        self.assertIn("--- BEGIN UNTRUSTED REMOTE STDOUT", text)

    def test_bad_values_refused_before_ssh(self):
        self.standard_hosts()
        for args in [{"container": "-x"}, {"container": "web;id"}, {"container": "web", "lines": 0},
                     {"container": "web", "lines": True}, {"container": "web", "lines": "5"},
                     {"container": "web", "since": "2x"}, {"container": "web", "bogus": 1}, {}]:
            with self.subTest(args=args):
                text, err = self.call("docker_logs", {"host": "box", **args})
                self.assertTrue(err)
                self.assertIn("refused (bad_input)", text)
        self.assertEqual(self.ssh_calls(), [])

    def test_unknown_host_refused(self):
        self.standard_hosts()
        for host in ["ghost", "box-alias", "box; id", 5]:
            text, err = self.call("docker_ps", {"host": host})
            self.assertTrue(err)
        self.assertEqual(self.ssh_calls(), [])

    def test_gate_refusal_is_explained(self):
        self.standard_hosts()
        text, err = self.call("docker_logs", {"host": "box", "container": "refuse"})
        self.assertTrue(err)
        self.assertIn("exit code 126 (the host's gate refused the request", text)

    def test_timeout_kills_ssh(self):
        self.standard_hosts()
        with mock.patch.object(rt, "SSH_MARGIN", -29):  # the op's 30 s timeout becomes 1 s
            start = time.monotonic()
            text, err = self.call("docker_logs", {"host": "box", "container": "sleepy"})
        self.assertLess(time.monotonic() - start, 10)
        self.assertTrue(err)
        self.assertIn("timed out after 1s", text)

    def test_output_cap(self):
        self.standard_hosts(max_output_bytes=4096)
        text, _ = self.call("docker_logs", {"host": "box", "container": "flood"})
        self.assertIn("stdout: 1000000 bytes (first 4096 of 1000000 bytes; the rest was dropped)", text)
        self.assertLess(len(text), 4096 * 2 + 2000)

    def test_audit_records_every_call(self):
        self.standard_hosts()
        self.call("docker_ps", {"host": "box"})
        self.call("docker_ps", {"host": "ghost"})
        lines = self.audit_lines()
        self.assertEqual([l["event"] for l in lines], ["start", "end", "refused"])
        self.assertEqual(lines[0]["request"], "docker-ps")
        self.assertEqual(lines[0]["destination"], "box-alias")
        self.assertEqual(lines[0]["call_id"], lines[1]["call_id"])
        self.assertEqual(lines[2]["code"], "unknown_host")
        self.assertEqual(stat.S_IMODE(os.stat(self.state / "audit.jsonl").st_mode), 0o600)

    def test_unwritable_audit_refuses(self):
        self.standard_hosts()
        (self.state / "audit.jsonl").mkdir()
        text, err = self.call("docker_ps", {"host": "box"})
        self.assertTrue(err)
        self.assertEqual(self.ssh_calls(), [])

    def test_round_trip_through_the_real_gate(self):
        # The MCP side's request format and the gate's parser must agree for every operation.
        self.standard_hosts()
        with mock.patch.dict(os.environ, {"REMOTE_TOOLS_SSH": str(self.ssh_gate)}):
            for name, (values, argvs) in SAMPLES.items():
                with self.subTest(op=name):
                    self.run_log.unlink(missing_ok=True)
                    text, err = self.call(name.replace("-", "_"), {"host": "box", **values})
                    self.assertFalse(err, text)
                    self.assertEqual(self.ran(), argvs)


class McpWithoutOps(Base):
    def test_missing_local_ops_leaves_only_list_hosts(self):
        self.standard_hosts()
        srv = rt.Server()
        tools = srv.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
        self.assertEqual([t["name"] for t in tools], ["list_hosts"])
        text, err = self.call("list_hosts", {}, srv)
        self.assertFalse(err)
        self.assertIn("operations_error", json.loads(text))


class Hosts(Base):
    def test_missing_config_refuses(self):
        with self.assertRaises(rt.Refused) as e:
            rt.load_hosts()
        self.assertEqual(e.exception.code, "no_config")

    def test_group_writable_config_refuses(self):
        self.standard_hosts()
        (self.state / "hosts.json").chmod(0o620)
        with self.assertRaises(rt.Refused) as e:
            rt.load_hosts()
        self.assertEqual(e.exception.code, "bad_config")

    def test_bad_entries_are_dropped(self):
        self.write_hosts({"hosts": {
            "ok": {"destination": "ok-alias"},
            "-dash": {"destination": "x"},
            "opt": {"destination": "-oProxyCommand=id"},
            "user": {"destination": "x", "user": "root"},
            "port": {"destination": "x", "port": 22},
        }})
        hosts, _, problems = rt.load_hosts()
        self.assertEqual(sorted(hosts), ["ok"])
        self.assertEqual(len(problems), 4)

    def test_example_file_is_valid(self):
        self.state.mkdir(parents=True)
        shutil.copy(PLUGIN / "hosts.example.json", self.state / "hosts.json")
        (self.state / "hosts.json").chmod(0o600)
        hosts, _, problems = rt.load_hosts()
        self.assertEqual(problems, [])
        self.assertTrue(hosts)


class Stdio(Base):
    def test_stdio_session(self):
        self.install_local_ops()
        self.standard_hosts()
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_hosts", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "docker_ps", "arguments": {"host": "box"}}},
            {"jsonrpc": "2.0", "id": 5, "method": "nope"},
        ]
        stdin = "\n".join(json.dumps(m) for m in msgs) + "\nnot json\n"
        out = subprocess.run([sys.executable, "-B", str(SCRIPT), "mcp"], input=stdin, capture_output=True, text=True, timeout=30)
        replies = [json.loads(l) for l in out.stdout.splitlines()]
        self.assertEqual([r.get("id") for r in replies], [1, 2, 3, 4, 5, None])
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], "remote-tools")
        self.assertIn("docker_logs", [t["name"] for t in replies[1]["result"]["tools"]])
        self.assertFalse(replies[3]["result"]["isError"])
        self.assertIn("hello from fake ssh", replies[3]["result"]["content"][0]["text"])
        self.assertEqual(replies[4]["error"]["code"], -32601)
        self.assertEqual(replies[5]["error"]["code"], -32700)
        self.assertEqual(self.audit_lines()[0]["client"], "test")

    def test_ops_subcommand_checks_a_file(self):
        out = subprocess.run([sys.executable, "-B", str(SCRIPT), "ops", str(OPS)], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("docker-logs:", out.stdout)


if __name__ == "__main__":
    unittest.main()
