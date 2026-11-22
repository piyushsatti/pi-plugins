---
name: draft
description: Draft a document, ticket, bug report, PR description, runbook or announcement to the editor rulebook, check it for leaks, and stop at a local file until the human says yes to publishing. Use when asked to write, draft or prepare any of these for someone else to read.
---

# draft

Write one piece for one reader, keep it on disk, and hand it over checked.

## Steps

1. **Read the rulebook.** It is `RULEBOOK.md` at this plugin's root, or the file named by `EDITOR_RULEBOOK` if that is set. Its rules win over habits.
2. **Name the piece and the reader.** Pick the row in rulebook section 1 that fits. If two readers need it, say so and plan two pieces.
3. **Gather facts before prose.** Read the sources the human pointed at: the branch, the diff, the issue, the notes. Write down each fact the piece will rest on and where it came from. Do not invent a number, a name or a result. Mark anything unknown as unknown.
4. **Write the draft** in that row's style. Lead with the answer. Keep one idea per sentence.
5. **Save it locally**, next to the work or where the human said, as `<name>.draft.md`. Say the full path.
6. **Check it.** Run `python3 scripts/check.py <file>` from this plugin's folder. Fix every finding, or say why it is a false alarm. Then read it once more for anything the script cannot see: names of employers, clients or private projects, and claims without a source.
7. **Offer a review.** For anything long or important, run the `review` skill on the draft before handing it over.
8. **Stop.** Report the path, the reader you wrote for and the check result. Publishing, filing, posting or editing a live page needs the human's explicit yes for that one action. Then do only that action, and report where it went.

## Destinations

The draft is plain Markdown so it can go anywhere: a wiki page, a tracker ticket, a pull request, a chat post or an email. When the human names a destination, adjust format only (title, headings, length) and keep the content. Use the destination's own tool or connector to publish, never a script that posts with the human's credentials.
