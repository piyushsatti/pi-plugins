# manifold

Manifold connects **needs**, **requirements** and **systems** so people can see unclear expectations, missing pieces and arrangements that do not serve the needs they were meant to address. It keeps sources, relationships, decisions and evidence around those connections, with each provision's documented standing preserved.

Manifold is **global to the user**, organised into dedicated spaces. A space can concern family care, a business, research or a particular project. It never lives inside that project's repository, and opening a repository does not choose a space.

It installs as `manifold@pi`.

## Harness support

The source manifest targeted Codex, Claude Code and Pi, and declared nothing unsupported. Pi is not claimed here. Cursor is added because manifold is skills only, and skills map natively to all three harnesses.

| Harness | What works | Reduced | Missing |
|---|---|---|---|
| Claude Code | All nine skills (`/manifold:init`, `/manifold:help`, `/manifold:orient`, `/manifold:needs`, `/manifold:requirements`, `/manifold:arrangements`, `/manifold:review`, `/manifold:results`, `/manifold:change`), with the references, lenses, roles, templates and examples they read. Durable spaces through `manifold-spaces`. | Nothing. | Nothing. |
| Codex | The nine skills from `skills/`, each with its `agents/openai.yaml` display metadata. Durable spaces through `manifold-spaces`. | Nothing. | Nothing. |
| Cursor | The nine skills from `skills/`. Durable spaces through `manifold-spaces`. | `agents/openai.yaml` inside each skill is Codex metadata and Cursor ignores it. | Nothing. |

Persistence needs `manifold-spaces` installed and Python 3 on `PATH`. Without it, every harness still gives conceptual guidance and an unsaved conversation, as before.

## Start with `init`

Say **"Manifold"** or **"Manifold init"** to use [the init skill](skills/init/SKILL.md). The first response briefly introduces the three concepts, explains the investment in establishing a foundation, and asks how you want to proceed: establish a space, resume one, or get help.

Establishment takes focused time and may span sessions. It's a manual, guided process, not an unattended setup or an automatic scan. You can start with either:

- **Document discovery:** choose a relevant, authorised document set with the agent. It reads a useful batch, links the sources and returns an attributable partial picture.
- **Interview:** talk through a concrete situation, one useful question at a time. The agent keeps your account and marks its own interpretation as such.

The modes compose, and after each round you see what was learned, what is still uncertain and one next useful step. See [the conversation example](examples/establishment.md).

## Get unstuck with `help`

Say **"Manifold help. I am stuck on..."** to use [the help skill](skills/help/SKILL.md). It diagnoses the actual problem, explains it through your case and offers a small next step. A conceptual question needs no space. These [short prompts](prompts.md) begin, switch modes or continue.

## The seven capabilities underneath

| Outcome | Skill | Result |
| --- | --- | --- |
| Orient and frame | [orient](skills/orient/SKILL.md) | Purpose, boundary, participants and the next choice. |
| Discover needs | [needs](skills/needs/SKILL.md) | Attributed accounts, disagreements and missing perspectives. |
| Form requirements | [requirements](skills/requirements/SKILL.md) | Proposed criteria, origins and why they address needs. |
| Describe arrangements | [arrangements](skills/arrangements/SKILL.md) | Parts, structure, process, dependencies and contribution. |
| Review alignment | [review](skills/review/SKILL.md) | Addressable findings, gaps and local trade-offs. |
| Interpret results | [results](skills/results/SKILL.md) | Scoped met/unmet/unknown results, extent and evidence limits. |
| Reconsider change | [change](skills/change/SKILL.md) | Affected conclusions and preserved earlier bases. |

Optional [lenses](references/lenses/index.md) and [guide, modeler and reviewer roles](references/roles/index.md) help focus the work. They are instructions, not agents, automatic dispatch or an approval chain.

## Executable

`install.json` copies `bin/manifold-spaces` to `~/.local/bin/manifold-spaces`. The skills and [the establishment guide](references/establishment.md) call it by that name, never from the plugin folder. It was `scripts/spaces.py`, and runs isolated (`python3 -I`) through its shebang.

| Command | Does |
|---|---|
| `manifold-spaces root` | Prints the spaces root. Creates nothing. |
| `manifold-spaces list` | Lists spaces and each one's latest checkpoint path, as JSON. Creates nothing. |
| `manifold-spaces latest --space <name>` | Prints the latest checkpoint path of one space; exit 1 if it has none. |
| `manifold-spaces checkpoint --space <name> --content-file <file or ->` | Appends one complete checkpoint, written atomically, and prints its path. |

The name `manifold-spaces` leaves alone any other `manifold` command already on `PATH`.

## Data: `~/.local/state/manifold/spaces/`

Each named space keeps append-only Markdown checkpoints under `~/.local/state/manifold/spaces/<space>/checkpoints/`. `MANIFOLD_STATE` overrides the base folder (spaces then go in `$MANIFOLD_STATE/spaces/`); it must be absolute, outside any Git repository and outside the plugin folder. The helper refuses symlinked managed folders and never falls back to the current project.

## Sources and licences

The [reference index](references/index.md) keeps scoped acceptance beside proposed concepts and application guidance. The [source strategy](SOURCE-STRATEGY.md) records source identities, hashes, excerpts and rights. `references/source/` is a byte-for-byte copy of an earlier build's output, checked against `references/source-manifest.json` by the tests.

Everything here is MIT: the reference excerpts ([references/LICENSE-MIT.txt](references/LICENSE-MIT.txt)) and the plugin's own skills, templates, lenses, roles, examples and tests ([LICENSE](LICENSE)). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install

Not installed yet. Once the `pi` catalogs list it, it installs as `manifold@pi`, and `install.json` copies `manifold-spaces` to `~/.local/bin/`.

## Tests

```
python3 -m unittest discover -s tests
```

Run this from this folder. The space tests point `MANIFOLD_STATE` (and, for the default-root case, `HOME`) at a temporary folder. The package tests check the nine skills, roles and lenses, the reference hashes and licence hash, frontmatter, and that every Markdown link inside the plugin resolves.
