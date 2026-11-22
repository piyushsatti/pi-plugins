"""manifold tests, ported from Pi Commons tests/contract/manifold-spaces.test.ts and
tests/contract/manifold-package.test.ts.

The originals ran against compiler-built target folders with PI_HOME pointed at a temp dir. Here the
helper is bin/manifold-spaces (installed as ~/.local/bin/manifold-spaces) and MANIFOLD_STATE points at
a temp dir. Stdlib only, no network, never touches the real ~/.local/state.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "bin" / "manifold-spaces"
SKILLS = ["init", "help", "orient", "needs", "requirements", "arrangements", "review", "results", "change"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Fixture:
    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self._tmp.name))
        self.state = self.root / "global-state"
        self.repo = self.root / "project"
        (self.repo / ".git").mkdir(parents=True)

    def run(self, cwd, *args, state=None, stdin=None, through_shebang=False):
        env = {**os.environ, "MANIFOLD_STATE": str(state if state is not None else self.state)}
        command = [str(HELPER), *args] if through_shebang else [sys.executable, "-B", str(HELPER), *args]
        return subprocess.run(command, cwd=cwd, env=env, input=stdin, capture_output=True, text=True, check=False)

    def close(self):
        self._tmp.cleanup()


class GlobalSpaces(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()

    def tearDown(self):
        self.f.close()

    def test_same_root_from_any_directory_and_read_only_entry_does_not_initialize(self):
        a = self.f.run(self.f.repo, "root")
        b = self.f.run(self.f.root, "root")
        self.assertEqual(a.returncode, 0, a.stderr)
        self.assertEqual(a.stdout, b.stdout)
        self.assertEqual(a.stdout.strip(), str(self.f.state / "spaces"))
        listing = self.f.run(self.f.repo, "list")
        self.assertEqual(json.loads(listing.stdout)["spaces"], [])
        self.assertFalse(self.f.state.exists())
        self.assertEqual(os.listdir(self.f.repo), [".git"])

    def test_default_root_is_local_state(self):
        env = {**os.environ, "HOME": str(self.f.root / "home")}
        env.pop("MANIFOLD_STATE", None)
        out = subprocess.run([sys.executable, "-B", str(HELPER), "root"], cwd=self.f.root, env=env, capture_output=True, text=True, check=False)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), str(self.f.root / "home/.local/state/manifold/spaces"))

    def test_appends_checkpoints_resumes_the_named_space_and_keeps_spaces_separate(self):
        first = self.f.run(self.f.repo, "checkpoint", "--space", "care", "--content-file", "-", stdin="# Care\nN1: reliable support; criterion unknown.")
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.f.run(self.f.root, "checkpoint", "--space", "care", "--content-file", "-", stdin="# Care\nN1 retained; interview paused before criterion choice.", through_shebang=True)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotEqual(second.stdout, first.stdout)
        self.assertIn("criterion unknown", Path(first.stdout.strip()).read_text())
        self.assertEqual(self.f.run(self.f.repo, "latest", "--space", "care").stdout, second.stdout)
        self.assertEqual(self.f.run(self.f.repo, "latest", "--space", "finance").returncode, 1)
        (self.f.state / "spaces/.DS_Store").write_text("unrelated Finder metadata")
        items = json.loads(self.f.run(self.f.repo, "list").stdout)["spaces"]
        self.assertEqual([item["space"] for item in items], ["care"])
        self.assertEqual(len(os.listdir(self.f.state / "spaces/care/checkpoints")), 2)
        self.assertEqual(os.listdir(self.f.repo), [".git"])

    def test_rejects_local_roots_path_traversal_and_symlink_escapes(self):
        for state in ("state", self.f.repo / "state"):
            out = self.f.run(self.f.repo, "checkpoint", "--space", "care", "--content-file", "-", state=state, stdin="test")
            self.assertEqual(out.returncode, 1, (state, out.stdout))
        self.assertEqual(self.f.run(self.f.repo, "checkpoint", "--space", "../project", "--content-file", "-", stdin="test").returncode, 1)
        spaces = self.f.state / "spaces"
        spaces.mkdir(parents=True)
        (spaces / "care").symlink_to(self.f.repo, target_is_directory=True)
        self.assertEqual(self.f.run(self.f.repo, "checkpoint", "--space", "care", "--content-file", "-", stdin="test").returncode, 1)
        self.assertEqual(os.listdir(self.f.repo), [".git"])

    def test_reports_blocked_storage_and_empty_content_without_claiming_initialization(self):
        self.assertEqual(self.f.run(self.f.repo, "checkpoint", "--space", "care", "--content-file", "-", stdin=" ").returncode, 1)
        self.assertFalse(self.f.state.exists())
        self.f.state.write_text("not a directory")
        failure = self.f.run(self.f.repo, "checkpoint", "--space", "care", "--content-file", "-", stdin="useful partial view")
        self.assertEqual(failure.returncode, 1)
        self.assertIn("Expected a directory", failure.stderr)
        self.assertEqual(os.listdir(self.f.repo), [".git"])


def slug(value):
    value = unquote(value).lower()
    value = re.sub(r"<[^>]*>", "", value)
    value = re.sub(r"[^\w\-\s]", "", value)
    return value.replace(" ", "-")


class PackageIntegrity(unittest.TestCase):
    """Not behavioural proof: the files and references the skills point at are present and intact."""

    def test_nine_entrypoints_roles_and_lenses_ship(self):
        for name in SKILLS:
            self.assertTrue((ROOT / "skills" / name / "SKILL.md").is_file(), name)
        for role in ("guide", "modeler", "reviewer"):
            self.assertTrue((ROOT / "references/roles" / f"{role}.md").is_file(), role)
        for lens in ("stakeholders", "operations", "interfaces", "consequences", "attention"):
            self.assertTrue((ROOT / "references/lenses" / f"{lens}.md").is_file(), lens)
        for absent in ("agents", "commands", "hooks", ".mcp.json", "mcp.json", "extensions"):
            self.assertFalse((ROOT / absent).exists(), absent)
        self.assertEqual(json.loads((ROOT / ".codex-plugin/plugin.json").read_text())["skills"], ["./skills"])

    def test_references_match_their_recorded_hashes(self):
        manifest = json.loads((ROOT / "references/source-manifest.json").read_text())
        self.assertEqual(len(manifest["files"]), 39)
        for record in manifest["files"]:
            path = ROOT / "references" / record["packagedPath"]
            self.assertTrue(path.is_file(), record["packagedPath"])
            self.assertEqual(sha(path.read_bytes()), record["packagedSha256"], record["packagedPath"])
        self.assertEqual(sha((ROOT / "references/LICENSE-MIT.txt").read_bytes()), manifest["licenseSha256"])

    def test_markdown_links_resolve_inside_the_plugin(self):
        # README.md and VERIFIED.md link to the workstation repo's decisions, so they are left out.
        skip = {ROOT / "README.md", ROOT / "VERIFIED.md"}
        for md in sorted(p for p in ROOT.rglob("*.md") if p not in skip and "tests" not in p.relative_to(ROOT).parts):
            text = md.read_text()
            self.assertIsNone(re.search(r"/Users/|file://|/home/", text), f"private runtime path in {md}")
            for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", text):
                link = match.group(1)
                if re.match(r"^https?:", link):
                    continue
                path, _, anchor = link.partition("#")
                destination = (md.parent / unquote(path)).resolve() if path else md
                self.assertTrue(str(destination).startswith(str(ROOT)), f"escaping link in {md}: {link}")
                self.assertTrue(destination.exists(), f"broken link in {md}: {link}")
                if anchor and destination.suffix == ".md":
                    body = destination.read_text()
                    anchors = {slug(m) for m in re.findall(r"^#+ (.+)$", body, re.M)} | set(re.findall(r'<a id="([^"]+)"', body))
                    self.assertIn(unquote(anchor), anchors, f"missing anchor in {md}: {link}")

    def test_skill_frontmatter_holds_only_portable_keys(self):
        for name in SKILLS:
            head = (ROOT / "skills" / name / "SKILL.md").read_text().split("---\n")[1]
            keys = set(re.findall(r"^([A-Za-z_-]+):", head, re.M))
            self.assertTrue(keys <= {"name", "description", "allowed-tools"}, (name, keys))


if __name__ == "__main__":
    unittest.main()
