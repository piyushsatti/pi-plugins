# ordinator

Execution orchestration for a fleet of implementation sessions. One orchestrator supervises many disposable child sessions. Each child takes one ticket from scope to a draft pull request through a checkpointed workflow that pauses and resumes, and every stage's finding goes to the human who has to rule on it.

ordinator is the home for all orchestration-shaped work. The Plan Manager (`pm`) and Task Manager (`tm`) sit in [internal/](internal/README.md) as ordinator internals, and nothing loads them yet.

## Harness support

ordinator is built on Claude Code. The Workflow tool runs `ticket-pr`, and the skills use `SendMessage`, `ListAgents`, `ScheduleWakeup` and `Agent` with `ordinator:*` subagent types. `ordinator-launch-impl` starts every child as a `claude` process in tmux. Neither of the other harnesses has these tools, so what they get is loading and reading, not running.

| Harness | What works | Reduced | Missing |
|---|---|---|---|
| Claude Code | All three skills (`/ordinator:setup`, `/ordinator:orchestrate`, `/ordinator:implement`), the eleven agents (namespaced `ordinator:<agent>`), the `ticket-pr` workflow and the `ordinator-*` executables. | The workflow can't be resolved from the plugin. `setup` copies `workflows/ticket-pr.js` into `<project>/.claude/workflows/`, and that copy has to be redone whenever the plugin's copy changes. | pm and tm aren't wired (see [internal/](internal/README.md)). |
| Codex | **Skills only.** The three skills load as Agent Skills, so they can be read and followed by hand. | `setup` can write `<project>/.ordinator/`, but its workflow-copy step names `${CLAUDE_PLUGIN_ROOT}`, which Codex doesn't set. `orchestrate` and `implement` stop at their first Claude-only tool, and children still launch as Claude sessions. | Agents (Codex plugins don't ship them), the workflow (Claude-only), pm and tm. |
| Cursor | The three skills and the eleven agents load from `skills/` and `agents/`. | The agents' `tools:` allowlists (including the `Bash(...)` scopes), `model: sonnet/opus/haiku` and `effort:` are Claude Code fields. Whether Cursor honours them is unverified, so the narrow tool surfaces may not hold. `orchestrate` and `implement` need the same Claude-only tools as in Codex. | The workflow (Claude-only), pm and tm. |

**Why Codex is claimed at all.** The rule for this move was that Codex gets skills-only support if the plugin has skills, and ordinator has three, so it ships a Codex manifest. What Codex can do with them is limited to reading and following them by hand. Deleting `.codex-plugin/` drops the claim.

**Workflows are Claude-only.** `workflows/ticket-pr.js` is a script for Claude Code's Workflow tool. Neither Codex nor Cursor has an equivalent, so neither manifest names it.

## What it is

Three skills and eleven stage agents work off one workflow, `ticket-pr`.

- **setup** configures a project: bound facts (session prefix, fleet directory, worktree layout, hub path pattern, rulebook directory, lint and test commands). It copies the workflow file to where it can run, and gitignores the config by default.
- **orchestrate** is the fleet supervisor. It launches children in tmux, relays scope and plan questions to the human, records rulings, resumes a child whose process died, and merges.
- **implement** is what each launched child runs. It reads its handoff, scopes the ticket with the user and drives `ticket-pr` stage by stage. Then it pushes, opens the draft PR, and idles for corrections until it's told the PR merged.

The eleven agents are `plan-author`, `plan-signer`, `plan-reviewer`, `code-implementor`, `code-simplifier`, `code-reviewer`, `code-fixer`, `pr-author`, `code-scout`, `architecture-reviewer` and `record-writer`. They ship with the plugin, so they resolve with the namespace: `ordinator:plan-author`, not `plan-author`. That's why `ticket-pr.js` builds every `agentType` through an `AGENT()` helper instead of a literal string.

## Executables

`install.json` copies these to `~/.local/bin/`. The skills call them by those names, and they find each other through their own directory, never the plugin folder.

