---
name: implement
description: First move of an implementation session launched by the orchestrator. Reads the handoff, verifies the worktree, announces itself, scopes the ticket with the user, runs the ticket-pr workflow with pause-and-resume, pushes and opens a draft PR, then idles until told MERGED. Owns one ticket from scope to merge and nothing else.
---

# implement

## Purpose
Take one ticket from handoff to merged pull request inside one worktree, asking the orchestrator for every ruling a stage cannot make, and leaving a record of every step in the session directory.

## Blocking requirements
- The opening prompt names a handoff file. Read it first; every path and name below comes from it (ticket, worktree, branch, base, session_dir, orchestrator, hub, reference, rulebookDir). If the file is missing or lacks one of these, stop with `BLOCKED: handoff missing <field>`.
- The handoff's `## Sources` section must list at least one entry. If it reads `- none named` or is otherwise empty, stop with `BLOCKED: handoff has no sources`.
- `git -C <worktree> rev-parse --abbrev-ref HEAD` must equal the branch and `git -C <worktree> merge-base --is-ancestor <base> HEAD` must succeed; otherwise stop with `BLOCKED: wrong worktree` and say why in the pane.
- `ListAgents` must show the orchestrator. If it does not, say so in the pane and wait for the user; never proceed unannounced.
- Work only inside the worktree and the session directory. Never touch the clone, other worktrees, or the ticket hubs.

## Raise to the calling session
Everything goes to the orchestrator as a message whose first line is the tag: `STARTED <KEY>`, `SCOPE <KEY>`, `QUESTION <KEY> <stage>`, `PLAN <KEY>`, `ENDED <KEY> PASS`, `ENDED <KEY> FAIL <stage>`, `MERGED <KEY>`. The user may answer any of them in this pane instead; treat that as the ruling, record it in session.md, and echo it to the orchestrator as `RULING <KEY> <stage> received in pane: <text>` so the decisions record carries it. Never open a chooser or prompt for a question already sent as SCOPE, QUESTION or PLAN; one channel per decision.
- `SOURCES <KEY>` from the orchestrator: append the given entries to `scope.md`'s `## Sources`, then re-read that section before the next workflow invocation so its `sources` arg picks them up.
- `HOLD <KEY>`: rulings are pending. Do nothing and do not poll; wait for the next message.
- `STOP <KEY>`: append one dated line to `session.md` recording the stop, then stop the session.
- `RESUME <KEY>` from the orchestrator, after a `--resume` relaunch brought this session back with no fresh prompt: read `session.md`'s timeline to see what step was last logged, then pick up from there; if it was inside step 3, run the resume procedure below and re-invoke the workflow; if it was idling after PASS, reply that the session is idle and waiting; if it was mid-Scope, continue Scope.

## Method

### 1. Announce and open the record
Send `STARTED <KEY>` with worktree, branch, base and session name. Create `<session_dir>/session.md` with a header (ticket, worktree, branch, base, started, transcript) and a `## Timeline` section; append one dated line per step from here on. The transcript is the newest `*.jsonl` under `~/.claude/projects/`, found by trying the worktree path with only `/` replaced by `-` first, then with `/ _ .` all replaced by `-`, using whichever of the two directories exists; if neither exists, write `transcript: not found` rather than guessing.

### 2. Scope (interactive)
Read only the ticket hub copy named in the handoff (`hub`) and the documents and folders listed in the handoff's `## Sources`; the hub's parent and sibling tickets are named in its frontmatter but their hubs are outside your boundary, so treat them as names only and raise a scope question if their content matters. Never explore beyond these; anything else found along the way becomes an open scope question, not a fact used silently. Write `<session_dir>/scope.md` with: Delivers; Leaves to neighbours; Size judgement (fits one PR, or proposed slices with files per slice); `## Sources` listing exactly the handoff's entries; Open scope questions. Send `SCOPE <KEY>` with the judgement and wait for the ruling. Record it under `## Ruling`. If the ruling changes the ticket tracker, wait until the orchestrator says the hub is updated.

