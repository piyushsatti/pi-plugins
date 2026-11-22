# editor

Write and review things other people will read: design notes, tickets, bug reports, PR descriptions, runbooks and announcements. One short rulebook, a mechanical leak check, and a humanizer pass for prose that sounds machine-written.

## What it has

| Part | Kind | Does |
|---|---|---|
| `draft` | skill | Drafts one piece for one reader to the rulebook, checks it, and stops at a local file until the human says yes to publishing. |
| `review` | skill | Reviews a draft in two passes, mechanical then reader, and reports findings without editing. |
| `humanizer` | skill | Rewrites AI-sounding text so it reads like the writer, without changing what it says. Vendored from [blader/humanizer](https://github.com/blader/humanizer) v3.0.0 (MIT, licence beside it), with local edits. |
| `reviewer` | agent | The reader's pass of `review`, run without the author's context. Read-only. |
| `RULEBOOK.md` | file | The rules both skills use. Point `EDITOR_RULEBOOK` at your own file to replace it. |
| `scripts/check.py` | script | Finds email addresses, credential-like strings, private IPs and internal host names, long digit runs, and hard-wrapped paragraphs. Python 3 standard library only. |

## Use

```bash
python3 scripts/check.py path/to/draft.md
```

It prints `file:line: kind: detail` per finding and exits 1 if there are any.

Run the tests from this folder:

```bash
python3 -m unittest discover -s tests
```

## Harness support

| Harness | Manifest | Skills | Agent |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | yes | yes |
| Codex | `.codex-plugin/plugin.json` | yes | not declared |
| Cursor | `.cursor-plugin/plugin.json` | yes | yes |

Not yet run inside any harness; see [VERIFIED.md](VERIFIED.md).
