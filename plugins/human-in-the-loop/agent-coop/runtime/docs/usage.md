# Using agent-coop

- **Review is the default mode.** A click selects text so you can comment on it.
  Press `e` (or the toolbar switch) to edit blocks instead.
- **Comments never lock.** You can write them in any state. Only block edits lock
  while a turn is running.
- **Submit is the only thing that wakes Claude.** Comments alone do nothing until
  you press it.
- **You can always take it back.** "Take it back" returns the document to you from
  either locked state. It is not an undo.
- **The diff is measured from your last submit**, not from the previous revision,
  and every change says who made it.

## Start

Inside Claude Code, with this repo as the working directory:

```
/agent-coop
```

The skill runs `bun run scripts/up.ts`, gives you the URL, and arms the waker
once. Without Claude Code, `bun run scripts/up.ts` gives you the same URL and the
same UI; nothing will answer your submits.

| Flag | Effect |
|---|---|
| `--session <id>` | open that session instead of the newest active one; an unknown id fails loudly |
| `--title <title>` | title for a session created because none existed |
| `--file <path.md>` | open a markdown file already on disk as the new session's first document. Always makes a session, so agent-coop must be stopped |
| `--json` | print the result as one object instead of lines |

The URL is `http://localhost:<port>/session/<session_id>`. Four paths are routed
and all of them are bookmarkable (`web/src/app.js`):

| URL | View |
|---|---|
| `/` | every session |
| `/session/:session_id` | that session's documents, plus the add-document form |
| `/session/:session_id/doc/:doc_id` | the document |
| `/session/:session_id/doc/:doc_id/diff/:revision` | one past turn |

## Review mode and edit mode

The mode is client-local. No event carries it, no server state depends on it, and
switching documents resets to review (`web/src/lib/modes.js`,
`web/src/views/document.js`).

| Mode | A click on a block | Comment pill | Comment highlights |
|---|---|---|---|
| `review` (default) | selects text | live | painted |
| `edit` | opens that block's raw-markdown editor | suppressed | dimmed |

| Key | Does |
|---|---|
| `e` | toggle the mode, unless the keystroke is text (an input, a textarea, the editor) |
| `Esc` | discard an open editor, leaving the block as it was; with no editor open, return to review |

The switch is **disabled while a turn runs** and the mode is forced to review,
because a block edit in `SUBMITTED` or `CLAUDE_TURN` is refused by the engine
whatever the UI shows. When the lock lifts the switch comes back, but the mode
does not: you ask for edit mode or it does not happen.

An empty block shows "Start writing…" and a dashed border. That is a placeholder,
not content: the stored markdown is still empty and the editor opens empty.

## Comments

| Kind | How | Wire shape |
|---|---|---|
| anchored | select text in review mode, then "+ comment" in the pill | carries `doc_id`, `block_id`, the selection, and `quoted_text` |
| global | the "Comment on the whole document" box in the comments drawer | `anchor: null` |
| reply | the "reply…" box on any comment | a new comment row with `parent_id`, never a mutation |

Each composer carries a delivery control with three classes from the contract:
`queued` (the default), `interrupt` (flagged with a marker), and `ambient`
(`src/contract/comment.ts`, `web/src/lib/delivery.js`). Delivery never changes
**when** Claude runs. What `interrupt` buys, concretely, is a count: the number of
open `interrupt` comments in the session rides back on every `agent_coop_apply` result
as `pending_interrupts`, and the skill tells Claude to honour those before its
next write. `queued` and `ambient` are stored and shown, and differ in nothing
else today.

**Resolve** closes a thread and is legal from any state and either actor. Resolved
comments collapse into a "Resolved (n)" section in the drawer.

An anchor can lose its grip on the text under it. The panel says so rather than
painting a highlight in the wrong place:

| `anchor_state` | Meaning | Highlight |
|---|---|---|
| `attached` | both ends resolve and span at least one character | painted |
| `detached` | the head resolves, the run does not | not painted, tagged |
| `orphaned` | the position or the block is gone | not painted, tagged |

## Submit

"Submit for review" does four things, in this order:

1. Commits any block editor still open, so an in-flight edit is not dropped.
2. Appends a `submit` event; the session state becomes `SUBMITTED`.
3. Locks every block in the session. The state banner reads
   `waiting on Claude (SUBMITTED)`.
4. Makes the submit visible on `GET /api/turn/wait`, which is what the waker is
   long-polling.

