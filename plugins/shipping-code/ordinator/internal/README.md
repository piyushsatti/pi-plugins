# ordinator internals: pm and tm

These two folders are the Plan Manager (`pm`) and the Task Manager (`tm`). They came unchanged from `packages/claude-mods/pm/` and `packages/claude-mods/tm/`, every tracked file and nothing else, and this is now their only source. The gitignored type stubs that the mod engine generates under `.claude-plugin/types/` were left behind.

## Why they're here

Ordinator owns them as internals. They exist for the orchestrator, not for everyday use, so they don't ship as Claude mods of their own.

- **pm** takes an approved plan, writes a brief of the conversation, and hands both to an implementer subagent. The main conversation keeps its context. Steps show in the footer, and a verifier checks the result.
- **tm** keeps a task list per project that survives restarts, compaction and new sessions. It has a ready queue, a done check the model can't edit, a next-step note, a decision log and a needs-you queue, drawn in the band above the prompt.

## Not wired up

Nothing here is loaded:

- None of ordinator's manifests (`.claude-plugin/`, `.codex-plugin/` and `.cursor-plugin/`) names these folders.
- Claude Code discovers `commands/`, `agents/` and `hooks/` only at a plugin's root, so `internal/*/commands/` and `internal/*/hooks/hooks.json` are never read.
- Each folder still has its own `.claude-plugin/plugin.json`. The mod engine needs it, and no harness looks for manifests below a plugin's root.

## They still need the Claude mod engine

Both are TSX hooks modules for Claude Code's mod engine, not plain hooks:

- `hooks/hooks.json` is `{"modules": ["./pm.tsx"]}`, not a hook-event config.
- The modules import from `claude-code`, the engine's runtime: `atom`, `read`, `update` and the `$` engine interface. They register through `on(...)`.
- The tests import `claude-code/testing`, which comes with the engine's generated types. The tests haven't been run from here.

## What porting them would take

A port to plain, cross-harness hooks would mean rebuilding everything the engine provides:

1. **Events.** `session.start`, `session.compact`, `turn.complete`, `tool.call` (pm on `ExitPlanMode`; tm on `TaskCreate` and `TaskUpdate`), `agent.offer` and `ui.render` map only partly onto each harness's hook events: SessionStart, PreCompact, Stop, PreToolUse/PostToolUse and SubagentStop. `ui.render` has no hook equivalent.
2. **UI.** pm's footer label (`pm ▸ <slug> 2/7`) and tm's band rows are drawn by the engine. The nearest plain equivalent is a status-line segment, and Codex and Cursor have nothing like it.
3. **Commands.** `/pm:*` and `/tm:*` are answered in code through `command.run`. The `.md` files only say that the module didn't load. A port needs a UserPromptSubmit-style hook that intercepts the prompt, or real command bodies.
4. **Tools.** pm registers `mcp__pm__step` and tm registers `mcp__tm__task` through `$.tool.register`. These would become a small MCP server under `bin/`, installed to `~/.local/bin/`, with byte-identical `.mcp.json` and `mcp.json` files.
5. **Agents and models.** pm registers `pm:implementer` and `pm:verifier` at run time, and forks the model through `$.model.fork` to write its brief from the prompt cache. Plain hooks can't fork a model. The agents would become files under `agents/`, and the brief a separate model call.
6. **State.** Both use `$.store` and write under Claude's config folder (`~/.claude` by default). For example, tm writes `<config>/projects/<key>/mods/tm/tasks.jsonl` and `<config>/mods/tm/tasks.jsonl`, and pm keeps plan copies in the project's `mods/pm/plans`. The plugin rule puts data in `~/.local/state/ordinator/`, so a port needs a migration for existing task lists.
7. **Tests.** The engine-mocked tests would be rewritten against fixture stdin for each harness (V2).

## Slash commands after a port

If they're ever wired into this plugin, Claude Code namespaces commands by plugin. `/pm:on` and `/tm:add` would then read as `/ordinator:...`, for example `/ordinator:pm-on` and `/ordinator:tm-add`, and the exact names would be settled then. They aren't wired yet, so today neither the old `/pm:*` and `/tm:*` names nor any `/ordinator:*` form comes from this copy. The installed mods under their own names are unaffected, and retiring them is a separate step that needs a go-ahead.
