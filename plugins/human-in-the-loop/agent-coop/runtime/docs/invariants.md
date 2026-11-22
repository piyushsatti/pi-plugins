# agent-coop invariants

The contributor's map of hard boundaries and the reasons behind them, relocated
from AGENTS.md (agent-files v0.1.0 lane C). Read it before changing anything
under `src/`.

Finding ids cited below (A\*, PI-\*, SEC-\*, LOOP-\*, B\*, CQ\*) name the review
findings that earned each rule during the v1 build. The ledger behind them is
the maintainer's planning notes, outside this repo; the ids stay because a rule
that names its reason is harder to delete casually.

## Hard boundaries

- src/contract is the only source of shared types/schemas/DDL. Never hand-copy
  a field name or shape anywhere else; import it.
- src/engine owns the event log, reducer, and projections; must not know HTTP
  or MCP exists. A refusal is a `DomainError` from src/contract/errors.ts —
  `{ code, message, state }`, no status and no MCP field (B1). src/server/errors.ts
  owns code→HTTP-status and code→`retry_after_submit`; src/mcp/tools.ts owns
  HTTP-failure→`McpToolError`. Never add either to the reducer.
- src/server is the ONLY process touching SQLite/Yjs (single writer). It hosts
  engine + HTTP + SSE + Yjs together, in one process.
- src/mcp is a thin stdio→localhost-HTTP shim over src/server's HTTP API.
  It must not touch SQLite/Yjs directly, and must not duplicate server logic.
- web/ reaches data only via HTTP API. Built by scripts/build.ts (esbuild):
  web/src/ -> web/dist/. No vendoring. `splitting` is ON and load-bearing: mermaid
  is reached ONLY by the dynamic `import()` in web/src/components/mermaid-block.js,
  so it lands in its own chunk instead of in app.js. It used to be `external`,
  which left a bare `import("mermaid")` in the output — a specifier no browser can
  resolve, so a diagram could never draw and nothing said so. Never make it a
  static import, and never make it external again; the whole of web/dist is
  output, and src/server/static.ts serves every chunk in it.
- web/ never hand-copies a contract enum or length cap (B2/CQ5).
  `web/src/contract.gen.js` is
  generated from src/contract by scripts/gen-contract.ts (run by build.ts), and
  tests/web/test_contract_gen.test.ts fails when the committed file and a fresh
  render disagree. A direct import is not possible: it would pull zod into the
  browser bundle. The VALUES web compares against are named once in
  web/src/lib/enums.js, looked up in the generated arrays so a rename in the
  contract throws at module load instead of turning every comparison false. Any
  label map keyed by a contract enum checks its own coverage at module load.

## Gotchas

- Never write session_state or revision projections directly — they are
  derived by the reducer from the event log. Any write outside the reducer is
  a bug, not a shortcut.
- Turn state machine is engine-enforced: writes outside CLAUDE_TURN get 409 by
  design — that is the contract working, not a bug.
- The user's way OUT of a turn is the `cancel` event (PI-4): SUBMITTED or
  CLAUDE_TURN -> USER_EDITING, legal from both and a 409 from USER_EDITING, all
  decided in src/engine/reducer.ts. It is not an undo — blocks Claude already
  applied stay applied — and it clears `turn_started_at_seq`, because after it no
  turn is open. `POST /api/cancel` only: there is deliberately NO MCP tool, so a
  turn cannot be dropped off the record from Claude's side.
- Comments writable in any state; only block edits lock during a turn.
- `PullBatch.comments` is open ROOTS only — `parent_id IS NULL`
  (PULL-ROOTS-ONLY, src/contract/pull.ts, `openRootCommentsForSession`). A reply
  is a comment row and nothing resolves one, so a batch of "every open comment"
  handed Claude its own answers back, for ever, growing every turn. Author
  filtering is not available and never will be: `comment_reply` authenticates no
  actor. The accepted cost is that a USER's reply on an existing thread is not in
  the batch either — its still-open root is, and the full thread is one
  `GET /api/comments?doc_id=` away.
