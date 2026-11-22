# pi-plugins

Plugins for coding agents (Claude Code, Codex, Cursor), grouped as seven products. They install from one marketplace, `pi`, as `<plugin>@pi`. The name `pi` is unrelated to Pi Agent.

## Products

```
pi-plugins
├── Memory
│   └── observational-memory   notes kept beside compaction, recall by id; optional handoff ritual and record store
├── Remote reach
│   └── remote-tools           named, read-only operations on remote hosts, enforced on each host
├── Human in the loop
│   ├── chirp                  speaks a short outline when the agent stops
│   └── agent-coop             a shared document-review surface in the browser that wakes the agent
├── Shipping code
│   ├── ordinator              runs a fleet of implementation sessions, ticket to draft PR
│   └── agent-tmux             lets an agent see and lay out its own tmux session
├── Thinking method
│   └── manifold               model needs, requirements, systems and change through guided interviews
├── Alexandria
│   └── alexandria             search your own documents: a folder at a time, or a whole library
└── Editorial
    └── editor                 draft and review writing to a short rulebook; humanizer pass
```

The marketplace also lists two plugins by other people, installed from their own repositories: [ponytail](https://github.com/DietrichGebert/ponytail) and [repowise](https://github.com/repowise-dev/repowise) (AGPL-3.0, Claude Code only).

## Install

Claude Code:

```bash
claude plugin marketplace add piyushsatti/pi-plugins
claude plugin install observational-memory@pi
```

Codex reads the same marketplace from `.agents/plugins/marketplace.json`. Cursor has no marketplace here: add a plugin folder directly; each one ships a `.cursor-plugin/plugin.json`.

Several plugins also install a small runtime outside the plugin folder (listed in each plugin's `install.json`). Each plugin's README says what, where, and which harnesses it supports.

## Layout

```
plugins/<product>/<plugin>/    one plugin, with its own README, VERIFIED.md, tests and manifests
plugins.json                   the plugin list the catalogs are built from
.claude-plugin/marketplace.json
.agents/plugins/marketplace.json
CONVENTIONS.md                 the rules every plugin follows
scripts/                       write_catalogs.py, lint_plugins.py and their tests
```

```bash
python3 scripts/write_catalogs.py --apply
python3 scripts/lint_plugins.py
python3 -m unittest discover -s scripts/tests
```

## Licence

MIT, see [LICENSE](LICENSE). Third-party code and downloads are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
