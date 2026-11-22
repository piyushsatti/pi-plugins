---
name: requirements
description: Use Manifold to form requirements from needs, visions or interface constraints and test requirements-to-needs adequacy.
---

# Form requirements

Use this capability independently. First read the [shared application method](../../references/guide.md)
and [reference route and standing](../../references/index.md). Resolve links relative to this
SKILL.md, not the user's working directory. Use existing context before asking questions.
This capability supplies application assistance; it does not adopt requirements or implement
users' modeled systems.

## Starter prompt

> Propose requirements from these needs and other justified sources. Explain origins, subjects, conditions and criteria, then challenge whether meeting the required combination would adequately address the needs.

## Required context and references

Existing needs, requirements, vision, constraint or consumer contract plus context. Read [requirement including origins, adequacy and cases](../../references/source/standard/ontology/concepts/requirement.md), [fulfillment](../../references/source/standard/assessment/requirement-and-need-fulfillment.md), [relationships](../../references/source/standard/ontology/relationships.md) and [trade-offs](../../references/source/standard/assessment/competing-needs-and-tradeoffs.md).

## Method

1. Recover existing statements and revisions before proposing changes. Separate origin, subject, beneficiary, allocation and deciding authority. A vision or chosen interface can be a legitimate conditional origin without a fabricated need.
2. For each candidate, state the subject, desired condition, reason, applicability and criterion. Numeric limits need units; proportions need denominators; qualitative criteria need a basis and any known judging role. Missing values remain explicit questions, not agent-selected defaults.
3. Keep proposed and locally adopted requirements distinct. A prediction of performance is not selection of a criterion, and allocation does not make a high-level requirement cease being high-level relative to its whole.
4. Explain each represented aspect of each need. Challenge sufficiency: could all specified requirements be met while the need remains unmet? Identify missing compatibility, timing, context, costs or outcome evidence. Explain the required combination in this environment without imposing a universal combination rule.
5. For consumer-derived requirements, distinguish the independent purpose, chosen consumer contract/version and producer condition. Mark the condition dependent on that consumer choice. Check circular justification separately from an operational dependency cycle.
6. Expose conflicting mandatory limits and negotiable preferences. Propose alternatives with consequences, leaving adoption and trade-offs to the known authority or explicit vacancy.

## Outputs

Return candidate requirement records, origin and rationale, applicable conditions, criteria and unknowns, many-to-many representation links, an adequacy argument with counterexamples, a matching map and next local choices. Use the [model template](../../templates/model.md); default to [modeler](../../references/roles/modeler.md).

## Uncertainty and stopping

Stop with a reviewable candidate set for the requested scope. When “usable”, “fast” or another consequential criterion is unclear, ask what distinction changes the result and leave dependent judgments unknown. Do not invent thresholds, retroactively fail an omitted requirement, or declare need fulfillment from trace links.

If a required reference is unavailable, follow the shared method's missing-reference
behavior: identify the affected claim and continue only the supported parts. Never invent
the rule or silently claim the unavailable revision was used.

## Worked example

See [form requirements in the fictional reading-circle case](../../examples/worked-case.md#requirements).
[Contrasting results](../../examples/contrasting-results.md) show a more consequential
handoff and the accepted positive, negative and ambiguous adequacy distinctions.
