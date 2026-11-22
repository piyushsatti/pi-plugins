"""bin/agent-coop: the installed agent-coop-mcp / agent-coop-up / agent-coop-watch launcher. Standard library only.

A fake `bun` on PATH prints the arguments and AGENT_COOP_* environment it was given, so no Bun
runtime, dependency install or server is needed.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
LAUNCHER = PLUGIN / "bin" / "agent-coop"
FAKE_BUN = """#!/bin/sh
printf 'argv'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'
env | grep '^AGENT_COOP_' | sort
"""


class Launcher(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-coop-launcher-")
        self.addCleanup(self.temporary.cleanup)
        self.tmp = Path(self.temporary.name).resolve()
        self.home = self.tmp / "home"
        self.bin = self.tmp / "fakebin"
        self.bin.mkdir()
        (self.bin / "bun").write_text(FAKE_BUN)
        (self.bin / "bun").chmod(0o755)
        self.links = self.tmp / "links"
        self.links.mkdir()
        for name in ("agent-coop-mcp", "agent-coop-up", "agent-coop-watch", "agent-coop-other"):
            shutil.copy(LAUNCHER, self.links / name)
        self.runtime = self.home / ".local" / "share" / "agent-coop" / "runtime"
        for entry in ("src/mcp/index.ts", "scripts/up.ts", "scripts/watch.ts"):
            (self.runtime / entry).parent.mkdir(parents=True, exist_ok=True)
            (self.runtime / entry).write_text("")
        (self.runtime / "node_modules").mkdir()
        self.project = self.tmp / "project"
        self.project.mkdir()

    def run_as(self, name, *args, env=None, cwd=None):
        base = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home)}
        result = subprocess.run([str(self.links / name), *args], capture_output=True, text=True,
                                env={**base, **(env or {})}, cwd=cwd or self.project)
        lines = result.stdout.splitlines()
        values = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
        return result, (lines[0] if lines else ""), values

    def test_each_name_runs_its_entry_from_the_installed_runtime(self):
        for name, entry, args in (("agent-coop-mcp", "src/mcp/index.ts", ()),
                                  ("agent-coop-up", "scripts/up.ts", ("--json", "--title", "t")),
                                  ("agent-coop-watch", "scripts/watch.ts", ("--session", "s-1"))):
            with self.subTest(name=name):
                result, argv, _ = self.run_as(name, *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(argv, " ".join(["argv", "run", str(self.runtime / entry), *args]))
                self.assertNotIn(str(PLUGIN), result.stdout)

    def test_project_state_defaults_follow_claude_project_dir(self):
        other = self.tmp / "claude-project"
        _, _, env = self.run_as("agent-coop-up", env={"CLAUDE_PROJECT_DIR": str(other)})
        state = other / ".local-state" / "agent-coop"
        self.assertEqual(env, {
            "AGENT_COOP_DB": str(state / "agent-coop.sqlite"),
            "AGENT_COOP_DATA_DIR": str(state / "data"),
            "AGENT_COOP_NARRATION_DIR": str(state / "data" / "narration"),
            "AGENT_COOP_BACKUP_DIR": str(state / "history"),
            "AGENT_COOP_ARTIFACTS_DIR": str(state / "artifacts"),
            "AGENT_COOP_STATIC_DIR": str(self.runtime / "static"),
        })

    def test_without_claude_project_dir_the_current_directory_is_the_project(self):
        _, _, env = self.run_as("agent-coop-up")
        self.assertEqual(env["AGENT_COOP_DB"], str(self.project / ".local-state" / "agent-coop" / "agent-coop.sqlite"))
        for value in env.values():
            self.assertNotIn("/.pi/", value)

    def test_preset_variables_win(self):
        _, _, env = self.run_as("agent-coop-watch", env={"AGENT_COOP_DB": "/x/db.sqlite", "AGENT_COOP_PORT": "5000"})
        self.assertEqual(env["AGENT_COOP_DB"], "/x/db.sqlite")
        self.assertEqual(env["AGENT_COOP_PORT"], "5000")

    def test_agent_coop_runtime_override(self):
        moved = self.tmp / "moved"
        shutil.copytree(self.runtime, moved)
        result, argv, env = self.run_as("agent-coop-mcp", env={"AGENT_COOP_RUNTIME": str(moved)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(argv, f"argv run {moved / 'src/mcp/index.ts'}")
        self.assertEqual(env["AGENT_COOP_STATIC_DIR"], str(moved / "static"))

    def test_unknown_name_refuses(self):
        result, argv, _ = self.run_as("agent-coop-other")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(argv, "")
        self.assertIn("agent-coop-mcp, agent-coop-up or agent-coop-watch", result.stderr)

    def test_missing_runtime_or_dependencies_refuses(self):
        (self.runtime / "node_modules").rmdir()
        result, argv, _ = self.run_as("agent-coop-up")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(argv, "")
        self.assertIn("no installed runtime", result.stderr)


class Layout(unittest.TestCase):
    def test_docs_have_no_monorepo_links_or_named_support_owner(self):
        docs = [*PLUGIN.glob("*.md"), *PLUGIN.glob("runtime/*.md"), *PLUGIN.glob("runtime/docs/**/*.md")]
        for doc in docs:
            with self.subTest(doc=doc.relative_to(PLUGIN)):
                text = doc.read_text()
                self.assertNotRegex(text, r"\]\([^)]*(?:\.\./\.\./packages/|pi\.commons)[^)]*\)")
                self.assertNotRegex(text, r"claiming them is left to \w+")

    def test_install_json_installs_the_three_names(self):
        data = json.loads((PLUGIN / "install.json").read_text())
        self.assertEqual({e["dest"] for e in data["files"]},
                         {"~/.local/bin/agent-coop-mcp", "~/.local/bin/agent-coop-up", "~/.local/bin/agent-coop-watch"})
        self.assertEqual({e["src"] for e in data["files"]}, {"bin/agent-coop"})
        self.assertEqual([b["dest"] for b in data["builds"]], ["~/.local/share/agent-coop/runtime"])
        self.assertIn("--frozen-lockfile", data["builds"][0]["build"])

    def test_mcp_files_are_identical_and_call_the_installed_shim(self):
        claude, cursor = (PLUGIN / ".mcp.json").read_bytes(), (PLUGIN / "mcp.json").read_bytes()
        self.assertEqual(claude, cursor)
        server = json.loads(claude)["mcpServers"]["agent-coop"]
        self.assertEqual(server["command"], "sh")
        self.assertEqual(server["args"], ["-c", 'exec "$HOME/.local/bin/agent-coop-mcp"'])

    def test_skills_never_run_from_the_plugin_folder(self):
        for skill in (PLUGIN / "skills").glob("*/SKILL.md"):
            text = skill.read_text()
            self.assertNotRegex(text, r"\$\{?(CLAUDE_)?PLUGIN_ROOT")
            self.assertNotRegex(text, r"bun run [\"']?\S*runtime/")
            front = text.split("---")[1]
            keys = set(re.findall(r"^([a-z-]+):", front, re.M))
            self.assertLessEqual(keys, {"name", "description", "allowed-tools"}, skill)


if __name__ == "__main__":
    unittest.main()