- `McpToolError.state` is OPTIONAL and absent means NOT KNOWN, never
  "USER_EDITING" (F4). Only a boundary that actually looked a session up sets it:
  `fail()` takes it as an optional argument and omits the key otherwise, and
  src/mcp/tools.ts `unavailable()` (unreachable server, unknown tool, unbuildable
  request, bodyless non-2xx) sets none. Claude reads that field to decide whether
  to wait for a submit, so a defaulted value is a wrong answer wearing the shape
  of a right one. Never give it a default again.
- Blocks store raw markdown; never normalize/reformat block text in engine code
  (breaks export round-trip and comment anchors).
- Comment anchors carry TWO opaque Yjs positions (PI-6): `relative_position`
  (head, assoc 0) and `relative_position_end` (tail, assoc -1). Never decode,
  compare, or fuzzy-match either anywhere in the stack. Read `quoted_text` if you
  need a human-readable pointer — it is display-only and must NEVER size a
  highlight (`head + quoted_text.length` was the PI-6 bug: after a rewrite it
  marked the right number of the wrong words while `anchor_state` still said
  "attached"). The browser gets the anchor's CURRENT range as
  `Comment.rendered_offsets`, computed server-side in src/server/anchors.ts on
  every read — the client never derives it.
- `anchor_state` has THREE values and only `attached` may be painted: `attached`
  (both ends resolved, range non-empty), `detached` (head resolves, run does not —
  tail null, ends collapsed, or a pre-PI-6 row with no tail), `orphaned` (block
  gone or head null). One function decides it: `resolveAnchorRange` in
  src/engine/yjs-binding.ts. Client code tests `!== "attached"`, never
  `=== "orphaned"`, so a future state cannot fall through to being drawn.
- A revision has a per-document PRIMARY KEY (`rev-x:0` in a multi-doc session) and
  a LABEL (`rev-x`). Only the label crosses the seam: it is what
  `revision_created` broadcasts, what `?to=`/`?revision=` accept, and what
  `Revision.revision_id` reports. `revisionRowId`/`revisionLabel` in
  src/engine/projections.ts are the suffix rule and its inverse, kept adjacent so
  they cannot drift.
- Turn summaries are persisted by the reducer into `revision.turn_summary` and are
  read back with `GET /api/revisions/:doc_id` (PI-5). The browser's in-memory
  summary Map is a first-paint convenience only; anything that must survive a
  reload comes from that endpoint.
- `TurnDiff.threads` carries the turn's comment threads (PI-7) — any thread whose
  root or a reply landed in `(from_seq, to_seq]`, empty for an `explicit` diff.
  A reply is NEVER labelled with an author: `comment_reply` authenticates no
  actor, same seam limitation as `doc_added`. A thread is a TREE in storage and
  FLAT on the wire: `commentThreadsInRange` buckets every descendant under its
  root ANCESTOR, never its immediate parent, or a reply-to-reply belongs to no
  thread and is dropped without a trace.
- Turn-diff: the browser never works out what changed. `GET /api/diff` answers
  all of it — which blocks (src/engine/diff.ts, from two reconstructions), which
  words inside a modified one (src/server/worddiff.ts), and WHO wrote each change
  — and web/src/views/turn-diff.js only paints the answer. Same rule as
  `rendered_offsets`. The wire type is `TurnDiff` in src/contract/diff.ts; it is
  defined there and nowhere else.
- Turn-diff base = the state at the user's most recent `submit`, never "the
  previous revision" (PI-1). That is why the first turn is not a page of "added"
  and why the user's pre-submit edits do not show: they are in the base. Changes
  after that submit can be either actor's, so each carries `author` and the view
  mutes the user's own. An ABSENT `author` means the log does not attribute the
  change (an explicit `from=`, or a `doc_added`, which names no actor because
  nothing at that seam can authenticate one) — never fill it in with a guess.
- Export writes the file BEFORE appending the `export` event: an event naming a
  file that failed to write would be a log that lies. Every export target must
  resolve INSIDE `../artifacts/` (SEC-3): relative paths resolve under it, an
  absolute path is accepted only if it already points inside it, and anything
  escaping (`../`, a symlink out, an absolute path elsewhere) is a 400.
  Containment is checked on the realpath of both sides, never on a string prefix
  of the raw input — see src/export/index.ts.
- MCP shim: run with `bun run`, never `bun build --compile` — the compiled
  binary breaks the MCP SDK's subpath imports.
- Crash recovery = replay from the event log. There is no separate "resume"
  path; server restart and Claude-session death are the same case.