| Command | Was | Does |
|---|---|---|
| `ordinator-launch-impl` | `scripts/launch-impl.sh` | Creates a child's session directory, handoff and settings, launches it in tmux and records the fleet row. Also handles `--smoke` and `--resume`. |
| `ordinator-smoke-impl` | `scripts/smoke-impl.sh` | Makes a throwaway worktree and launches an environment check in it. |
| `ordinator-session-usage` | `scripts/session-usage.sh` | Usage report for one child's transcripts. |
| `ordinator-usage-report` | `scripts/usage-report.py` | Token and failure tables from transcripts; called by `ordinator-session-usage`. |
| `ordinator-window-check` | `scripts/window-check.py` | Reads the rate-limit sidecar and prints `ok`, `hold` or `unknown`. |
| `ordinator-lint-agent` | `scripts/lint-agent.py` | Lints agent files: frontmatter, models, efforts, known tool names, no em dashes. |
| `ordinator-find-clone` | `scripts/find-clone.sh` | Shell function sourced by the two launch scripts (mode 0644). |
| `ordinator-known-tools.txt` | `scripts/known-tools.txt` | The tool list `ordinator-lint-agent` reads from beside itself (mode 0644). |

`ordinator-smoke-impl` and the `orchestrate` skill still find the external worktree plugin's `worktree.sh` under `~/.claude/plugins/cache/`. That dependency stays outside ordinator.

## The `ticket-pr` workflow: checkpointed and resumable

Every stage (`Plan`, `Signatures`, `PlanReview`, `Build`, `Simplify`, `Review`, `PR`) writes a checkpoint to `<sessionDir>/checkpoints/<stage>.json` before it returns control. A session that dies or pauses can be re-invoked with `args.checkpoints`, and it skips the stages already done at no cost.

- **Blocking questions.** A blocking question still pauses the workflow. The stage that raised it is checkpointed first, so ruling on the question and resuming never re-runs a stage that was already answered.
- **The PlanGate pause.** A human `PlanGate` pause follows a passing plan review. The plan is rendered to a readable `plan.md`: decisions taken for you, the plan, the signatures and the review history, with the raw JSON folded under `<details>`. Nothing is built until the workflow gets `planApproved: true` or a plan-stage ruling.
- **The audit trail.** `plan-log.md` is append-only across runs, with one dated section per stage per run, so `plan.md` itself doesn't have to carry the history.
- **Ruling scope.** A ruling applies to the stage it was made at and to later ones (`rulings: [{stage, text}]`). A ruling made at Signatures therefore never invalidates the Plan stage's prompt cache entry on resume.
- **Revision drift.** A plan revision round reverts any file whose only change wasn't named by a reviewer finding. It fails the round outright if a revision adds or removes a file the finding never named.

## Configured per project: `PROJECT.md` and `REFERENCE.md`

`setup` writes `<project>/.ordinator/PROJECT.md`, a fenced `ordinator-project` block of `key: value` bound facts. The keys are `session_prefix`, `fleet_dir`, `worktree_root`, `clone_dir`, `hub_path_pattern`, `decisions_dir`, `confluence_dir`, `rulebook_dir`, `lint_command`, `test_command`, `max_concurrent_children` and `window_cutoff`. `ordinator-launch-impl` and `ordinator-smoke-impl` parse the block at run time.

The file reads `configured: no` until setup finishes, and `orchestrate` and `implement` both refuse to run against an unconfigured project.

A launched child can reach only four paths: the worktree, the session directory, the decisions directory and the confluence directory. `.ordinator/` sits outside them. `REFERENCE.md` carries the same bound facts in the form the child needs, so it's copied into `$WT/.claude/workflows/ticket-pr-reference.md` at every launch and every `--resume`.

These files are project configuration, written by the user's choice inside their project. ordinator keeps no data of its own.

## Protocol messages

The first line of each message names the tag.

From child to orchestrator:

