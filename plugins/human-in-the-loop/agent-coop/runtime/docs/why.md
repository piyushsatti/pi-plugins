# Why agent-coop exists

- Chat is a straw. When you and Claude work on anything with moving parts, the conversation becomes the bottleneck, not the model.
- The breaking point is not the first message. It is an hour in, when you can no longer tell what changed, what is current, or which of your asks actually landed.
- agent-coop replaces the scroll with a shared document: select text to comment, edit in place, submit. Claude works, and the diff shows exactly what changed since you last looked, attributed by author.
- The name is the promise: both of you move together, and neither runs ahead.

## The problem, from a real desk

Development with Claude Code stalls on a strange bottleneck: your bandwidth back to Claude. The model can produce a whole plan, a whole refactor, a whole document in one turn. Your response channel is a text box.

So feedback degrades into copy-paste quoting: paste a fragment, describe its location in prose, explain the change in words, repeat fifteen times. Nothing anchors the comment to the text it is about. Nothing tracks whether the feedback was acted on.

The deeper failure arrives quietly. An hour into a session the document has been rewritten four times, your earlier asks are somewhere in the scroll, and you cannot say with confidence what the current state even is. Chat has no answer to "what changed since I last looked?", and that question is the whole job.

## The idea

Two existing designs already solved halves of this problem, and agent-coop is deliberately their combination.

The claude.ai artifacts panel proved the first half: work deserves a surface, not a scroll. The moment output renders as a live thing beside the conversation, you stop reading history and start looking at state.

Document review idioms, the kind every Google Docs user knows, proved the second half: select, comment in the margin, resolve. Humans converged on this for giving each other precise feedback long before AI. There was no reason feedback to Claude should be cruder than feedback to a colleague.

## What agent-coop does about it

| Chat failure | agent-coop's answer |
|---|---|
| Feedback located by prose ("in the third paragraph you said...") | Select the text, comment on it. The anchor survives edits or honestly reports it detached. |
| "What changed since I last looked?" is unanswerable | The turn diff is scoped to your last submit, word-level, per block. |
| Who made this change? | Every change carries its author. Your own edits render muted; Claude's stand out. |
| Feedback fires one message at a time | Annotate all day. Nothing moves until you hit Submit, then Claude gets the whole batch. |
| Claims drift from reality | The diff is computed from the event log, not from what anyone said happened. A claimed fix that did not land shows as no change. |

## Proof it holds

The first real session did the whole loop: text selected on the page, a comment typed, Submit pressed. Claude woke without a chat message, applied the work, replied on the thread, and the attributed diff came back to the browser.

The same session also caught a real failure the surface was built to catch: a turn summary claimed a fix that the diff showed had not landed. In chat that claim would have stood. On agent-coop it was visible in one glance, and the next turn corrected the record.

## Who this is for

People who drive Claude Code daily and have felt both halves: the copy-paste tax on every piece of precise feedback, and the mid-session fog of no longer knowing what state the work is in. If that is you, agent-coop is the surface chat was missing.