- Voice input for a COMMENT is what shipped, and it is a SEPARATE, unrelated
  mechanism from the attachment surface below: it never touches an attachment.
  Audio rides with the comment submit itself, as base64 Int16 PCM at 16 kHz
  (`CommentAudioSchema`, src/contract/comment.ts), in any of the three places a
  text comment can be given (`<mic-control>`, web/src/components/mic-control.js:
  selection-layer.js's anchored pill, and comment-panel.js's whole-document
  composer and per-comment reply composer; web/src/lib/mic.js does the actual
  recording and encoding). The server transcribes it BEFORE anything is
  appended: `resolveCommentText` (src/server/routes/write.ts) turns the audio
  into text and only then dispatches `comment_create`/`comment_reply`, because
  the log is append-only and a comment body is never mutated afterward, so there
  is no "append now, fill in the transcript later." One comment lands, carrying
  the finished text (typed text and transcript merged, whichever side is
  non-empty). The audio is DISCARDED the moment transcription returns and is
  never persisted: src/transcribe/whisper.ts writes it to a temp WAV and deletes
  the directory in the same call's `finally`, so a failed transcription leaks
  nothing a successful one would not also have cleaned up. Claude never receives
  raw bytes, only the transcript already merged into the comment text, and that
  transcript gets NO special trust: it is untrusted text authored by whoever was
  near the microphone, same standing as any other user input once it lands.
  Browser microphone capture needs a SECURE CONTEXT: it works on the laptop over
  `localhost`, which browsers treat as secure regardless of HTTPS, and does NOT
  work on a phone over plain HTTP on the tailnet until HTTPS is enabled there
  (docs/phone.md).
- Audio and images on the ATTACHMENT surface are a separate story from the
  comment-voice path above (replaces the old A11 rule "Claude never receives raw
  audio; transcript gate is mandatory", retired 2026-08-15 as no longer
  describing the design). Every attachment carries `kind`
  (src/contract/attachment.ts, `image` or `audio`), and a dispatcher deciding by
  it is the design, not yet the code. The wire surface already exists and has
  no producer: the `attachment_add` event, `POST /api/attachments`,
  `PATCH /api/attachments/:id/transcript`, `POST /api/attachments/:id/retry`, and
  the `transcript_done`/`_failed`/`_retry` SSE frames. What is STILL missing is a
  browser that turns a recording or an image into an attachment, and the
  dispatcher that would route one by `kind`. This path shares no code with
  voice-in-comments above and has no bearing on it: do not wire the two
  together, and do not read either as evidence about the other's state.
- The source's DOM tests and tests/preload.ts were not copied into this port.
  The local-only guard suite lives in src/server/guard.test.ts; the obsolete
  preload config was removed. If DOM tests are restored, share ONE happy-dom
  window and never call GlobalRegistrator.register/unregister in a test file:
  `bun test` shares the module registry, so custom elements defined against the
  first window go inert in a second one, silently.
- The `/agent-coop` skill lives at `.claude/skills/agent-coop/SKILL.md` and nowhere else
  (LOOP-7): a SKILL.md outside `.claude/skills/` is never loaded, so nothing it
  describes ever happens. It holds no logic and issues exactly TWO commands:
  scripts/up.ts (health-check, start, choose-session, print) and scripts/watch.ts
  (the waker, armed under the Monitor tool). Anything the skill would have to
  compute belongs in a script or the server; a test asserts the command list.
- A session's FIRST document is a row, not an event (it precedes any event), so
  it is made through the engine's creator directly; the blocks it starts with
  still go through the log, as one `user_edit`. Every LATER document is a
  `doc_added` event (A1, PI-2): `POST /api/sessions/:id/docs` / `agent_coop_add_doc`,
  which carries the document row and its starting blocks in one event. Because
  `document` is not a projection table, replay upserts that row rather than
  inserting it — a replay must not delete documents. There is NO
  POST /api/sessions (SEC-2): creating a session names a local markdown file, and
  nothing the browser can reach may name a local path. Adding a document is
  allowed precisely because its body names no path: the doc_id and every
  block_id are minted server-side and the content arrives inline. scripts/up.ts creates
  sessions, and only in the window where it has probed the port and found no
  server — so the single-writer rule still holds. With a server already up, `up`
  refuses to create rather than opening a second writer.
