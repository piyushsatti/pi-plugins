# Contrasting supplied-result examples

These are authored illustrations, not execution receipts. The standard's
[report cases](../references/source/standard/ontology/concepts/requirement.md#from-requirement-fulfillment-to-need-fulfillment)
and [fulfillment contract](../references/source/standard/assessment/requirement-and-need-fulfillment.md)
own the meanings. Every outcome below is stipulated within a hypothetical case.

## Three adequacy judgments

| Input basis | Requirement result | Separate need judgment and reason |
| --- | --- | --- |
| Need: read the complete report before a meeting. Recipient confirms reading only and sufficient time. Requirements: intact, timely, readable delivery. All hold and recipient reads it before the meeting. | All stated requirements met for this report. | Met for this meeting: requirements cover the specified work and the stipulated outcome supports actual review. No future-success claim. |
| Need: review before meeting. Only intact and timely delivery specified. Both hold, but incompatible format prevents review. | Both specified requirements met. | Unmet; adequacy failed through omitted usability. Do not invent a failed requirement that was never specified. |
| Intact and timely readable PDF; “usable for review” is required, but editing/recalculation versus reading is unclear. No actual review outcome supplied. | Integrity and timing met; usability unknown. | Unknown. Raise the exact work ambiguity. Neither PDF format nor silence supplies a resolution. The environment chooses the handler. |

## More consequential arrangement

A fictional dispatch team must make four time-sensitive packages available to
recipients by Friday 17:00 UTC. The locally stipulated requirement D1-A covers all
four, including disruptions; dispatching a file is a separate requirement D2-A.
The relevant participants are `human.dispatch.operator`,
`human.dispatch.recipient` (four instances bound separately), and
`program.dispatch.carrier.interface` (a declared consumer, working program label).
The carrier is outside the internal preparation boundary but within the combined
outcome assessment. Declaring a boundary does not waive D1.

Structure: a manifest relates each package to a recipient and carrier instruction;
individual outcome records relate back to those identities. Process: prepare,
authorize under local assignments, submit, reconcile individual availability,
respond to exceptions, close only with a known disposition. Actual exception and
acceptance authority are unknown in this variant; the assistant cannot appoint one.
A tool list containing “manifest app, uploader” would leave this explanation absent.

```text
S1 combined dispatch --intended contribution--> D1 --represents timing/access--> N1 recipients can use the packages in time
S2 preparation/submission --intended contribution--> D2 --represents an enabling aspect--> N1
S1 --depends on--> external carrier
```

D2 alone is not an adequate representation of N1. E1 stipulates a matching accepted
instruction file; A and B are correctly available on time, C is established late,
D is unknown. Interpret D2 as met for this cycle, D1 as unmet because C defeats
all-four, and report two successes, one failure and one unknown. The exact total
extent remains uncertain, bounded by two to three successful cases; do not treat D
as failed. Submission acceptance concerns its file, not the recipients' outcome.
A sample or one cycle cannot prove reliability.

On Monday C recovers. D1-A remains unmet at Friday's deadline. If new E2 instead
proves D was available Friday, revise D's historical unknown to met, preserving E1's
basis and the revision reason. D1-A still remains unmet due to C. A new Saturday
criterion creates a separate basis, not retroactive success.

For a personal learning contrast, three explanations are required with offline
support. Two pass and one fails, with only connected operation examined. The all-three
criterion is unmet, achieved explanation count is two of three, and required offline
operation remains unexamined/unknown. A complete 95-minute record can meet a separate
120-minute limit without establishing useful later understanding. See the
[original learning exercise](../references/source/examples/personal-learning-review.md).

## Bounded counting and its limits

A fixed set of ten equally counted cases, same criterion/revision/window, no duplicates:
S=8, F=1, U=1. All ten is unmet; at least eight is met; at least nine is unknown.
These conclusions use different criteria on the same evidence. Extent remains eight
known successes, one failure and one unknown. None is a future reliability estimate.
An unspecified population or weighted preference comparison does not satisfy this
rule's premises. An empty window is not evidence that execution succeeded.

## Unavailable reference and resumption

If the fulfillment contract is unavailable and no available owning provision supplies
the needed rule, a useful response is: “I can retain E1's two known successes, C's
late result and D's unknown outcome. I cannot claim an interpretation against the
identified Manifold contract until that reference is available.” Return that evidence
account and the exact missing path; continue unaffected modeling. A source-locator
entry is not a replacement for the text. The next agent receives the evidence account,
reference-manifest identity, missing provision, task and scope in a
[handoff](../templates/handoff.md), verifies availability, then resumes the affected
judgment using the actual reference. These are behavior examples, not performed tests.
