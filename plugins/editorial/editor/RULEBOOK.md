# Rulebook

One short set of rules for anything written to be read by someone else: a design note, a ticket, a bug report, a PR description, a runbook, an announcement or a handoff. The `draft` and `review` skills both work from this file. Replace it with your own house rules by pointing `EDITOR_RULEBOOK` at another file.

## 1. Pick the reader first

Every piece has one main reader, one question that reader is asking, and a style that answers it.

| Piece | Main reader | Their question | Style |
|---|---|---|---|
| Design note | the team now and later, not all experts | What is the problem, and why does it matter? | Problem first in plain words. A one-paragraph summary at the top. Define a term the first time or cut it. Put deep detail behind a link. |
| Task ticket | whoever builds it | What do I build, and how do I know it is done? | Precise and technical: exact paths, flags and settings, then acceptance criteria. No story. |
| Bug report | whoever triages it | How do I reproduce it, and how bad is it? | Steps, expected against actual, evidence, who and what is affected. |
| PR description | the reviewer | Is this safe to merge? | What changed and why it is safe, one usage example, how it was checked. No file-by-file tour. |
| Runbook | an operator in the middle of an incident | What do I do right now? | Action first, numbered steps, commands that paste as they are. Background last or not at all. |
| Announcement | people skimming | Does this affect me? | One line on what changed and who it touches, then a link. |
| Handoff | the next person or agent on the work | What is the full state? | Dense is fine. Complete beats easy. |

Two readers means two pieces that link to each other. Do not average the styles.

## 2. Say it plainly

- One idea per sentence. Say what happens before how it works.
- Lead with the answer. If the question is "does it work?", the first line says yes or no in those words, then the detail.
- Name tool internals only for the builder. For everyone else, say what the thing does.
- Write roles, not names: "the reviewer", "the operator", "an agent". The rule still reads true when the person or the tool changes.
- When you say something works, is tested or is running, name the environment and the version it was in.
- Keep ready and done apart. Every part checked but nothing run end to end is ready, not done.

## 3. Shape

- Never hard-wrap. One paragraph or list item is one line; the renderer handles width.
- Use a table for options, trade-offs and comparisons.
- Put long reference material in its own file and link it.
- State gaps and risks as plain facts, without blame. "No owner on record" beats "X failed to own this".

## 4. Nothing leaks

Before a draft leaves the machine, it must hold none of these:

- an email address, other than an address meant to be public;
- a password, token, API key or private key, even a revoked one;
- a private host name, a private IP address or an internal URL;
- an account, card or government ID number;
- the name of an employer, client or private project that is not already public in this context.

`scripts/check.py` finds the first four mechanically. The last needs a reader.

## 5. Nothing goes out without a yes

Publishing, filing, posting, commenting and editing a live page each need an explicit yes from the human for that one action. A draft on disk is the finished job until then.
