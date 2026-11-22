---
name: setup
description: Configure ordinator for this project, or change one of its answers later. Use when the user asks to set up, configure, initialise or re-configure ordinator, when they ask to change the session prefix, the fleet directory, the worktree layout, the hub path pattern, the decisions or confluence directories, the rulebook directory, or the lint and test commands, or when `orchestrate` or `implement` has refused because `.ordinator/` is missing or unconfigured. Trigger phrases include "set up ordinator", "configure ordinator", "ordinator init", "change the fleet directory", "point ordinator at a different worktree root", "re-run ordinator setup".
---

# setup

## Purpose
Write `<project>/.ordinator/` so `orchestrate` and `implement` can run, and copy the workflow file to where the Workflow tool can find it. Re-runnable: setup exists to change one answer as much as to make all of them the first time.

## Blocking requirements
None; setup is what makes the other two skills stop being blocked. If `<project>/.ordinator/PROJECT.md` already exists and says `configured: yes`, treat this as a change, not a first run: ask which field to reopen rather than re-asking everything.

## Raise to the calling session
- A field with no sane default for this project (the session prefix, the fleet directory, the hub path pattern) that the user cannot answer on the spot: leave it as the shipped placeholder, note it under `PROJECT.md`'s "Open, and bearing on a launch" section, and say plainly that `orchestrate` will refuse to launch until it is filled.
- The project has no `notes/decisions/`-equivalent directory yet and the user has not said where rulings should live: ask once, do not invent a path.

## Method

### 1. Resolve the state
Read `<project>/.ordinator/PROJECT.md` if it exists.

| On disk | Do this |
|---|---|
| no `.ordinator/` | full interview |
| `PROJECT.md` present, `configured: no` | a previous setup did not finish; say so, show what is already filled, and resume from the first placeholder field |
| `PROJECT.md` present, `configured: yes` | this is a change, not a setup; ask which field to reopen |

### 2. Interview
Ask for the fenced `ordinator-project` block's fields one group at a time, stating what each controls, never asking for something derivable from the repository layout itself:

- `session_prefix`: short tag for tmux session names and fleet rows (e.g. the project's own short name).
- `fleet_dir`, `worktree_root`, `clone_dir`: paths relative to the project root; look at the project's actual layout first and propose what you find rather than asking cold.
- `hub_path_pattern`: where a ticket's hub document lives, with `<KEY>` standing in for the ticket key.
- `decisions_dir`, `confluence_dir`: where rulings and living documentation are read from; these become the child's read-only sources outside its own worktree.
- `rulebook_dir`: where the four rulebooks (`code-quality`, `error-handling`, `logging`, `code-comments`) live, relative to the worktree root.
- `lint_command`, `test_command`: exact commands, run from the worktree root.
- `max_concurrent_children`, `window_cutoff`: operating numbers; the shipped defaults (2, 90) are fine unless the user wants different ones.

Ask about the error hierarchy root (`defaults/PROJECT.md`'s "Error hierarchy root" table) only if the project has already settled one; otherwise leave it as "none yet" rather than forcing a decision setup does not need.

### 3. Write the result
In this order, because the last step is what makes the config live.

1. **Copy `defaults/PROJECT.md` to `<project>/.ordinator/PROJECT.md`** and fill the fenced block and the error-hierarchy table from the interview. Update `last_updated`.
2. **Copy `defaults/REFERENCE.md` to `<project>/.ordinator/REFERENCE.md`** unedited beyond `last_updated`; its placeholders (Tooling state, Open adjudications, Per-ticket rulings) fill in over time as tickets run, not during setup.
3. **Copy `${CLAUDE_PLUGIN_ROOT}/workflows/ticket-pr.js` to `<project>/.claude/workflows/ticket-pr.js`**, creating the directory if needed. The Workflow tool has no confirmed mechanism for resolving a plugin-shipped workflow by name, so the project's own `.claude/workflows/` is where `implement` invokes it from; re-run this copy step whenever the plugin updates the workflow file.
4. **Gitignore `.ordinator/` by default.** Append the line to the project's `.gitignore` if it is not already there, and say which file you edited. Ask first only if the user wants the config committed instead (the tradeoff: gitignored means each clone runs setup once and two clones can silently diverge; committed puts the project's directory layout and any rulebook path into git history, which is usually fine since none of it is a credential).
5. **Flip `configured:` to `yes` in `PROJECT.md`, last.** Nothing else marks the config as usable, so a setup that stops before this point leaves a config that correctly refuses to run.

### 4. Verify
Read the fenced block back and confirm every field is filled (no `<placeholder>` text remains) except any left open in step 2 and recorded under "Open, and bearing on a launch". Report which fields, if any, are still placeholders.

Then say what to do next in one line: `orchestrate` to resume or start a fleet, or `implement` if this session is itself a launched child reading its own handoff.

## Output contract
`<project>/.ordinator/PROJECT.md` and `REFERENCE.md` exist, `PROJECT.md` says `configured: yes` unless a field was deliberately left open, `<project>/.claude/workflows/ticket-pr.js` exists, and `.gitignore` carries `.ordinator/` unless the user chose otherwise.

## Surface
Read and Write under `<project>/.ordinator/`, `<project>/.claude/workflows/`, and `<project>/.gitignore`; Read under `${CLAUDE_PLUGIN_ROOT}/defaults/` and `${CLAUDE_PLUGIN_ROOT}/workflows/`.
