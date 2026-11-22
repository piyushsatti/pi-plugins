---
name: results
description: Apply Manifold fulfillment semantics to supplied evidence, keeping criterion result, extent, conditions, evidence limits and acceptance separate.
---

# Interpret supplied results

Use this capability independently. First read the [shared application method](../../references/guide.md)
and [reference route and standing](../../references/index.md). Resolve links relative to this
SKILL.md, not the user's working directory. Use existing context before asking questions.
This capability supplies application assistance; it does not adopt requirements or implement
users' modeled systems.

## Starter prompt

> Interpret these supplied results against the identified requirements. Retain met/unmet/unknown, achieved extent, required versus examined conditions, evidence limits and separate acceptance. Check requirements-to-needs adequacy.

## Required context and references

Supplied results/evidence and any identifiable subject, requirement revision, criterion and context. Read the complete [fulfillment contract](../../references/source/standard/assessment/requirement-and-need-fulfillment.md), [adequacy cases](../../references/source/standard/ontology/concepts/requirement.md#from-requirement-fulfillment-to-need-fulfillment), [notation](../../references/source/standard/foundations/mathematical-notation.md), and [history/evidence meanings](../../references/source/standard/ontology/concepts/occurrences-and-state.md).

## Method

1. Recover subject/configuration, requirement/revision, criterion, required applicability, examined scope, evidence, assessment provenance and any separate acceptance decision. Linked context can supply these; missing context must stay visible.
2. Separate source reports, observations as acts, recorded results and evidence used for a particular claim. Treat stipulated examples as hypothetical. Preserve conflicting accounts; two copies of a record are not automatically independent observations.
3. For each applicable criterion, conclude met, unmet or unknown with reasoning. Unclear meaning/applicability or insufficient evidence produces unknown unless a separately established failure is decisive. Not assessed is absence of assessment; reporting an unknown evidence gap is an assessment.
4. Report extent in named dimensions using supported counts, quantities or qualitative distinctions. “Partial” is not a fourth criterion result; unknown cases can leave extent uncertain. Do not average unrelated dimensions or invent percentages.
5. Keep unexamined required conditions visible. Narrow examined success does not silently narrow the requirement. For a known fixed set of equally counted cases, same criterion/revision/window and no duplicates, apply S+F+U=N: at least K is met if S>=K, unmet if S+U<K, otherwise unknown. Unknown population, weighting, an empty window or future reliability requires its own basis, not automatic reuse of this rule.
6. Judge need fulfillment separately using adequacy and actual outcome evidence. Record acceptance with its object, authority and scope if relevant. A waiver or acceptance does not turn a known failed criterion into a pass. Before an open deadline, give progress/provisional results unless already decisive.

## Outputs

Return a scoped assessment for each claim using the [assessment template](../../templates/assessment.md), explaining achievement, uncertainties and separate need conclusions. Reuse the model's map, labeling any newly evidence-supported contribution without asserting total fulfillment. Default to [reviewer](../../references/roles/reviewer.md).

## Uncertainty and stopping

Stop at what the supplied evidence supports. Name missing criterion, applicability or evidence and the conclusion it prevents. Do not conduct external operational verification or certify effectiveness. Preserve prior judgments if evidence changes.

If a required reference is unavailable, follow the shared method's missing-reference
behavior: identify the affected claim and continue only the supported parts. Never invent
the rule or silently claim the unavailable revision was used.

## Worked example

See [interpret supplied results in the fictional reading-circle case](../../examples/worked-case.md#results).
[Contrasting results](../../examples/contrasting-results.md) show a more consequential
handoff and the accepted positive, negative and ambiguous adequacy distinctions.
