---
name: needs
description: Use Manifold to extract or elicit attributed needs from accounts and documents while retaining disagreement and missing perspectives.
---

# Discover needs

Use this capability independently. First read the [shared application method](../../references/guide.md)
and [reference route and standing](../../references/index.md). Resolve links relative to this
SKILL.md, not the user's working directory. Use existing context before asking questions.
This capability supplies application assistance; it does not adopt requirements or implement
users' modeled systems.

## Starter prompt

> From these accounts and documents, identify whose desired conditions matter. Separate their statements from your interpretation, preserve disagreement, and identify missing perspectives without inventing testimony.

## Required context and references

Available accounts/documents and case context. If there is no source account, return an explicitly hypothetical candidate and one useful elicitation prompt. Read [need](../../references/source/standard/ontology/concepts/need.md), [actor language](../../references/source/standard/application/problem-context-and-actor-language.md), [roles](../../references/source/standard/ontology/concepts/actors-and-roles.md), and the [discovery baseline](../../references/source/standard/application/case-development-baseline.md#discovery-and-interview-loop).

## Method

1. Inventory source accounts with locators, reporter, beneficiary and applicable context. Preserve wording before interpretation; a representative's account does not prove a group's agreement.
2. Express each candidate as whose desired condition, in which situation, for which problem, opportunity or purpose. Retain requests for tools as solution proposals while identifying the desired condition, without inventing a measured shortfall.
3. Mark each interpretation as confirmed, unconfirmed or disputed using actual supplied feedback. Separate different accounts that sound similar but differ on timing, cost or consequences. Do not force merging for a tidy map.
4. Identify missing affected perspectives and what choice their input could change. Programmatic prerequisites come from a declared function and interface evidence, not simulated testimony.
5. Replay consequential interpretations and ask bounded questions when needed. Preserve silence and dissent. Use the stakeholders lens when interests conflict; suggest options that might serve both before assuming incompatibility.
6. Link only the requirements already present or explicitly proposed to the relevant needs. Explain why an edge is tentative or missing.

## Outputs

Return attributed candidate needs, original source locators, interpretation standing, disagreements, missing perspectives and a needs–requirements map. Use the [model template](../../templates/model.md). The [guide](../../references/roles/guide.md) can elicit; the [modeler](../../references/roles/modeler.md) can extract.

## Uncertainty and stopping

Stop when the available accounts are represented sufficiently for the stated next step. Flag affected choices that require more input; continue unrelated modeling. Do not turn an unconfirmed need into a participant decision.

If a required reference is unavailable, follow the shared method's missing-reference
behavior: identify the affected claim and continue only the supported parts. Never invent
the rule or silently claim the unavailable revision was used.

## Worked example

See [discover needs in the fictional reading-circle case](../../examples/worked-case.md#needs).
[Contrasting results](../../examples/contrasting-results.md) show a more consequential
handoff and the accepted positive, negative and ambiguous adequacy distinctions.
