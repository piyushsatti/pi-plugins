# Third-party notices

The code in this repository is MIT (see [LICENSE](LICENSE)) unless a file or folder says otherwise. The items below are not ours, or come from somewhere else.

## Included in this repository

| Where | What | Licence | Notice |
|---|---|---|---|
| `plugins/memory/observational-memory/` | A port of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory), commit `022da5e` | MIT, Copyright (c) 2026 pi-observational-memory contributors | Kept in that plugin's `LICENSE`. |
| `plugins/editorial/editor/skills/humanizer/` | [blader/humanizer](https://github.com/blader/humanizer) v3.0.0, commit `9862685`, with local edits | MIT, Copyright (c) 2025 Siqi Chen | Its `LICENSE` sits beside the skill. |
| `plugins/thinking-method/manifold/references/` | Reference excerpts | MIT | See that plugin's `THIRD_PARTY_NOTICES.md`. |

## Downloaded at install, not included

| Plugin | What | Licence | Note |
|---|---|---|---|
| chirp | [Piper](https://github.com/OHF-Voice/piper1-gpl) speech engine, which bundles eSpeak NG | GPL-3.0-or-later | chirp imports Piper in-process. Distributing chirp together with Piper is a GPL-3.0 combined work. See `plugins/human-in-the-loop/chirp/docs/licenses.md`. |
| chirp | `en_US-ljspeech-medium` voice | see chirp's `docs/licenses.md` | |
| agent-coop | `phonemizer` (npm), which wraps eSpeak NG | Apache-2.0 wrapper; eSpeak NG is GPL-3.0 | Arrives with `bun install`. |
| agent-coop | `@img/sharp-libvips` (transitive) | LGPL-3.0 | Arrives with `bun install`. |
| alexandria | embedding models `BAAI/bge-small-en-v1.5` and `minishlab/potion-base-8M` | MIT | Fetched from the Hugging Face hub on first use. |

## Listed in the marketplace only

| Plugin | Source | Licence |
|---|---|---|
| ponytail | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | its own; not copied here |
| repowise | [repowise-dev/repowise](https://github.com/repowise-dev/repowise), folder `plugins/claude-code` | AGPL-3.0; not copied here |
