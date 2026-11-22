---
name: orchestrate
description: Orchestrator-side procedure for a fleet of implementation sessions. Use in the orchestrator session to resume fleet state from disk, launch a child session for a ticket with headroom and concurrency guards, relay a child's question to the user with the documents that bear on it, record rulings, collect usage on ENDED, and close out on MERGED. Never implements code.
---

# orchestrate

## Purpose
Run one ticket fleet from the orchestrator session: children do the building, the user makes rulings, this session keeps the records straight and never lets a fact live only in chat.

## Blocking requirements
`<project>/.ordinator/PROJECT.md` must exist and say `configured: yes`; otherwise stop with `BLOCKED: ordinator not configured, run /ordinator:setup`. Every verb needs the fleet directory. Take it from the invocation argument, else from the memory entry that names it; if neither exists, stop with `BLOCKED: no fleet directory named`. The fleet directory must hold `orchestrator.md` and `fleet.md`; if either is missing, stop with `BLOCKED: missing <path>` (seeding is a separate step, not this skill's job). Operating numbers (`max_concurrent_children`, `window_cutoff`) are read from the Behaviour section of `orchestrator.md` at run time, never assumed; if one is absent, say so and use the launch script's default (which itself falls back to `PROJECT.md`'s values).

## Raise to the calling session
- `RAISE: window hold until <resume_at>` when the window check returns hold; schedule the wakeup, do not launch.
- `RAISE: window unknown` when the check returns unknown, with its gaps verbatim; the user decides whether to launch blind.
- `RAISE: unit of work over limit: <session> peak <n>` when a usage report flags a transcript over the context limit; file it in Pending as a redesign item, never fix it in the child.
- `RAISE: fleet mismatch` when live sessions and fleet rows disagree.

## Method

### resume (always first: at session start and after every compaction)
1. Read `orchestrator.md` (Behaviour, Pending, Log), then `fleet.md`.
2. Run `ListAgents`; compare live `<prefix>.impl--*` sessions (`<prefix>` is `PROJECT.md`'s `session_prefix`) with fleet rows marked live. Fleet rows carry a last-event state that runs `launching` -> `launched` -> `started` -> ... -> `stopped` or `merged`; a row still at `launching` or `launched` with no matching live session is a launch that never completed and is a mismatch to raise, not to ignore. (tmux names the same sessions `<prefix>_impl--*`: it rewrites dots to underscores.) The row's last column, `claude id`, holds the claude session id used by `--resume`; the launcher records it on first launch and updates it on every resume.
3. Run `ordinator-window-check --cutoff <window_cutoff>`; report status, both windows, and any gaps.
4. Say in one paragraph what is live, what is pending, what the user owes, and the window state.

### smoke
Run `ordinator-smoke-impl <fleet-dir> <this session name> <base ref>`. Relay the worktree path and attach line it prints. Wait for the `SMOKE <KEY>` message (no polling); relay each check's PASS/FAIL to the user. The worktree and tmux session are left running; archive and kill them only on the user's word, with the two commands the script printed.

### launch <KEY>
1. Confirm with the user: ticket key and base ref (never default the base). The ticket hub, at the hub location named in `orchestrator.md` Behaviour, must exist for `<KEY>`.
2. Create the worktree with the worktree plugin script (`ls -d ~/.claude/plugins/cache/*/worktree/*/scripts/worktree.sh`, take the newest marketplace) run from inside the clone in a subshell: `(cd <root>/<clone_dir> && bash <script> add <KEY>-<slug> --base <ref>)`.
3. The child's standing sources are fixed by the launcher from `PROJECT.md`'s `decisions_dir` and `confluence_dir`: the hub (copied into the session directory) and those live read-only folders. A sources manifest is optional, one line per entry `<path>[:<from>-<to>] | settled`, only for a path or line range the user names beyond those; show it and the base ref to the user for confirmation, then write it to `<fleet-dir>/<prefix>.impl--<KEY>/sources.manifest`.
4. Run `ordinator-launch-impl <fleet-dir> <this session name> <KEY> <worktree> <branch> <base> [--sources <manifest path>]`. It refuses (exit 3) at the child cap or without window headroom; relay its HOLD line and do not add `--force` unless the user says so. It exits 5 when the pane never shows the skill loading; relay the pane tail it printed and do not silently retry.
5. Paste the attach line to the user. Append a Log line.
6. On `STARTED <KEY>` set the fleet row's last event to `started`.

### relaunch <KEY> (child died: process exit, host reboot, or a killed tmux session)
1. Confirm with the user the ticket key; the claude session id is optional, the launcher reads it from the fleet row when it is not given.
2. Run `ordinator-launch-impl <fleet-dir> <this session name> <KEY> <worktree> <branch> <base> --resume [<claude-session-id>]`. It refuses if the tmux session already exists, or if the session's `handoff.md` or `settings.json` are missing (that ticket was never launched; run `launch` instead). It exits 5 when the resumed pane dies during the liveness poll; relay the pane tail it printed and do not silently retry.
3. Paste the attach line to the user. Send `RESUME <KEY>` to the child so it picks up from where its `session.md` timeline stopped. Append a Log line; the fleet row's last-event column becomes `resumed <HH:MM>`.

### sources <KEY>
When a source is added, withdrawn or corrected after launch: copy the document (whole file, or the named line range under a header naming its origin) into `<fleet-dir>/<prefix>.impl--<KEY>/sources/` or remove it from there, update `handoff.md`'s `## Sources` line, send `SOURCES <KEY>` to the child with the change verbatim, and log it. A ruling written into the live decisions folder needs no SOURCES message; the child reads that folder directly.

### hold <KEY>
When the user wants a child paused without ending it: send `HOLD <KEY>`, set the fleet row's last event to `held`, and take no further action until the user rules.

### stop <KEY>
When the user wants a child ended without a merge: send `STOP <KEY>`, set the fleet row's last event to `stopped`, and log it.

### correction <KEY>
When the user asks for a change on a PR the child already opened: send `CORRECTION <KEY>` to the child with the exact change, and log it. The child's handling of `CORRECTION <KEY>` is described in `implement`.

### on hold
When a launch or a resume is refused for window headroom, call `ScheduleWakeup` for `resume_at` from the check output (clamped by the runtime; chain wakeups if it is further away), log the hold, and on wake run the check again before doing anything else.

### on SCOPE or QUESTION <KEY> <stage>
0. On SCOPE only, before any relay: list every concrete decision the scope will fix that later tickets inherit, and every one the ticket absorbs from unowned foundational work (package and distribution names, import roots, directory layout, build backend, dependency and interpreter pins, wire message types with their field sets and enum values, error roots). For each, name the source that settles it and check that source actually covers it (a page cited for seven message types that lists fields for three does not). Ask the user, one at a time, every item no source settles, in the same interview as the scope rulings, so the plan-author starts with them closed. Write the checklist and its outcomes into `scope-rulings.interview.md`.
1. Dispatch an Explore agent (model sonnet): find what the decisions doc, the project's own notes, the clarifications file and the wiki say about the question; return passages with paths, at most one page. Never answer from memory. Write the passages to `<session_dir>/questions/<stage>-found.md` before presenting them, so a compaction between finding and ruling loses nothing.
2. If the passages found do not settle the question and it is one an external authority settles (a language or packaging convention, a library's own documentation, a standard), look it up before going further (WebSearch, WebFetch, context7), write the sourced answer into the same found file with its URLs, and treat it as a found passage. Then apply the clear-vs-ambiguous threshold. Clear means all three hold: the answer interprets a ruling already recorded in the sources found and follows from its wording; a wrong answer is reversible inside the PR under way and touches no name, wire field, package boundary or anything a decisions record would carry; the point is not listed open in the clarifications file or an interview record and has not been reversed by the user before. If clear, rule it, record it under a "ruled by orchestrator" heading in `<session_dir>/scope-rulings.interview.md`, send `RULING <KEY> <stage>`, and report the ruling in the next message to the user so it can be reversed. If any test fails, present the question with: the sources checked (paths and URLs), the orchestrator's proposal, what a wrong answer costs, and one line saying why it cannot be ruled here; if that line cannot be written, the question is ruled, not relayed. Then the question verbatim, the child's options, and whether the sources agree, one question at a time. A question is never escalated only because of the class it belongs to (a name, a wire field, a package boundary); it is escalated because no source settles it or the user has reversed the point before.
3. On the user's ruling: write `<decisions_dir>/<YYYY-MM-DD>-<slug>.md` with sections Question, Docs surfaced, Ruling (verbatim), Raised by (`<KEY>`, stage), Doc corrections (or `none`). Send `RULING <KEY> <stage>` with the ruling text (for scope, the `SCOPE <KEY>` ruling). Log it; strike the Pending item with the date if one existed.

### on PLAN <KEY>
Open the `plan.md` path the message names. Put the `## Decisions the plan took for you` section in front of the user first, then the rest of the plan on request. On approval, send `RULING <KEY> PlanGate approved`. On a ruling that names a decision to change, send `RULING <KEY> PlanGate <text>` with the ruling verbatim; the child appends it as a `{stage: 'Plan', text}` ruling and resumes without `planApproved`, which costs a further plan-review round from the checkpointed plan, not a cold run. Write `<decisions_dir>/<YYYY-MM-DD>-<slug>.md` as for any other ruling (Question, Docs surfaced: none, this is a direct read of the rendered plan, Ruling verbatim, Raised by `<KEY>`, stage `Plan`, Doc corrections or `none`). Log it.

### on ENDED <KEY> PASS | FAIL <stage>
1. Update the fleet row (last event, PR URL).
2. Run `ordinator-session-usage <worktree>` and append its output to `<fleet-dir>/<prefix>.impl--<KEY>/usage.md` under a dated heading. Read only the summary table, the failure reasons, the flag column and the gaps line; do not paste the tables into chat.
3. Relay to the user in four lines: outcome, PR URL or failing stage, deferred question count, usage headline (turns, output tokens, peak context, compactions, over-limit flag). Any over-limit flag or repeated tool failure becomes a Pending redesign item.
4. On FAIL present the child's recommendation and wait for the user's decision (resume with a ruling, or a new flow); relay it as `RULING` or by launching again.

### on MERGED (the user says the PR merged)
Send `MERGED <KEY>` to the child. On its `MERGED <KEY>` reply set the fleet row to merged / reap-eligible and tell the user the worktree can be reaped on their word.

### record
Any operating rule the user states goes into `orchestrator.md` Behaviour as a dated line the moment it is said, including changes to `max_concurrent_children` and `window_cutoff`.

## Output contract
Each verb ends with one short paragraph to the user and the matching record change on disk; nothing is reported as done before the record is written.

## Surface
Bash for tmux, the worktree script, `ordinator-launch-impl`, `ordinator-smoke-impl`, the other `ordinator-*` commands named above and gh read commands; Read and Write under the fleet directory and the project's decisions directory; SendMessage, ListAgents, Agent, ScheduleWakeup. No edits inside the repo, no Workflow, no git writes, no Jira or Confluence writes.
