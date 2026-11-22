---
name: orient
description: Apply Manifold to a situation or existing model; explain concepts through the case and identify a useful boundary and pending decision.
---

# Orient and frame

For first contact or establishment, use [init](../init/SKILL.md). This capability
frames a particular situation inside a global space or a provisional chat; it does
not create a repository-local Manifold.

Use this capability independently. First read the [shared application method](../../references/guide.md)
and [reference route and standing](../../references/index.md). Resolve links relative to this
SKILL.md, not the user's working directory. Use existing context before asking questions.
This capability supplies application assistance; it does not adopt requirements or implement
users' modeled systems.

## Starter prompt

> Help me apply Manifold to this situation or existing document. Explain the relevant concepts through it, identify my pending decision and a useful boundary, and ask only questions that materially change the next useful output.

## Required context and references

A situation, document, requirement, arrangement or result, and whatever purpose or decision is already stated. No prior interview or completed template is required. Read [purpose](../../references/source/standard/foundations/purpose-and-scope.md), [need](../../references/source/standard/ontology/concepts/need.md), [relationships](../../references/source/standard/ontology/relationships.md) and [actor language](../../references/source/standard/application/problem-context-and-actor-language.md).

## Method

1. Inspect supplied material. State the subject, what the user wants to decide, and the intended use of this model. If the decision is unstated, propose a narrow interpretation and label it provisional.
2. Explain need, requirement and system through the supplied case. Cite the relevant working definitions and identify scoped acceptance only where it exists. A tool request may embed a candidate solution; recover the outcome it is intended to support.
3. Propose a boundary with included elements and relevant external dependencies. Explain what a narrower or wider boundary would change; redrawing it does not waive requirements.
4. Declare affected participants, distinguish roles from actual assignments, and note whose account is missing. Capture constraints, consequences and material unknowns progressively.
5. Produce the smallest useful model view. If requirements or systems are absent, show the known need as an unlinked node and name the missing connection; do not fill it with invented commitments.
6. Choose a next useful capability and explain why. Ask a focused question only when it changes that next output.

## Outputs

Return a plain-language environment brief, purpose and pending decision, boundary, participant/source table, small labeled map, important unknowns and a next action. Use the [case template](../../templates/case.md) selectively. The default responsibility is [guide](../../references/roles/guide.md).

## Uncertainty and stopping

Stop once there is enough framing for the requested decision or next modeling step. The brief can be provisional. An absent account remains absent; do not claim stakeholder agreement or require every conceivable perspective before useful work.

If a required reference is unavailable, follow the shared method's missing-reference
behavior: identify the affected claim and continue only the supported parts. Never invent
the rule or silently claim the unavailable revision was used.

## Worked example

See [orient and frame in the fictional reading-circle case](../../examples/worked-case.md#orientation).
[Contrasting results](../../examples/contrasting-results.md) show a more consequential
handoff and the accepted positive, negative and ambiguous adequacy distinctions.
