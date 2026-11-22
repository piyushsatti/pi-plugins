import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from check import check


def kinds(text):
    return [kind for _, kind, _ in check(text)]


class CheckTests(unittest.TestCase):
    def test_clean_draft_has_no_findings(self):
        text = "# Title\n\nOne paragraph on one line.\n\n- a list item\n- another\n\n```\ncode that\nwraps\n```\n"
        self.assertEqual(check(text), [])

    def test_email_found_but_noreply_and_example_allowed(self):
        self.assertEqual(kinds("mail someone@company.io now."), ["email"])
        self.assertEqual(kinds("1+me@users.noreply.github.com and a@example.com."), [])

    def test_secrets(self):
        self.assertEqual(kinds("token: ghp_" + "a" * 30), ["secret"])
        self.assertEqual(kinds("-----BEGIN OPENSSH " + "PRIVATE KEY-----"), ["secret"])

    def test_private_ip_and_internal_host(self):
        self.assertEqual(kinds("ssh to 10.0.0.4 or 8.8.8.8."), ["private-ip"])
        self.assertEqual(kinds("open build.corp in a browser."), ["internal-host"])

    def test_long_number(self):
        self.assertEqual(kinds("card 4111 1111 1111 1111 on file."), ["long-number"])

    def test_hard_wrap(self):
        self.assertEqual(
            kinds("This sentence goes on and\nthen continues here."), ["hard-wrap"]
        )

    def test_front_matter_is_not_prose(self):
        self.assertEqual(kinds("---\nname: x\ndescription: y\n---\n\nBody.\n"), [])


if __name__ == "__main__":
    unittest.main()
