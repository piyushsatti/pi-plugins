# PROJECT.md: bound facts for this install

**This file is the shipped default, and it is all placeholders.** `/ordinator:setup` copies it to
`<project>/.ordinator/PROJECT.md` and fills it in. Nothing here is discovered through an MCP; every field is typed in by whoever runs setup, from
what the project already decided.

**The copy is local by default.** Setup gitignores `.ordinator/` unless told otherwise, because this
file names the project's own directories, commands and error-hierarchy root. `ordinator-launch-impl`,
`ordinator-smoke-impl` and the `orchestrate` skill all read this file at run time from `<project>/.ordinator/`
before doing anything else; none of them holds a project path of their own.

`configured: no`

**While `configured` is `no`, `orchestrate` and `implement` refuse and point at `/ordinator:setup`.**
Setup flips it to `yes` as its last action, so a half-finished setup is never mistaken for a working
one.

`last_updated:`

---

## Bound facts

Parsed by `ordinator-launch-impl` and `ordinator-smoke-impl` from the fenced block below and
nothing else in this file. One `key: value` pair per line, `#` starts a comment, a blank line is
ignored. `<KEY>` inside `hub_path_pattern` is replaced with the ticket key at run time.

```ordinator-project
session_prefix: <prefix, e.g. hop>
fleet_dir: <path relative to project root, e.g. artifacts/orchestration/<fleet-name>>
worktree_root: <path relative to project root, e.g. worktrees>
clone_dir: <the git clone directory name under project root, or . if the project root is the clone>
hub_path_pattern: <path relative to project root with <KEY> as the ticket-key placeholder, e.g. notes/jira/<KEY>.md>
decisions_dir: <path relative to project root, e.g. notes/decisions>
confluence_dir: <path relative to project root, e.g. notes/confluence>
rulebook_dir: <path relative to the worktree root, e.g. docs/standards>
lint_command: <the command the tooling reference tells code-implementor and code-simplifier to run for lint>
test_command: <the command the tooling reference tells code-implementor to run for tests>
max_concurrent_children: 2
window_cutoff: 90
```

## Error hierarchy root

The domain exception root class and the file it lives in, read by the `implement` skill when it
composes `rulingsText` for a ticket that touches error handling. Placeholder until the project has
ruled on one.

| | |
|---|---|
| Root exception class | `<ClassName>`, or none yet |
| Defined at | `<path relative to the worktree root>`, or none yet |

## Open, and bearing on a launch

Anything known to be unresolved that should block or annotate a launch goes here, so it is read
rather than rediscovered. Empty is the normal state.