- Both entry points to a document belong to the USER too (ENTRY-1). `up` always
  creates a first document, `--file` or not: `STARTER_DOC_TITLE` in scripts/up.ts
  plus the contract's `STARTER_BLOCKS`, one EMPTY block, because a session with no
  document opens on a page with nothing to click and nothing can add its first
  one afterwards. And the session view has an add-document form
  (web/src/views/session-list.js `addDoc`), so a session grows a document when
  the user says so and not only when Claude does. The empty block is not
  decoration: the document view edits blocks that EXIST and has no insert
  control, so a block-less document cannot be typed into. And an empty block has
  to LOOK editable: `paintBlock` in web/src/views/document.js stamps `data-empty`
  and puts `EMPTY_BLOCK_PLACEHOLDER` ("Start writing…") in the DOM — real text,
  not a CSS `::before`, so it is announced — and app.css hangs a dashed border on
  `data-empty`. Two cues, neither of them colour. The placeholder is never
  content: the block's stored markdown stays "" and the editor opens empty. Which
  is why
  `STARTER_BLOCKS` lives in src/contract/session.ts and `DocAddSchema.blocks`
  defaults to it and normalizes `[]` to it, in the CONTRACT: no surface — route,
  MCP tool or future caller — may mint an untypeable document. That rule was
  written THREE times (contract, scripts/up.ts, the web view) until STARTER-BLOCKS
  closed it; scripts/up.ts imports the constant because its document precedes any
  event and never passes through the schema, and BOTH the MCP shim and
  web/src/lib/api.js `addDoc` omit `blocks` when the caller omitted it rather than
  sending `[]`, so the default is reached rather than talked past.
- Loopback is a network boundary, not a browser one: any page the user visits can
  POST to localhost, and a `text/plain` POST is a CORS simple request with no
  preflight. Every method goes through src/server/guard.ts first: Host must be
  loopback or listed, including on reads, to block DNS rebinding. Writes also
  require application/json and same-origin Origin / Sec-Fetch-Site when present
  — or 403.
  "Loopback" is DECIDED, not listed (GUARD-IPV6): `isLoopbackHost` normalizes,
  because a Host header writes IPv6 bracketed and the same address has many
  spellings (`[::1]`, `[0:0:…:1]`, `[::ffff:127.0.0.1]`), and IPv4 loopback is
  the whole 127/8 block. A literal set of spellings 403'd legitimate requests it
  did not happen to name. The ONE exception is the A12 proxy seam: a Host named
  in `AGENT_COOP_ALLOWED_HOSTS` (comma-separated, parsed by `parseAllowedHosts`) may
  read and write — `tailscale serve` forwards the tailnet name as Host, so phone
  access needs it listed. Listing a host admits that origin's own pages only:
  the Origin/Sec-Fetch-Site checks still apply to it. Empty stays loopback-only.
- SQLite PRAGMAs are per-connection, so `foreign_keys` must NOT be in a migration
  (it would hold for exactly one boot). src/engine/db.ts `openDb` sets it; open
  the database through src/engine/db.ts, never `new Database` (SEC-1). That file
  has TWO entry points: `openDb` (the writer, PRAGMA-configured) and
  `openReadOnlyDb` (the backup worker's read-only handle, deliberately NOT
  configured — `journal_mode` writes the file header and fails read-only, and
  `foreign_keys` bounds writes it cannot make).
- Every string crossing the seam is length-capped in src/contract/limits.ts
  (ids 256, paths 4096, bodies 64K chars), and Bun.serve caps the whole body at
  MAX_REQUEST_BODY_BYTES. Cite the constant, never a literal. That includes the
  MCP tool input schemas (`idString`/`textString`/`pathString`, never a bare
  `z.string()` — a test in tests/mcp/test_tools.test.ts walks every shape) and
  the `maxlength` on a form control in web/, which reads the number from
  contract.gen.js.
- Backups are full database copies, so they are capped: MAX_BACKUPS (10) files in
  `../history/`, pruned oldest-first after each successful backup, and
  `ctx.backups` holds at most that many promises.
