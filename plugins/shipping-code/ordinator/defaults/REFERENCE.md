# ticket-pr workflow reference (read by every stage agent)

**This file is the shipped default.** `/ordinator:setup` copies it to `<project>/.ordinator/REFERENCE.md`
and fills in the tooling state and any per-ticket rulings as the project accumulates them.
`ordinator-launch-impl` copies the filled copy into the worktree at `$WT/.claude/workflows/ticket-pr-reference.md`
at every launch, alongside the workflow file itself, so both are reachable inside the child's
four-path boundary. Install and repo specifics live here so the workflow prompts and stage agents
stay generic behaviour; update this file when the facts change, never encode them into
`workflows/ticket-pr.js` or an agent file.

`last_updated:`

## Workflow args

The workflow holds no project path; every path and fact it needs arrives as an arg, lifted by the
caller from the handoff, which `ordinator-launch-impl` composed from `<project>/.ordinator/PROJECT.md`.

| Arg | Required | Meaning |
|---|---|---|
| `ticket` | yes | ticket key |
| `worktree` | yes | absolute path to the worktree |
| `branch` | yes | branch name |
| `sessionDir` | yes | session directory for stage outputs |
| `scopePath` | yes | path to `scope.md` |
| `hub` | yes | ticket hub path, lifted from the handoff |
| `reference` | yes | path to this file (the project's filled copy), lifted from the handoff |
| `rulebookDir` | yes | rulebook directory relative to the worktree, lifted from the handoff (`PROJECT.md`'s `rulebook_dir`) |
| `sources` | yes, may be empty only when `smoke` is true | array of `{path, tag, origin}` lifted from the handoff's `## Sources` |
| `base` | no, default `main` | base ref |
| `rulings` | no, default `[]` | ruling text carried into a resumed invocation |
| `slice` | no, default `'single'` | slice label for stacked runs |
| `startedAt` | no | ISO timestamp for the usage ledger |
| `usage` | no | window usage snapshot for the usage ledger |
| `smoke` | no, default `false` | when true, return after the first budget check without dispatching any agent |

## Tooling state

Placeholder. State the worktree's actual tooling here after checking it, never assume: the lint
command, the test command (both also live as `lint_command`/`test_command` in `PROJECT.md`, so this
section may just point at them), which interpreter or runtime version is pinned and where, and
whether any project-wide bootstrap (a root Makefile, a CI workflow, a compose file, an env template)
exists yet. Do not build tooling pieces inside a ticket unless the ticket says so.

## Precedence when authorities conflict

- The signature plan is binding for the BUILDER: it implements the contract verbatim and never
  silently deviates, even when a rulebook argues otherwise.
- The REVIEWER reports a contradiction between the built code (or its signature plan) and a
  rulebook as a finding of kind `plan conflict` (see Finding protocol), never as an ordinary
  defect, and never auto-fixes it. The human adjudicates; the ruling lands in the ticket hub and,
  if general, as a dated rulebook amendment.
- Open adjudications are listed below; treat them as undecided, not as either side having won.

## Finding protocol (shared by code-reviewer, plan-reviewer, code-fixer and the workflow)

One finding is one line: `<file>:<line> | <rulebook> § <heading> | <kind> | <basis> | <change, one sentence>`.
Plan-level findings use `module` in place of a line.

- `kind` is `defect` or `plan conflict`. `defect`: the code or plan breaks a rule and can be fixed
  without changing a planned signature. `plan conflict`: the only fix would change a signature in
  the signature plan; no code fix is proposed, the fixer skips it, a human adjudicates. When a miss
  could be read either way, `plan conflict` wins.
- Plan fidelity misses are `defect`: a planned signature never implemented, an unplanned public
  symbol, a planned file missing, an acceptance criterion with no proving test (reported on the
  test file).
- `basis` is `rule` (a rulebook heading is cited) or `judgement` (no rule covers it); every
  `judgement` finding is also listed under RAISE.
- `pass` is true only when there are no findings of either kind.
- Plan-stage findings add an `addressee`: `plan-author`, `plan-signer`, or `user`.
- A `blocking: false` question may only cover detail internal to this ticket. Anything another
  ticket imports or speaks (import paths, distribution names, wire field names, enum values,
  dependency pins, interpreter version) is `blocking: true`, never defaulted.

### Open adjudications

Placeholder; none recorded yet. When a code-vs-rulebook contradiction is adjudicated, record it
here with a date and a pointer to the ticket that raised it.

## Per-ticket rulings

Rulings the user makes when a Plan stage surfaces decisions are recorded in that ticket's hub file
(the path named by `PROJECT.md`'s `hub_path_pattern`) under a `## Rulings` heading, and passed to
re-runs via the workflow's `args.rulings`. This file holds only rulings that generalize across
tickets.

- Rulings arrive as `args.rulings` (array of strings) on each (re)invocation; the session appends
  the user's ruling text verbatim and resumes with `resumeFromRunId` so completed stages replay
  from cache.

Placeholder; none recorded yet. When a ruling generalizes beyond the ticket that raised it (a
shared error hierarchy root, a shared module layout convention), record it here with the date and
the ticket that raised it, and mirror the error-hierarchy fact into `PROJECT.md`'s own table.

## Environment discipline (applies to every stage)

- Never use bare `cd`; absolute paths or `(cd /abs/path && cmd)` subshells.
- No em dashes anywhere, including code, commits, and PR bodies.
- Conventional commits; NO Co-Authored-By trailers. Stage agents never push and never call gh. The
  implementation session pushes the branch and opens a DRAFT PR after the workflow returns; the
  user moves it to ready and merges; the session idles until told MERGED.
- Work only inside the worktree passed to you; the project's main clone stays untouched on its
  default branch.
