---
name: agent-coop
description: Open an agent-coop working session and arm the waker — bring the server up, print the session URL, then run the agent-coop-watch waker under the Monitor tool so each of the user's submits wakes you. Use when the user says "/agent-coop", "open agent-coop", "start agent-coop", "let's work in agent-coop", or asks for the agent-coop URL. Also read this whenever an agent-coop session is already open and you need to know what to do next.
---

# agent-coop

Agent Coop is a shared review surface: the user edits documents and leaves comments in
a web UI, then submits; you pull the batch, apply edits, and snapshot.

**You do not wait. You get woken.** Agent Coop has exactly one wake channel, and the
thing that waits on it is the Monitor tool, on the harness side of the seam. Your
turns are ordinary turns: a notification arrives, you do the work, you finish.
Never hold a turn open waiting for the user, and never look for an agent-coop tool that
waits — there is none, deliberately.

Everything agent-coop actually does lives behind the `agent_coop_*` MCP tools and the agent-coop
server. Nothing here computes anything itself.

## Packaged runtime

The plugin registers the `agent_coop_*` tools through its MCP manifest. The runtime
runs from its installed copy in `$HOME/.local/share/agent-coop/runtime`, never from
the plugin folder, through three installed commands: `agent-coop-mcp` (the MCP
server), `agent-coop-up` and `agent-coop-watch`. They keep this project's agent-coop data in
`<project>/.local-state/agent-coop/`. If `$HOME/.local/bin/agent-coop-up` is missing or
says there is no installed runtime, stop and point the user at the install
step in the agent-coop plugin README; never start the runtime another way.

## Starting: two steps

**1. Bring it up.** One command. It health-checks, starts the server if it is
down, chooses or creates a session, and prints the URL:

```
"$HOME/.local/bin/agent-coop-up"
```

Its output is three lines at most:

```
started agent-coop            (or: agent-coop already running)
created session s-…     (only when it made one)
http://localhost:<port>/session/s-…
```

Give the user that URL. Do not paraphrase it, do not rebuild it from parts.

Arguments, all optional, passed straight through:

| Argument | Effect |
|---|---|
| `--session <id>` | Open that session instead of the newest active one. Unknown id fails loudly. |
| `--title <title>` | Title for a session created because none existed. |
| `--file <path.md>` | Open a markdown file already on disk. Always makes a new session, with that file as its first document, so it needs agent-coop to be stopped (see below). |

Add `--json` if you want the result as one object (`base_url`, `session_id`,
`url`, `started`, `created`) instead of lines for a human.

**2. Arm the waker — once per session, never twice.** Before you call anything,
check whether you already armed it in this session. Two monitors on one session
means two notifications per submit and two turns racing to pull the same batch.
Step 1's first line is the hint, not the answer: `agent-coop already running` means the
server was up before you got here, which is usually a session that is already
armed. Armed is armed — do not arm a second one to be sure.

If it is not armed, call the Monitor tool once, on this command:

```
"$HOME/.local/bin/agent-coop-watch" --session <session_id>
```

with `description: "agent-coop submits"`, `persistent: true`, and `timeout_ms: 1000`.
That last one is required by the tool's own schema and is ignored while
`persistent` is true, which is what you want here: the waker runs for as long as
the session does.

Then give the user the URL and end your turn normally.

That script is the whole waiting mechanism. It long-polls agent-coop's wake channel,
prints one line — `agent-coop submit pending: <session_id>` — for each new submit, and
prints nothing at all while nobody submits. It never pulls and it decides
nothing. Every number it uses (how long one poll may hold, how long to sit still
after a failure, how long before it says the same unpulled submit again) lives in
`src/contract` and is written nowhere else — not here, not in words — so pass it
no arguments beyond `--session` and do not wrap it in a loop of your own.

## Each wake-up: one turn, then finish

A `agent-coop submit pending: <session_id>` notification is your cue.

