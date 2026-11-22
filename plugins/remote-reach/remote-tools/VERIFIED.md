# remote-tools: verification

Levels are defined in [verification ladder](../../../CONVENTIONS.md#verification-ladder). Claimed harnesses: Claude Code, Codex, Cursor. The rows start over at 2026-10-28, when rpctool became remote-tools. rpctool's runs covered a hook and a tool that no longer exist.

| Level | Harness | Date | Machine | Version | Command | Result |
|---|---|---|---|---|---|---|
| V0 lint | all | 2026-10-28 | this Mac | lint_plugins.py as of an earlier repo, commit 7ee756e | `uv run python -B scripts/lint_plugins.py` | pass: 0 errors. One warning: not in the catalogs until it is pushed and `plugins.json` pins its sha. |
| V1 native validator | Claude Code | 2026-10-28 | this Mac | Claude Code 2.1.310 | `claude plugin validate ~/Source/remote-tools` | pass. Its one suggestion, a marketplace install line in the README, is in. |
| V1 native validator | Codex, Cursor | — | — | — | none exists | not run |
| V2 script tests | all | 2026-10-28 | this Mac | Python 3.9.6 | `python3 -B -m unittest discover -s tests -v` | 41 tests, all pass (about 11 s). See [what they cover](#v2-2026-10-28). |
| V3 loads without install | Claude Code, Codex, Cursor | — | — | — | `claude -p --plugin-dir ~/Source/remote-tools` | not run. The MCP command runs `~/.local/bin/remote-tools`, which isn't installed yet. |
| V4 gate on a real host | — | — | — | — | `ssh <alias> docker-ps`, the refusal list, `journalctl -t remote-tools` | not run. Waits for `install.sh` on the host. |
| V4 runtime behaviour | Claude Code, Codex, Cursor | — | — | — | MCP `docker_logs` against a real host | not run |
| V5 in use | all | — | — | — | — | not run |

## V2, 2026-10-28

The remote programs are fakes on a temporary `PATH`, and ssh is a fake script. No real host was contacted.

Two new tests check the five JSON-encoded `docker-ps` fields, including quoted names, and one timeout shared by all commands, including expiry before the next command starts. The Docker template test substitutes the JSON fields locally; it does not run Docker.

- **Operations file:**
  - the shipped `ops.json` loads;
  - every operation has an exact-argv case;
  - a file writable by group or others is refused;
  - each of 13 bad definitions refuses the whole file: an unanchored or broken pattern, an unused or undeclared parameter, a program taken from a parameter, a bad flag, an out-of-range timeout or default, an unknown key, an empty run.
- **Gate:**
  - the exact argv for all six operations;
  - defaults and optional parameters;
  - parameter order doesn't matter;
  - 40 bad requests refused with exit 126 and nothing run, among them `bash -i`, `scp -t`, a leading `-`, `;`, `$()`, backticks, `|`, `&`, a newline, a carriage return, a tab, quotes, out-of-range and non-numeric `lines`, a bad `since`, a duplicate or unknown key, a 2,000-character value and `../`;
  - with no command it lists the operations;
  - a bad operations file runs nothing;
  - start, end and refused records, with the tag and facility passed to syslog;
  - only the environment the gate builds reaches the command (macOS adds `__CF_USER_TEXT_ENCODING` to every process, and the test allows for it);
  - a timeout kills the command, exits 124 and stops the rest of the operation;
  - a missing program is reported;
  - the source has no `shell=True` and only one `Popen`.
- **MCP:**
  - one tool per operation, with schemas and read-only annotations;
  - the exact ssh argv, with the request after `--`;
  - bad values and unknown hosts are refused before ssh runs;
  - a gate refusal (exit 126) is explained;
  - ssh is killed on timeout;
  - output is capped and wrapped in untrusted markers;
  - audit records start, end and refused, with mode 0600;
  - an audit log that can't be written refuses the call;
  - with no local operations file, only `list_hosts` is offered;
  - a stdio session works;
  - **a round trip for all six operations: the MCP server, then a fake ssh, then the real gate, then the fake programs, with the argv checked.**
- **install.sh** under `--root`:
  - the gate gets the `#!/usr/bin/python3 -I` line and the rest of the script unchanged;
  - `ops.json` is copied;
  - `authorized_keys` holds exactly `command="/usr/local/bin/remote-tools gate",restrict <key>`;
  - modes are 0755/0644, and no temp files are left;
  - a second run replaces the key;
  - eight bad keys are refused: options in front, two lines, `$(…)`, a comment with spaces, `ssh-dss`, garbage and an empty file;
  - without `--root` it needs root.