- The trigger is ONE dumb wake channel and agent-coop owns only the dumb half (rev 3).
  Agent Coop answers "is a submit waiting?" over `GET /api/turn/wait` (holds) and
  `GET /api/turn/pending` (does not). Everything that WAITS is on the harness side:
  scripts/watch.ts long-polls the channel and prints one line per new submit, the
  Monitor tool runs it for the session's lifetime, and each line is a wake-up.
  Claude's turns are ORDINARY turns — pull, work, snapshot, END. Never hold a turn
  open waiting for the user. README §What makes Claude act.
- NO MCP TOOL MAY WAIT, and this is evidence, not taste: an MCP client request
  that outlives the client's own request timeout fails the whole tool call with
  JSON-RPC `-32001` (request timed out), so the rev-2 wait tool turned "the user is
  thinking" into a broken tool call. The tool was deleted; the endpoint was not.
  A test walks every tool's mapped path and fails if one reaches `/api/turn/`.
- `GET /api/turn/wait` is a long poll on the broadcaster, NOT a poll of SQLite: it
  waits for the `state_changed` frame `dispatch` already sends and re-reads the
  projection to answer. A frame whose submit is already gone by the time it looks
  keeps WAITING — it never answers `pending: false` before the timeout, or the
  documented promise ("held open until a submit is visible") would be false. It is
  bounded by `TURN_WAIT_MAX_TIMEOUT_MS` (under the server's idleTimeout) and
  looping is the CALLER's job. It answers with `TurnPending` — the same shape as
  `/api/turn/pending`, and literally the same builder (`answerPending`), because it
  is the same question — and, like it, consumes nothing. Only `POST /api/pull`
  consumes a submit.
- EVERY trigger timing number is in src/contract/turn.ts and nowhere else
  (WAIT-TIMEOUT-ONE-PLACE). FIVE of them: scripts/watch.ts imports
  `TURN_WAIT_MAX_TIMEOUT_MS` for its query, DERIVES its own abort budget as
  `TURN_WAIT_MAX_TIMEOUT_MS + TURN_WAIT_CLIENT_SLACK_MS`, and imports the three
  intervals it runs on (`TURN_WATCH_RECHECK_MS`, `TURN_WATCH_RETRY_MS`,
  `TURN_WATCH_REANNOUNCE_MS`) — they are semantics of the channel, meaningful only
  against what `wait` answers, which is why they do not live in the script. The
  skill states no agent-coop number and passes no timeout to the waker; the one number
  it writes is the Monitor tool's own required `timeout_ms`, which is the
  harness's and is ignored under `persistent: true`. Tests grep watch.ts for every
  one of the five literals. The rev-2 claim that the skill was "the one place the
  number is written" was false while the contract wrote it too — do not
  reintroduce a number in prose.
- The waker's ONE piece of state is de-duplication, and it is not optional: `wait`
  answers instantly while a submit sits unpulled, so a memoryless loop announces
  the same submit on every iteration for the whole of Claude's turn. That is what
  `submit_seq` is for: `(session_id, submit_seq)` IDENTIFIES a submit, and a line
  is emitted only when the pair is new. It is in MEMORY, not on disk — losing it
  costs one repeated wake-up. It also emits one line per unreachable episode
  (silence and "nobody submitted" are indistinguishable from the harness side) and
  never exits on a failed request.
- That de-duplication EXPIRES after `TURN_WATCH_REANNOUNCE_MS`, and the expiry is
  as load-bearing as the memory. Remembering for ever is how a wake gets lost: a
  notification that lands during an interrupted turn is never repeated and
  `pending` only clears on a pull, so the submit waits until a human notices.
  Still unpulled after the interval means nothing acted on it, so the line goes
  out again. Do not "fix" the duplicate line — the skill says a repeated wake for
  an already-finished session is expected and costs one refused pull (the pull
  409s because nothing is submitted; that refusal IS the all-clear, and no
  snapshot follows because no turn opened).
- An abandoned submit must not pin the trigger (LOOP-4). Two halves: `pending` names
  the MOST RECENT submit (src/server/queries.ts `submittedSessions`, one SQL
  definition of "a submit is waiting"; ties break on `s.id` so same-millisecond
  submits still give one stable answer), and the maintenance sweep cancels any
  submit older than `STALE_SUBMIT_MS` — through the reducer's `cancel` event, the
  same one the "Take it back" button sends, never a private path.
- Dogfooding is repo-scoped in v1 (LOOP-6): `.mcp.json` lives at this repo's root
  and the waker is a script in it, so the tools exist and the skill's commands
  resolve only when Claude Code's working directory is the agent-coop repo or one of its
  worktrees. Say so as a limitation; do not imply agent-coop works on an arbitrary
  project.
- `.mcp.json` names no port and no URL. `src/mcp/index.ts` `baseUrl()` owns that
  default and reads `AGENT_COOP_URL`/`AGENT_COOP_PORT` from the inherited environment; a
  literal in the registration would be a second copy of the port.
- Compaction RUNS (B6): src/server/maintenance.ts `runMaintenance` is the one
  periodic pass — GC sweep, stale-submit sweep, and folding any document at or
  over `COMPACTION_THRESHOLD` update rows into one merged_snapshot — on the same
  timer serve() already had. The engine still schedules nothing itself: it answers
  `docsNeedingCompaction` and compacts one document; when belongs to the process
  with the clock. It takes a `DispatchContext` (src/server/context.ts), not a bare
  db, because cancelling a stale submit must go through `dispatch` and broadcast.
  Lower a bound only through `serve({ compactionThreshold, staleSubmitMs })`,
  which exists for tests.
- ONE function decides what a fence becomes: `md.renderer.rules.fence` in
  web/src/lib/render.js. markdown-it's default rule got every fence, which is why
  a ```mermaid fence arrived as a paragraph of graph syntax. `mermaid` ->
  `<mermaid-block source="…">` (A9); anything else -> `pre.code-block > code`,
  escaped and coarsely highlighted by web/src/lib/highlight.js. Highlighting is
  DELIBERATELY coarse (comments, strings, numbers, one shared keyword set, and an
  unknown language gets escaped text and no spans): a grammar library is 100KB+
  for fences that are a few lines, and vendoring one is out. The fence rule builds
  its own HTML, so `html: false` no longer covers it — `escapeHtml` in
  highlight.js is the one place a fence body becomes markup, and it escapes the
  mermaid `source` attribute too.
- Nothing in the document pane may widen the PAGE, and it takes both halves to
  hold: `min-width: 0` on the grid tracks (a `1fr` track's `min-width: auto` stops
  it shrinking at its widest child, so one long code line pushed the whole page
  sideways — 1972px in a 1280px viewport) AND an `overflow-x: auto` box around
  every child that can be wider than the column (`pre`, `mermaid-block`, `table`,
  in app.css). Without the min-width the boxes cannot shrink; without the boxes
  the content is clipped instead of scrollable. The diff view paints the same
  rendered markdown and needs the same rules — `.diff-pane`/`.diff-body`.
  IMAGES are the exception to the box rule: an image has nowhere to wrap and
  nothing puts it in a scroller, so it SCALES — `max-width: 100%; height: auto`
  on `.block img` and friends. The one thing that opts out is a drawn diagram
  (`mermaid-block svg { max-width: none }`), which keeps its natural size because
  its own element is the scroll box.
- The document view has TWO client-local modes and REVIEW is the default
  (MODE-1): `review` (a click is a selection, the comment pill is live) and
  `edit` (a click opens that block's editor, comment highlights dim, the pill is
  suppressed). Both gestures wanted the same click and the editor won every
  time, so selecting text to comment on — the primary thing this surface is for
  — was impossible. Nothing about the mode crosses the wire: no event, no
  contract field, no server state. It is stamped ONCE as `data-mode` on the view
  root, and everything reads it there — `openBlock`, `applyBlockMode` (a block is
  only `role="button"`/"Edit this block" in edit mode, because in review that
  label is a promise the view does not keep), app.css, and
  `<selection-comments>.suppressed`, which reads its nearest `[data-mode]`
  ancestor rather than holding a second copy. `setMode` in
  web/src/views/document.js is the only writer and a LOCKED turn overrules its
  argument: in SUBMITTED or CLAUDE_TURN the switch is disabled and the mode is
  forced to review, because a block edit 409s there whatever the UI says. When
  the lock lifts the switch comes back but the mode does NOT — and `load()`
  resets to review, so switching documents starts over. "e" toggles (never while
  `isTypingTarget`), Escape closes an open editor and otherwise returns to
  review.
- A view that holds LIVE FORM STATE must be patched, never rebuilt. Both of
  `<session-list-view>`'s bugs were the one `this.innerHTML = …`: the doc list
  showed every document twice (`addDoc` re-reads and the `doc_added` frame it
  broadcasts re-reads, both reset-then-appended), and any frame arriving while the
  user was typing a document title replaced the input under them. `mountShell`
  builds the heading/status/form ONCE; `patchDocs` reconciles the `<ul>` keyed by
  `doc_id`, so two runs racing produce one row. Same rule as `patchBlock`.
- Two reads racing means LAST REQUEST wins, not last response. `doc_added` frames
  arrive in bursts, so `<document-view>.refreshDocSwitch` can have two
  `api.session` calls in flight and their responses are not ordered — the older
  one landing last painted a switcher missing the document whose frame started
  the newer read. A generation counter (`this.docsGeneration`, bumped by
  `load()` too) drops any response a later request has superseded.
- An optimistic UI write rolls back ITS OWN paint and nothing else (CQ4).
  `clearPendingMarks` (mark[data-pending]) is the rollback; `clearMarks` is only
  ever a prelude to repainting every highlight from the server's list.
- src/server/paths.ts decides the container DEPTH from the path, never from what
  exists: a repo root whose parent is `worktrees/` is a worktree (container two
  up), anything else is the repo (one up). The old rule probed for the directory
  and fell back a level, so a first run from a worktree created `worktrees/data`
  and split the database. `containerPath` is pure and exported for that reason,
  and it THROWS when the layout says one depth and the only existing directory is
  at the other — naming both paths and the AGENT_COOP_*_DIR override, because both
  silent answers are worse than stopping.
- Only scripts/up.ts may open the database, and only in the window where it has
  probed the port and found no server. scripts/seed.ts goes through `up()` rather
  than repeating that rule (B4/CQ2), and scripts/db-reset.ts takes its path from
  src/server/paths.ts so `AGENT_COOP_DB` names the same file the server opens (CQ6).
  Nothing else recomputes the container layout.
- `narration_ready`/`narration_failed` (src/contract/sse.ts) are the only two SSE
  frames with no event behind them, and src/server/notes.ts broadcasts them
  DIRECTLY — never through src/server/emit.ts, which is otherwise the one place a
  committed log event becomes SSE rows (`sseEventsFor`). Deliberate, not an
  oversight: the audio is a cache, not a fact of the log (next gotcha), so there
  is no event for emit.ts to read in the first place. src/server/notes.ts is the
  only module that may send either frame.
- The narration audio is a derived CACHE: regenerable at any time from
  `revision.narration` (migrations/0003_turn_note.sql), so it has no event and no
  projection row, and deleting `data/narration/` loses nothing. `narrationPath`
  (src/server/notes.ts) names the file from the revision ROW id, never the label
  — see the revision-row-id-vs-label gotcha above — and the filename is DERIVED,
  never caller-supplied, so unlike an export target it needs no containment check
  (SEC-3, src/export/index.ts); never import src/export for this, it solves a
  different problem. Every writable directory the server touches reaches it
  through `ServerContext` (`artifactsDir`, `backupDir`, `narrationDir`) for
  exactly one reason: a module-level constant resolves to the live `../data/` in
  every process that imports it, `bun test` included. Not hypothetical — a
  version of src/server/notes.ts read `NARRATION_DIR` directly, so the suite
  wrote real audio into the live data directory and an `afterAll` then deleted
  the whole of it. `tests/server/test_context.test.ts` is the guard, and its own
  comment says why: the defect was only ever about WHERE something was written,
  and both a behavioural test and a mutation test still pass wherever the bytes
  land, so only an assertion about locations finds it.
- The AUDIO CONTAINER belongs to the backend, never to a constant above it:
  `SpeechBackend` carries `ext` and `mime` (src/speech/seam.ts), src/server/notes.ts
  names the cache file with the `ext` of the backend that is about to write it,
  and src/server/routes/read.ts sets `Content-Type` from the same place. There
  WAS one `NARRATION_MIME = "audio/mp4"` constant, correct while `say` was the
  only engine and wrong the moment `kokoro` shipped WAV: it would have served
  WAV bytes labelled as MP4. Default backend is `kokoro` (af_heart), decided by
  listening; ../notes/research/local-tts-for-turn-notes.md is the evaluation and
  `AGENT_COOP_VOICE` is the switch. Kokoro's WAV is written by `encodePcm16Wav` in
  src/audio/wav.ts rather than by kokoro-js's own `save()`, which emits
  32-bit float (format tag 3) at twice the size; tag 1 is what every decoder
  reads. Six mutations of that 44-byte header are each killed by a test.
- SPEECH IS BECOMING A SERVICE, and that is decided (2026-08-15), so do not
  invest in the in-process design as if it were the destination. agent-coop will send
  text to an endpoint and receive audio back; the engine, its runtime and its
  models live on the other side, eventually in their own repository, and the same
  service is intended to answer speech IN as well (src/transcribe). The seam
  already built is the right seam: a service-backed engine is one more entry in
  `BACKENDS` whose `synthesize` makes an HTTP request instead of a library call,
  so nothing above src/speech/ changes. Anything embedded in agent-coop meanwhile is
  SCAFFOLDING and must say so at the code, or it becomes permanent by being
  forgotten. The service answers BOTH directions, so speech-in is a second call
  to the same endpoint rather than a second integration, and the trust question
  that used to block it was settled on 2026-08-15 by retiring A11 in favour of
  the dispatcher rule above. ../notes/research/local-tts-for-turn-notes.md,
  requirements R7 to R9.
- src/speech/seam.ts holds the TYPES and `SpeechError`; src/speech/index.ts holds
  the REGISTRY and re-exports them, so no caller outside the directory names
  seam.ts. Split for a reason worth remembering: index.ts imported ./kokoro.ts
  for `BACKENDS` while kokoro.ts imported `SpeechError` back out of index.ts as a
  VALUE, and a value import inside a cycle is initialisation-order dependent.
  Every existing importer reached index.ts first, so it worked and 780 tests
  passed; entering through kokoro.ts died with `Cannot access 'kokoroBackend'
  before initialization` pointing at a line that was not wrong. say.ts had the
  same import and never broke because it takes only TYPES, which are erased. A
  cycle in `import type` is free; the same cycle through a value is a time bomb.
- `note_written` (src/contract/events.ts) is legal in EVERY session state —
  src/engine/reducer.ts's one exception to "every other Claude-side write is
  CLAUDE_TURN-only." A note describes a turn that has already closed, so it is
  written after CLAUDE_TURN ends by definition; gating it the way `claude_apply`
  is gated would 409 every note that will ever be written. Same argument as
  `comment_create`/`comment_resolve`, also legal throughout.
- A note finds its revision row by LABEL, through `revisionRowIdForLabel`
  (src/engine/projections.ts) — the same label-vs-row-id split as the revision
  gotcha above, applied to a lookup rather than a broadcast. Never pattern-match
  the row id instead (`id = ? OR id LIKE ? || ':%'`): the label is caller-
  supplied, and a `%` inside it would silently widen the match. The function
  narrows to the document first, then matches the exact inverse (`revisionLabel`),
  which is exact by construction.

## Docs staleness

Changing one of these surfaces makes a specific doc wrong. Check it in the same
change, not later.

| Surface changed | Check |
|---|---|
| src/transcribe/ (voice input: binary, models, env vars, backend) | docs/install.md's voice-input section, docs/phone.md's HTTPS table, README.md's `src/transcribe/` row, the voice-input gotcha above |
| src/speech/ (narration backend, `AGENT_COOP_VOICE`) | docs/install.md's "Choosing the narration voice", the speech gotchas above |
| src/server/paths.ts (directory layout, `AGENT_COOP_*_DIR` env vars) | docs/install.md's "Where agent-coop puts its files" table |
| src/contract/limits.ts (length caps, `MAX_REQUEST_BODY_BYTES`) | the "Every string crossing the seam" gotcha above, which cites it as authority |
| a top-level src/ or web/ directory added, removed, or repurposed | README.md's "Repo layout" table |
| `.mcp.json`, the MCP tool list, or the `/agent-coop` skill's commands | docs/install.md's "Approving .mcp.json" section, README.md's Quickstart and "What makes Claude act" sections |
| `AGENT_COOP_ALLOWED_HOSTS`, the request guard, or anything phone-reachable | docs/phone.md |
