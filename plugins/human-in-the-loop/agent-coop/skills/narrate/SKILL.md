---
name: narrate
description: Write two texts about a turn, a markdown note and a flattened spoken narration, and store them on that revision with agent_coop_note. Use when the user says "narrate", "narrate that", "tell me that turn", "read that back", "as voice", or otherwise asks to hear a turn instead of reading it.
---

# narrate

This skill turns one closed turn into two texts, one to read and one to hear,
and stores both on that revision with `agent_coop_note`. The user asks for it when
they would rather listen than read: "tell me that last turn as voice",
"narrate that", "read that back to me".

## You are already awake

The trigger is the chat message itself. There is no button, no wake channel,
and no new trigger machinery to build for it. Agent Coop's one wake channel exists
for the user's *submits* and is armed by the `/agent-coop` skill's waker
(`agent-coop-watch`, which runs `scripts/watch.ts`, under the Monitor tool); narrate has nothing to do with
it and needs nothing like it. Agent Coop's trigger has already been rebuilt three
times, see `/agent-coop`, rev 3. Do not make this a fourth: if you are reading this
skill, the user already woke you by typing, and that is the whole mechanism.

## Finding the turn

| Step | Tool | Why |
|---|---|---|
| 1 | `agent_coop_sessions` | Find the session, and its documents, the user means. |
| 2 | `agent_coop_revisions` | List that document's turns, newest first. "The last turn" is the first entry; an older one is further down the list. |
| 3 | `agent_coop_diff` | Only when the turn is not already fresh in context: read what actually changed, `to` the revision label from step 2. |

`agent_coop_note` then stores the result on that same revision: `doc_id`,
`revision_id` (the label from step 2, never a row id), `note`, `narration`.

## Two artifacts, not one

**`note`** is markdown, for the eye: an interpretation of the turn, not a
transcript of it and not a restatement of the diff. Conclusion first, and
scaled to the turn, three sentences is enough for a trivial one.

**`narration`** is the same content, flattened for an ear. A table becomes
sentences. A code fence becomes a description of what the code does, never
read out. A file:line reference becomes plain speech ("in the document view,
near the top"), never punctuation spelled aloud. A link is dropped rather
than read as a URL. Numbers stay numbers.

Everything else about how to translate is your judgment, per turn. There is
no lookup table of translation rules here, and none should be added.

## Two hard rules

1. **Never read code or punctuation aloud.** Describe what code does; never
   speak its syntax, and never speak a colon, a dash, or a bracket.
2. **Stay reliable across input size.** A long turn is summarised, never
   truncated mid-thought, and never grows into a twenty-minute narration.
   Target a two-minute listen regardless of how much the turn touched.

## The optional argument

Absent, narrate the whole turn. Present, it steers focus or style rather
than naming a different turn: "narrate the anchor part," "narrate that
assuming I have never read this code." Either way you are still finding and
narrating the one turn from the steps above.

## The honest limit

Asked soon after a turn, you still have it in context and the note draws on
that. Asked about a turn from ten turns back, the note is reconstructed from
what agent-coop stored: `agent_coop_revisions` and `agent_coop_diff`, and nothing else
survives. That reconstruction is accurate about WHAT changed and thinner
about WHY, reasoning that was never written into a turn summary or a comment
is gone. Say so rather than inventing it. Asking soon after a turn gets the
better note.

## After `agent_coop_note`

The note appears on the diff screen; the audio renders from `narration` in
the background. You do not wait for it and you do not poll for it, the same
rule as the rest of agent-coop: no tool holds a turn open for something that has
not happened yet. Say what you wrote in chat, and end your turn.
