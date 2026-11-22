---
name: help
description: Diagnose where a user is stuck with Manifold, explain a confusing connection, or choose the next small step in an existing global space.
---

# Help with Manifold

Read [global spaces and establishment](../../references/establishment.md). Help is a
diagnostic conversation, not a command catalog or a requirement to initialize first.

## Starter prompt

> Manifold help. I am stuck here: [the problem or confusing claim].

## Method

1. Inspect the problem already supplied. If none is supplied, ask: “Where are you
   stuck, or what are you trying to work out?” A user need not know the right concept.
2. Use the explicitly selected space or supplied excerpt. If the space is ambiguous,
   ask which one; do not infer it from cwd. Use the global helper's read-only listing
   only if useful. No space is required for a conceptual question.
3. Diagnose the obstacle: missing account/source, unclear need or criterion,
   unexplained system contribution, trade-off, conflicting evidence, stale model,
   inaccessible reference or storage failure. Explain it through the user's case and
   cite the owning provision when applying Manifold. Keep conclusions within evidence.
4. Take the smallest useful authorized step. Route to [orient](../orient/SKILL.md),
   [needs](../needs/SKILL.md), [requirements](../requirements/SKILL.md),
   [arrangements](../arrangements/SKILL.md), [review](../review/SKILL.md),
   [results](../results/SKILL.md) or [change](../change/SKILL.md) as appropriate;
   load only what the problem calls for. Recommend a document batch or one interview
   question when that would resolve the gap. Do not require fresh establishment.
5. Return the diagnosis, a bounded answer or correction, what remains uncertain and
   one next step. Save only if the user authorized updating that global space; a
   request for help alone does not authorize editing its model or configuring a host.

## Stopping and uncertainty

Stop once the user can understand the blockage and choose the next step. No automatic
multi-stage work, source expansion, stakeholder contact or missing-context invention.
For unavailable global state, provide chat-only help and name the access issue; never
create local state as a workaround. If a reference needed for a formal judgment is
missing, follow [the shared method](../../references/guide.md) and keep that judgment
unresolved while answering supported parts.

See [the help and resume example](../../examples/establishment.md#help-and-resume).
