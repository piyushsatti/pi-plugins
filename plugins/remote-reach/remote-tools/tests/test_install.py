"""remote/install.sh under --root: the files, their modes, the authorized_keys line, and the keys it refuses."""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
INSTALL = PLUGIN / "remote" / "install.sh"
KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample remote-tools"


class Install(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "root"
        self.key = Path(self.tmp.name) / "key.pub"

    def tearDown(self):
        self.tmp.cleanup()

    def install(self, key=KEY, root=True):
        self.key.write_text(key)
        args = ["sh", str(INSTALL)] + (["--root", str(self.root)] if root else []) + [str(self.key)]
        return subprocess.run(args, capture_output=True, text=True, timeout=60)

    def mode(self, rel):
        return stat.S_IMODE(os.stat(self.root / rel).st_mode)

    def test_installs_the_gate_ops_and_key(self):
        r = self.install(KEY + "\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        gate = self.root / "usr/local/bin/remote-tools"
        self.assertEqual(gate.read_text().splitlines()[0], "#!/usr/bin/python3 -I")
        self.assertEqual(gate.read_text().splitlines()[1:], (PLUGIN / "bin/remote-tools").read_text().splitlines()[1:])
        self.assertEqual((self.root / "etc/remote-tools/ops.json").read_text(), (PLUGIN / "ops.json").read_text())
        keys = (self.root / "var/lib/agent-ops/.ssh/authorized_keys").read_text()
        self.assertEqual(keys, f'command="/usr/local/bin/remote-tools gate",restrict {KEY}\n')
        self.assertEqual(self.mode("usr/local/bin/remote-tools"), 0o755)
        self.assertEqual(self.mode("etc/remote-tools/ops.json"), 0o644)
        self.assertEqual(self.mode("var/lib/agent-ops/.ssh/authorized_keys"), 0o644)
        self.assertEqual(self.mode("var/lib/agent-ops/.ssh"), 0o755)
        # No temp files left beside the targets.
        for folder, names in [("usr/local/bin", ["remote-tools"]), ("etc/remote-tools", ["ops.json"]),
                              ("var/lib/agent-ops/.ssh", ["authorized_keys"])]:
            self.assertEqual(sorted(os.listdir(self.root / folder)), names)

    def test_second_run_replaces_the_key(self):
        self.assertEqual(self.install().returncode, 0)
        other = KEY.replace("remote-tools", "second")
        self.assertEqual(self.install(other).returncode, 0)
        keys = (self.root / "var/lib/agent-ops/.ssh/authorized_keys").read_text().splitlines()
        self.assertEqual(keys, [f'command="/usr/local/bin/remote-tools gate",restrict {other}'])

    def test_refuses_anything_but_one_plain_key(self):
        for bad in ["", "garbage", KEY + "\n" + KEY, f'command="/bin/sh" {KEY}', f"no-pty {KEY}",
                    "ssh-ed25519 AAAA$(id)", "ssh-ed25519 AAAA comment with spaces", "ssh-dss AAAAB3Nza"]:
            with self.subTest(key=bad):
                r = self.install(bad)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("refused", r.stderr)
        self.assertFalse((self.root / "var/lib/agent-ops/.ssh/authorized_keys").exists())

    @unittest.skipIf(os.getuid() == 0, "the root check only shows when not root")
    def test_without_root_flag_needs_root(self):
        r = self.install(root=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("run as root", r.stderr)


if __name__ == "__main__":
    unittest.main()
