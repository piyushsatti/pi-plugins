---
name: review
description: Review a Manifold model for unsupported connections, ambiguity, missing coverage and trade-offs with independently addressable findings.
---

# Review alignment and trade-offs

Use this capability independently. First read the [shared application method](../../references/guide.md)
and [reference route and standing](../../references/index.md). Resolve links relative to this
SKILL.md, not the user's working directory. Use existing context before asking questions.
This capability supplies application assistance; it does not adopt requirements or implement
users' modeled systems.

## Starter prompt

> Challenge this model against applicable Manifold provisions and local context. Identify unsupported connections, ambiguity, omitted needs and trade-offs. For every finding, name the affected claim, consequence and clarification or choice needed.

## Required context and references

A model, draft, diagram, requirements or arrangement and the intended review decision. No intake restart is needed. Read the [review prompts](../../references/source/standard/application/design-review-criteria.md), [adequacy](../../references/source/standard/ontology/concepts/requirement.md#from-requirement-fulfillment-to-need-fulfillment), [trade-offs](../../references/source/standard/assessment/competing-needs-and-tradeoffs.md), [relationships](../../references/source/standard/ontology/relationships.md), and [reconciliation](../../references/source/notes/reconciliation.md).

## Method

1. State the reviewed artifact/revision, intended use, available sources and reference basis. Check relevant provision standing before presenting a draft convention as a mandatory rule.
2. Trace sources to interpretations, requirements to needs, arrangements to requirements, and assessments to evidence. Test adequacy with concrete counterexamples. Find omitted perspectives and unjustified all-to-all mappings.
3. Compare prose, tables and diagrams for matching endpoints, relation meanings, conditions and revisions. Check structure and behavior together; distinguish parthood, dependency and contribution.
4. Examine conflicts, mandatory limits, preferences, costs and residual shortfalls. Test whether an alternative could serve both needs. Do not invent weights or waive a mandatory condition through an overall score.
5. Give each finding a stable local handle, exact affected claim/edge, source basis, consequence and smallest clarification or decision. Include a recipient only if known, otherwise mark it unassigned. Distinguish established defect, unsupported claim, unresolved meaning and local choice.
6. Retain supported strengths and non-findings so the scope is clear. Update a corrected map only as a proposal, preserving the reviewed version. If independent review is requested and authorized, use a supported host contributor with a bounded handoff; otherwise label this self-review.

## Outputs

Return an addressable review with finding locations, reasons, consequences, options and disposition/authority gaps, supported connections, a map consistency result and a bounded next action. Use [review template](../../templates/review.md) and [reviewer role](../../references/roles/reviewer.md).

## Uncertainty and stopping

Stop after covering the requested claims and material gaps. A clean review is bounded evidence about meaning and consistency, not acceptance of the case or proof the external system operates effectively. Do not reopen reconciled historical findings merely because an old page calls them open.

If a required reference is unavailable, follow the shared method's missing-reference
behavior: identify the affected claim and continue only the supported parts. Never invent
the rule or silently claim the unavailable revision was used.

## Worked example

See [review alignment and trade-offs in the fictional reading-circle case](../../examples/worked-case.md#review).
[Contrasting results](../../examples/contrasting-results.md) show a more consequential
handoff and the accepted positive, negative and ambiguous adequacy distinctions.
