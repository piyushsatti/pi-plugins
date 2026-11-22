# Bounded contributor roles

These are portable role instructions consumed by the Manifold skills, not native agent
registrations. Codex, Claude Code and Pi can apply a role in the current assistant
session by reading its file. This package declares no native agents and installs no
orchestrator. A host's optional delegation facility can receive the same role and
[handoff](../../templates/handoff.md) when delegation is authorized. Availability and
independence must be checked at use time. One assistant can guide and model; label a
review by the same contributor as self-review.

| Role | Select when | Instruction |
| --- | --- | --- |
| Guide | Framing, explanation or a bounded clarification will improve the next decision. | [guide.md](guide.md) |
| Modeler | Sources need transformation into a model, arrangement or change proposal. | [modeler.md](modeler.md) |
| Reviewer | A claim, adequacy argument, supplied result or disputed connection needs challenge. | [reviewer.md](reviewer.md) |

Example invocation: “Use Manifold's reviewer role with the Review skill on model
revision B. Review only R2→N1 and S1→R2. Return findings with exact claim references;
do not change the model.” This grants a bounded review task, not decision authority.