**It is an event, not a reply.** It came from a script watching a socket, on its
own schedule — the user did not type it and it answers nothing. If you were
waiting on an answer to a question you asked, you are still waiting on it after
this arrives: do the pull, and ask again. Never read a wake-up as consent, as
approval, or as the answer to anything.

The same line can arrive twice for one submit. The waker says a submit again when
nothing has pulled it, which is how a wake lost to an interrupted turn comes back
— so a second line for a session you already finished is not a second submit and
not an error. Pull; if the pull is refused because nothing is submitted, the
submit was already handled — end your turn. Do not snapshot: no turn is open,
and the snapshot would be refused too.

One turn does all of this and then ends:

1. **`agent_coop_pull`** the session the line names. That is the only thing that
   consumes the submit; watching never does.
2. **Do the work.** `agent_coop_apply` per document — **always with a fresh
   `client_edit_id`**, which is what makes a retry a no-op instead of a duplicate
   edit — plus `agent_coop_comment_reply` and `agent_coop_comment_resolve` per comment. A
   session can hold several documents: `agent_coop_add_doc` puts a new one in the
   session (title plus its starting blocks, sent inline; it can never name a file
   on disk), and the next pull carries it like any other. If a tool result carries
   `pending_interrupts`, honour those comments before your next write.
3. **Check every write succeeded BEFORE snapshotting.** A failed `agent_coop_apply`
   with a snapshot on top writes a turn summary that lies about the document —
   the diff shows nothing changed while the summary says it did, which is the
   exact defect class this repo hunts. If a write failed, either fix and retry
   it (fresh `client_edit_id`) or say so in the summary; never summarize work
   that did not land.
4. **`agent_coop_snapshot`** with a one-line summary of what you did. That stamps the
   revision the user's turn-diff shows and hands control back.
5. **End the turn.** Say what you did in chat and stop. The waker is still armed;
   the next submit is the next notification.

Only a submit wakes you. No comment, of any delivery class, starts your turn on
its own — the user can annotate all day and nothing happens until they submit.
Writes from you before a pull are rejected with a conflict error, by design.

## Leaving

Stop the monitor (TaskStop), say why, on either of these and nothing else:

| Signal | What it is |
|---|---|
| The user says stop, that's enough, or we're done | the ordinary exit |
| The session was cancelled AND the user says they are finished | there is nothing left to wake on |

**Ending a turn is not leaving.** Finishing the work from one notification is the
normal path: the monitor keeps running and the next submit reaches you. And a
quiet user is not a reason to leave — the whole point of arming the waker is that
you do not have to be present.

`agent-coop watch: no agent-coop server answered at …` is **not** by itself a reason to stop.
The waker retries by itself and keeps running; it prints that line once per
outage, so a single one is what a restart looks like from the outside, and the
next submit still reaches you. If it keeps recurring, the server really is gone:
say so, stop rather than working around it, and bring it back up with step 1 when
the user asks.

## If the Monitor tool is not available

Say so in one sentence and ask the user to type a message in chat once they have
submitted. No machinery: do not poll in a loop, do not hold your turn open, do not
start a background command some other way.

## When bringing it up fails

The script throws rather than guessing. Three cases and one response each.

| Symptom | What it means | Do |
|---|---|---|
| `server did not answer on http://localhost:<port>` | The spawned server died on boot | Read the log path the error names, report the last lines, stop |
| `unknown session <id>` | The `--session` id does not exist | Run `agent_coop_sessions` and offer the real ids |
| `cannot create a session while agent-coop is running` | A new session was needed (nothing to open, or `--file`) but the server already holds the database, and it is the only writer | Tell the user agent-coop must be stopped for this, or offer an existing session with `--session <id>`. Never create one another way |

Never work around any of these by starting a server another way, by opening the
SQLite file, or by writing to `data/`. The agent-coop server is the only writer; a
second one corrupts the turn state machine.

Discuss anything you like in chat. Only document writes go through agent-coop.