### 3. Run the workflow (once per slice, in order)
Invoke Workflow `ticket-pr` with args `{ ticket, worktree, branch, sessionDir, scopePath, base, hub, sources, reference, rulebookDir, rulings: [], slice: 'single', startedAt: <now, ISO>, usage: <window_at_launch from the handoff, or the current window-check output> }`, where `hub`, `reference` and `rulebookDir` come straight from the handoff and `sources` is the array of `{path, tag, origin}` lifted from the handoff's `## Sources` (and from `scope.md`'s copy of it after any `SOURCES <KEY>` update). Stacked runs use `slice: 'slice n of m, based on <branch>'`, each on its own branch `<KEY>-n` created from the previous slice's branch, with `base` set to that branch.

Resume procedure, used by every bullet below that says "resume": read every `<session_dir>/checkpoints/*.json`, build a `checkpoints` object keyed by each file's stem (`plan`, `signatures`, `planreview-r<n>`, `plan-final`, `build`, `simplify`, `review-r<n>`, `pr`), and re-invoke `ticket-pr` with the original args plus `checkpoints`, so finished stages restore from disk instead of re-running their agent. Add `resumeFromRunId` from the previous result too when this is the same process that ran the earlier stages; drop it after a relaunch, since the in-process cache is gone. Before any re-invocation that could rewrite `plan.md` (a PlanGate resume, or a resume after a Plan-stage ruling), copy `plan.md` aside first.

- On `{ paused, questions }` for a stage other than PlanGate: send `QUESTION <KEY> <stage>` with the questions verbatim; wait for `RULING <KEY> <stage>`; append `{stage, text}` to `rulings`, where `stage` is the stage named in the `QUESTION` message; resume. Log both.
- On `{ paused: 'PlanGate', planPath }`: send `PLAN <KEY>` with `planPath`; wait for the reply.
  - `RULING <KEY> PlanGate approved`: resume with `planApproved: true` added to the args.
  - `RULING <KEY> PlanGate <text>`: append `{stage: 'Plan', text}` to `rulings`; resume without `planApproved`.
  Log both.
- On `{ failed, reason }` where the reason says the agent was unavailable (usage limit or API error): the session waits for the window on its own; when the pane is responsive again, resume. Log the pause and the resume. Do this at most twice before treating it as a FAIL.
- On any other `{ failed }`: send `ENDED <KEY> FAIL <stage>` with the findings, the recommendation from the result, and the transcript path; wait for the orchestrator's decision (a RULING to resume, or an instruction to stop); on a resume ruling, resume. Log it.
- On success continue to 4.

### 4. Tail
`git -C <worktree> push -u origin <branch>`, then `gh pr create --draft --title <title> --body-file <body file> --base <base> --head <branch>` from the worktree. Write the URL into `<session_dir>/pr.md` under `## URL`. Send `ENDED <KEY> PASS` with URL, commit count, review rounds, deferred question count, and the transcript path. Then idle: do nothing until a message arrives; never poll.
- `CORRECTION <KEY>`: dispatch `code-fixer` with the named change and the same rulebooks and finding protocol the workflow uses, then `code-reviewer`; if it passes, push and reply on the PR via gh with what changed. A correction that would change a planned signature is not applied; reply that it needs a new flow.
- `MERGED <KEY>`: finish `session.md` (end state, PR, date), send `MERGED <KEY>`, and stop.

## Output contract
The session directory ends with `session.md` (complete timeline), `scope.md` (with ruling), the workflow's stage files, and `pr.md` (with URL). Every message to the orchestrator is logged in the timeline with its reply.

## Surface
Read and Write under the worktree and the session directory; Bash for git, gh, `ordinator-window-check` and ls; Workflow, Agent, SendMessage, ListAgents. No Jira, Confluence, browser or cron tools (removed at launch).
