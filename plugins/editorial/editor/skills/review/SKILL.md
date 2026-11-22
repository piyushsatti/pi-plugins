---
name: review
description: Review a draft against the editor rulebook, with a mechanical leak and format check and a reader's pass for structure and evidence. Reports findings and never edits the draft. Use when asked to review, check or sanity-check a document, ticket, PR description or report before it goes out.
---

# review

Find what is wrong with a draft and say so plainly. Do not fix it: the author decides.

## Two passes

**1. Mechanical.** Run `python3 scripts/check.py <file>` from this plugin's folder. It reports, with line numbers:

- email addresses;
- strings that look like tokens, keys or private keys;
- private IP addresses and internal host names;
- long digit runs that may be account or card numbers;
- hard-wrapped paragraphs.

Each finding is a candidate. Confirm or dismiss it in the report.

**2. Reader.** Read it as the main reader would. For long or high-stakes pieces, hand this pass to the `reviewer` agent so it reads without the author's context. Check, in order:

1. **Reader and question.** Is it clear who it is for and what they asked? Does the first paragraph answer it?
2. **Order.** Does each section earn its place, in an order the reader needs it? Is anything buried that belongs at the top?
3. **Evidence.** List every claim the piece depends on. For each: is there a source, a test, a link or a number? Mark claims that are assumed, stale or untested. A confident tone is not evidence.
4. **Words.** Jargon for the wrong reader, names where roles belong, dense sentences, missing environment or version on a "works" claim.
5. **Leaks.** Employer, client or private project names, and anything the script missed.
6. **AI tells.** If the prose sounds machine-written, suggest the `humanizer` skill rather than rewriting it here.

## Report

Lead with a one-line verdict: ready, ready after small fixes, or not ready. Then a table of findings, most serious first:

| # | Where | Finding | Why it matters | Suggested fix |
|---|---|---|---|---|

Then the claims that lack evidence, if any. Write the report to a file when it is long, and give the full path.
