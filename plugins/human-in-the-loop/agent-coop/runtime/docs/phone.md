# Reaching agent-coop from a phone

- **A tailnet is the only supported way.** Agent Coop binds loopback and has no
  authentication, so the tailnet is what stands in for a login.
- **Two things are needed, not one:** `tailscale serve` in front of the port, and
  the tailnet name listed in `AGENT_COOP_ALLOWED_HOSTS`. Without the second,
  every request returns 403.
- **Plain HTTP over the tailnet is enough today**, because nothing in the v1 UI
  needs a secure browser context.
- Anyone on your tailnet who reaches the URL has full read and write. Read
  [security.md](security.md) first.

## Why the second step exists

`tailscale serve` is a reverse proxy: it forwards the request with the **tailnet
name** as the `Host` header, not `localhost`. Agent Coop's request guard requires
a loopback or listed Host on every method. An unlisted name is refused even
when loading the UI or reading a document.

`AGENT_COOP_ALLOWED_HOSTS` is the one seam that admits a non-loopback Host. The Origin
and Sec-Fetch-Site checks still apply to writes on a listed name, so listing it admits that
origin's own pages and nothing else.

## Setup

Find the machine's tailnet DNS name:

```
tailscale status --json
```

Read `Self.DNSName`. It is fully qualified with a trailing dot, like
`example-host.example.invalid.`. The trailing dot is stripped when
`AGENT_COOP_ALLOWED_HOSTS` is parsed, so either form works.

Start agent-coop with that name allowed:

```
AGENT_COOP_ALLOWED_HOSTS=example-host.example.invalid bun run scripts/up.ts
```

Put `tailscale serve` in front of the port, on plain HTTP:

```
tailscale serve --bg --http=80 localhost:4317
```

Then open `http://example-host.example.invalid/` on the phone. Replace the example
name with `Self.DNSName`. The session URL is the
same path `up.ts` printed, with the tailnet name in place of `localhost:4317`.

| Command | Does |
|---|---|
| `tailscale serve status` | show what is currently proxied |
| `tailscale serve --http=80 off` | stop proxying |

Only `http://127.0.0.1` backends are supported by `tailscale serve`, which is
exactly what agent-coop binds.

## HTTPS

`tailscale serve <port>` with no `--http` serves over HTTPS on 443 and needs
HTTPS certificates enabled on the tailnet; the interactive CLI flow enables them
if they are not already on.

You do not need it for agent-coop v1. The reasons to turn it on anyway:

| Reason | State |
|---|---|
| a real certificate instead of a browser warning | true today |
| browser features that require a secure context (microphone, clipboard) | **applies today**: voice input for comments needs the microphone, and `getUserMedia` is scoped to secure contexts |

Voice INPUT is the one feature this gates. It works on the laptop over
`localhost`, which browsers treat as secure regardless of HTTPS, but it does
**not** work on a phone over plain HTTP on the tailnet: `getUserMedia` requires
a secure context, so a phone cannot record into agent-coop until HTTPS is turned on
here. Typed comments are unaffected either way. Voice OUTPUT is not affected and
works today: playing a narration from an `<audio>` tag needs no secure context,
which is why the turn-note audio reached the phone before any of this was
arranged.

## When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| every request returns 403, including the page | tailnet name not in `AGENT_COOP_ALLOWED_HOSTS` | restart agent-coop with it set; the variable is read at `serve()` time |
| `requests must address a loopback or allowed host, not <name>` | the same, stated by the server | as above |
| nothing loads at all | `tailscale serve` is not running, or agent-coop is not on the port | `tailscale serve status`, then `bun run scripts/up.ts` |
| a second name works, the first does not | matching is exact and portless | list every name you use, comma-separated |

---

Back to [security.md](security.md) or [install.md](install.md).