| Tag | Meaning |
|---|---|
| `STARTED <KEY>` | The session announced itself; worktree and branch confirmed. |
| `SCOPE <KEY>` | Scope judgement ready, waiting for a ruling. |
| `QUESTION <KEY> <stage>` | A stage paused on a blocking question, or on a non-blocking one that became blocking. |
| `PLAN <KEY>` | The PlanGate pause: `plan.md` is ready to read. |
| `ENDED <KEY> PASS` | PR opened as a draft; the session is idling for corrections. |
| `ENDED <KEY> FAIL <stage>` | A stage failed outright; findings attached. |
| `MERGED <KEY>` | Acknowledges the orchestrator's MERGED and stops. |

From orchestrator to child:

| Tag | Meaning |
|---|---|
| `RULING <KEY> <stage> <text\|approved>` | Answers a QUESTION or a PLAN pause. |
| `SOURCES <KEY>` | Appends new source entries to the child's scope. |
| `HOLD <KEY>` | Rulings are pending; wait without polling. |
| `STOP <KEY>` | End the session and record why. |
| `CORRECTION <KEY>` | A post-PR fix, dispatched to `code-fixer` and then `code-reviewer`. |
| `MERGED <KEY>` | The PR merged; close the session. |

## Install

Not installed yet. Once the `pi` catalogs list it, it installs as `ordinator@pi`, and `install.json`'s files go to `~/.local/bin/`. Then run `/ordinator:setup` in each project. Nothing runs before setup, because `orchestrate` and `implement` both check that `.ordinator/PROJECT.md` says `configured: yes`.

## Requires

- Claude Code (`claude`) with ordinator enabled and the Workflow, Agent, Skill, SendMessage, ListAgents and ScheduleWakeup tools. Without them, children cannot launch or run the workflow and fleet protocol.
- `tmux` for child sessions. Without it, launch, resume and fleet tracking fail.
- `jq` for settings and window-check JSON. Without it, the launcher cannot launch children.
- Python 3.9 or newer (`python3`) for window checks, usage reports and agent lint. Those commands fail without it.
- Git and an authenticated GitHub CLI (`gh`). Git is needed for worktrees and branch checks; without `gh`, the implementation skill cannot open draft PRs or reply to corrections.
- The external worktree plugin, with `worktree.sh` under `~/.claude/plugins/cache/*/worktree/*/scripts/`. Without it, the orchestrate skill cannot create worktrees and `ordinator-smoke-impl` cannot run.
- A rate-limit sidecar producer, such as `~/.claude/rate-limits-sidecar.sh`, writing `~/.local/state/claude/rate-limits.json` (or `CLAUDE_RATE_LIMITS_FILE`). It must supply `written_at`, `five_hour` and `seven_day` usage data. Missing or stale data makes normal launches hold with `unknown`; `--force` needs the user's ruling. The producer is not included here.
- Serena's symbol tools or a working LSP for the project's languages. Without either, code-scout blocks on symbol questions.

The project's lint and test commands need their own tools (such as `uv`, `ruff`, `pytest`, or Node.js with `npm`/`npx`); missing tools stop the build checks. Node.js is also needed for this repo's script tests. `rsync` is optional; the launcher falls back to `cp` and `find`. Context7 is an optional source-lookup alternative to WebSearch and WebFetch.

## Tests

```
node --test tests/*.test.mjs
```

Run this from this folder. `fleet-row.test.mjs` sources only the launcher's fleet-row function definitions, without running its launch code. It checks literal `#`, `&` and backslashes, exact preservation of other rows, deletion, and files without a final newline. It uses `/bin/bash` and the system tools in `/usr/bin:/bin`, including macOS's own awk when run on a Mac.

`ticket-pr.test.mjs` runs the workflow body against a mock agent. The cases cover:

- the cold run to PlanGate, and checkpoint-and-resume
- ruling scope, and that `plan-log.md` stays append-only
- plan revision drift, and reconciling the plan with the signatures
- the existing blocking, smoke and BLOCKED behaviour
- that a blocking pause at Plan or Signatures still checkpoints before it pauses

`ordinator-lint-agent agents/*.md` checks the agents.
