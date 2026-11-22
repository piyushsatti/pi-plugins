---
name: arrangements
description: Use Manifold to describe candidate or existing systems through parts, relationships, processes, interfaces and intended contribution.
---

# Describe arrangements

Use this capability independently. First read the [shared application method](../../references/guide.md)
and [reference route and standing](../../references/index.md). Resolve links relative to this
SKILL.md, not the user's working directory. Use existing context before asking questions.
This capability supplies application assistance; it does not adopt requirements or implement
users' modeled systems.

## Starter prompt

> Describe this existing or candidate arrangement against the requirements. Explain parts, relationships, structure and process, relevant states and interfaces, expected contribution and useful alternatives.

## Required context and references

Any existing system description, tool list, process, diagram or requirements; identify what is current versus proposed. Read [system](../../references/source/standard/ontology/concepts/system.md), [structure](../../references/source/standard/ontology/concepts/structure.md), [process](../../references/source/standard/ontology/concepts/process.md), [composition](../../references/source/standard/mereology/composition-and-boundaries.md), [execution](../../references/source/standard/execution/behavior-and-responsibility.md), and [notation](../../references/source/standard/foundations/mathematical-notation.md).

## Method

1. Name the whole, purpose, boundary, configuration and whether the description concerns existing practice or intended design. Separate those views if both appear.
2. Identify actual or proposed elements and interactions. Distinguish constituent membership, external dependency, interface and contribution. A system need not contain a fixed list of people, tools, information and processes.
3. Describe how work proceeds: trigger and prerequisites, participants and responsibility basis, activities/decisions, input/output handoffs, relevant states and transitions, exception responses, and stopping. Use only the detail material to the current decision. State unresolved handler or authority rather than assigning one by implication.
4. Show where a process participates without inferring that it is a system subtype, contained part or owned by a labeled participant. Keep state subjects and times clear.
5. Explain intended contribution to identified requirements under stated assumptions. A tool inventory or ordered checklist alone leaves interactions and responsibility unexplained. Component success does not establish combined success.
6. Compare useful alternatives, including manual, automated or mixed arrangements where justified. Describe different effects on constraints and needs; let the environment choose joint, alternative or other combinations.

## Outputs

Return a structural account, process/handoff account, contribution rationales and assumptions, requirements–needs map plus optional structure/process diagram, and alternatives with trade-offs. Use the [model template](../../templates/model.md); default to [modeler](../../references/roles/modeler.md).

## Uncertainty and stopping

Stop when a reader can explain how the bounded arrangement is intended to work and identify its unresolved connections. Do not implement it, infer operating capability from the design, or shrink an obligation by changing the diagram boundary.

If a required reference is unavailable, follow the shared method's missing-reference
behavior: identify the affected claim and continue only the supported parts. Never invent
the rule or silently claim the unavailable revision was used.

## Worked example

See [describe arrangements in the fictional reading-circle case](../../examples/worked-case.md#arrangements).
[Contrasting results](../../examples/contrasting-results.md) show a more consequential
handoff and the accepted positive, negative and ambiguous adequacy distinctions.