Submit is session-scoped, not per-document. Comments stay writable.

## What Claude's turn looks like from the browser

Nothing needs refreshing. One SSE stream per page carries every change
(`src/contract/sse.ts`).

| You see | Frame |
|---|---|
| the banner changes to `waiting on Claude (CLAUDE_TURN)` | `state_changed` |
| blocks update one at a time as Claude writes them | `apply_progress` |
| replies appear in the comments drawer | `comment_added` |
| a thread collapses into Resolved | `comment_resolved` |
| a new document appears in the session | `doc_added` |
| the page moves itself to the turn diff | `revision_created` |

The auto-navigation is narrow on purpose: only the document you are looking at,
and only if this turn actually wrote to it. A turn that only answered comments
navigates nowhere, and a document you are editing in the same session does not
yank you out of it.

## The turn diff

Reached automatically when Claude's revision lands on the open document, or by
its URL at any time afterwards.

- The base is **the state at your most recent submit**, never "the previous
  revision". The screen says which, from `TurnDiff.base`: "since you last
  submitted", "since this document was added", or "between two revisions".
- That is why your first turn is not a page of "added", and why your own
  pre-submit edits do not appear: they are in the base.
- Blocks are annotated in place as rendered markdown, not as a monospace patch.
  Each change carries a word **and** a glyph: added `+`, removed `−`, modified
  `~`, moved `↕`.
- Modified blocks also carry word-level `<ins>` and `<del>` runs, computed by the
  server.
- Every change says **who**: "by Claude" or "by you". Your own edits are muted
  visually and still labelled in words. An absent author means the log does not
  attribute the change, and nothing guesses.
- Claude's one-line summary sits at the top, read back from the server so it
  survives a reload.
- Comment threads that this turn touched are on the same screen, under "Comment
  replies this turn". A reply is never labelled with an author, because
  `comment_reply` authenticates no actor.

The browser works none of this out. `GET /api/diff` answers which blocks changed,
which words inside them, and who wrote each change; the view paints the answer.

### Revision list

"Past turns" in the diff view lists every revision label on the document, newest
first, with its stored summary (`GET /api/revisions/:doc_id`). Each is a link back
into the same view with a different `to`, so a diff is re-openable rather than
view-once. The client never sends a `from`: the server picks the base.

## Take it back

"Take it back" is live exactly when Submit is disabled, and disabled rather than
hidden, so you can see it exists before you need it. It returns the session to
`USER_EDITING` from either `SUBMITTED` or `CLAUDE_TURN`.

| It is | It is not |
|---|---|
| the way out of an accidental submit | an undo |
| the way out of a Claude session that died holding the turn | a way to reject Claude's edits |
| an event on the log, like everything else | available to Claude: there is no MCP tool for it |

Blocks Claude already applied stay applied, and the next diff shows them as
Claude's, because they are. A submit nobody ever pulls also times out on its own:
the periodic sweep sends the same `cancel` event once it is older than
`STALE_SUBMIT_MS` (24 hours, `src/server/maintenance.ts`).

## Add a document

A session can hold several documents. Both entry points belong to you.

| Who | How |
|---|---|
| you | the "Add document" form in the session view |
| Claude | `agent_coop_add_doc` during its turn |

A new document starts with one empty block, always. The document view edits
blocks that exist and has no insert control, so a document with no blocks could
never be typed into. Neither path can name a file on disk: the ids are minted
server-side and the content arrives inline.

Opening a file that is already on disk is `up.ts --file <path.md>` and nothing
else, because naming a local path is not something the browser is allowed to do.

## Export

The "Export" button writes the document's current blocks as markdown into the
container's `artifacts/`, under a slug of the document title, and then records an
`export` event. The toolbar reports where the file landed and the label stays on
screen rather than vanishing as a toast.

- Export reads, so it is allowed in any state.
- The bytes are written **before** the event is appended: an event naming a file
  that failed to write would be a log that lies.
- Every target must resolve inside `artifacts/`. See [security.md](security.md).
- Markdown files are exports, never inputs. Editing an exported file does not
  change the document.

## Leaving

Tell Claude you are done and it stops the monitor. Ending a turn is not leaving:
the monitor keeps running and your next submit reaches Claude, which is the whole
point of arming it. A quiet stretch is not a reason for Claude to leave either.

To stop the server, kill the process listening on the port. `data/server.log`
holds its output.

---

Next: [how-it-works.md](how-it-works.md). Back to [install.md](install.md).
