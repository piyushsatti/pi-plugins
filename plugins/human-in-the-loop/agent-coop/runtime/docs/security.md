# Security model

- **There is no authentication in v1.** No accounts, no tokens, no passwords.
  Anyone who can reach the port can read and write everything.
- **The loopback bind is the boundary.** The server binds `127.0.0.1`
  explicitly. Never expose it beyond loopback or a trusted tailnet.
- **The request guard is a browser boundary, not a network one.** Every method
  requires a loopback or listed Host to block DNS rebinding. Writes also check
  Content-Type, Origin and Sec-Fetch-Site.
- Exports are contained to `artifacts/`, and every string crossing the seam is
  length-capped. Those are the two limits that hold regardless of who is calling.

## What each layer actually stops

| Layer | Stops | Does not stop |
|---|---|---|
| loopback bind (`hostname: "127.0.0.1"`) | other machines on the LAN | anything running on this machine, including your browser |
| request guard (`src/server/guard.ts`) | DNS rebinding on reads and writes; a page on another origin writing to agent-coop | a local process, a CLI, curl |
| export containment (SEC-3) | a write outside `artifacts/` | a bad write inside it |
| length caps (`src/contract/limits.ts`) | unbounded growth in an append-only log | a caller that stays under the cap |
| nothing | an unauthenticated caller that reaches the port | |

`Bun.serve` with no hostname accepts connections on every interface, verified
reachable on the LAN IP. The bind is therefore explicit
(`src/server/index.ts`), not left to a default.

## Why the request guard exists

Binding to loopback keeps other machines out. It does not keep your own browser
out: any page you visit can POST to `http://localhost:4317`, and a `text/plain`
POST is a CORS **simple** request, so there is no preflight to refuse and the
response being unreadable does not undo the write.

Host is checked on every method, including GETs for APIs, SSE, attachments and
static files. Without this check, a DNS-rebinding page can read local data.
Content-Type, Origin and Sec-Fetch-Site are checked only on `POST`, `PUT`, `PATCH`
and `DELETE`. A failure is 403 with the contract's error body.

| Check | Rule | Why |
|---|---|---|
| Content-Type | must be exactly `application/json` | this alone removes the simple-request path: a cross-site fetch cannot set it without a preflight |
| Host | must be loopback, or a name listed in `AGENT_COOP_ALLOWED_HOSTS` | a DNS-rebinding name that resolves to 127.0.0.1 arrives with its own Host, not ours |
| Origin / Sec-Fetch-Site | when present, must be same-origin | absent Origin is allowed because non-browser clients send none; browsers always send `Sec-Fetch-Site` |

"Loopback" is decided, not listed. `isLoopbackHost` normalizes before comparing,
because a Host header writes IPv6 bracketed and one address has many spellings
(`[::1]`, `[0:0:0:0:0:0:0:1]`, `[::ffff:127.0.0.1]`), and IPv4 loopback is the
whole `127.0.0.0/8` block. An earlier literal set of spellings refused legitimate
requests it did not happen to name.

The Origin comparison **includes the port**, unlike the Host check: a different
port on localhost is a different origin to a browser, and so it is here.

## `AGENT_COOP_ALLOWED_HOSTS`

The one exception to loopback-only requests, for putting a reverse proxy on a
trusted private network in front of the server.

| Property | Value |
|---|---|
| format | comma-separated host names, trimmed, lowercased, a trailing dot stripped |
| matching | exact, portless |
| default | empty, which means loopback only |
| does it weaken the write checks | no: Origin and Sec-Fetch-Site still apply to a listed host |

Listing a name admits that origin's own pages, not the web at large. The trailing
dot is stripped because a tailnet DNSName is reported fully qualified
(`host.tail1234.ts.net.`) while a Host header never carries the root dot. See
[phone.md](phone.md) for the `tailscale serve` case this exists for.

## Export containment

Every export target must resolve inside the container's `artifacts/`
(`src/export/index.ts`).

| Input | Result |
|---|---|
| omitted | a slug of the document title, inside `artifacts/` |
| a relative path | resolved under `artifacts/` |
| an absolute path already inside `artifacts/` | accepted |
| `../` escaping, a symlink pointing out, an absolute path elsewhere | 400 |

Containment is checked on the **realpath of both sides**, never on a string prefix
of the raw input, which is what makes the symlink case a refusal rather than a
near miss. Bytes are written before the `export` event is appended, so a failed
write can leave a stray file but never an event that names a file that is not
there.

## Length caps

The event log is append-only and is never truncated, so an unbounded string on
any write endpoint is permanent growth in the source of truth.

| Cap | Value | Applies to |
|---|---|---|
| `MAX_ID_LEN` | 256 | session, document, block, comment, attachment, revision ids |
| `MAX_PATH_LEN` | 4,096 | `source_path`, export targets |
| `MAX_TEXT_LEN` | 65,536 | comment text, block content, turn summaries |
| `MAX_TITLE_LEN` | 1,024 | session and document titles |
| `MAX_TOKEN_LEN` | 4,096 | relative positions, timestamps |
| `MAX_REQUEST_BODY_BYTES` | 32 MiB | the whole request body, enforced by `Bun.serve` |

The character caps count UTF-16 code units, so 65,536 characters admits roughly
192 KiB of UTF-8 in the worst case. That is deliberate: the cap exists to bound
growth, and the byte-level bound is the request cap. Every surface takes the same
caps: HTTP, the MCP tool input schemas, and the `maxlength` on form controls in
the browser, which reads the number from the generated contract file.

## Other things worth stating plainly

| Thing | State |
|---|---|
| `POST /api/sessions` | does not exist. Creating a session names a local path, so the browser cannot do it |
| `agent_coop_cancel` | does not exist. Cancelling a turn is user-side only, so a turn cannot be dropped off the record from Claude's side |
| static serving | rejects path traversal before touching the filesystem, then falls back to `index.html` |
| database backups | full copies in `history/`, capped at 10, containing everything the database contains |
| `data/server.log` | plain text, holds the server's output including errors |
| audio | not implemented in v1; the transcription worker does not exist |

## Rules

1. Do not bind agent-coop to `0.0.0.0`, and do not port-forward it.
2. Do not put it behind a public reverse proxy. `AGENT_COOP_ALLOWED_HOSTS` is for a
   private network, and adding a name there grants full read and write.
3. Treat `data/`, `artifacts/` and `history/` as containing everything ever
   written in a session.
4. If agent-coop ever needs to be reachable from outside a tailnet, it needs
   authentication first, and it has none.

---

Next: [phone.md](phone.md). Back to [how-it-works.md](how-it-works.md).
