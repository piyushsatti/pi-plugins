# remote-tools

remote-tools lets an agent look at a remote machine without being able to change it, and without getting a shell
there. It can read a container's logs, list containers, check a systemd unit, or see disk and memory use. It can't do
anything else, even if it's been talked into trying.

The lock is on the remote machine, not in the agent's harness. A dedicated ssh key may run only one program there:
the gate. The gate accepts only the operations in `ops.json` and refuses everything else. The plugin's MCP server is a
convenience on top: it shows the model each operation as a typed tool.

Everything is one Python 3 script with no dependencies, `bin/remote-tools`. It has two jobs: `remote-tools gate` on
the remote, and `remote-tools mcp` on your machine.

## Operations

| Operation | MCP tool | Runs on the host |
|---|---|---|
| `docker-ps` | `docker_ps` | `docker ps --all --format '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}}}'`. Only these five fields; commands and labels can hold secrets. |
| `docker-inspect` | `docker_inspect(container)` | `docker inspect --format '{{json .State}}' -- <container>`. Only the state, because a full inspect prints the container's environment, which often holds secrets. |
| `docker-logs` | `docker_logs(container, lines=200, since?)` | `docker logs --tail <lines> [--since <since>] -- <container>` |
| `service-status` | `service_status(unit)` | `systemctl status --no-pager --lines=0 -- <unit>` |
| `service-logs` | `service_logs(unit, lines=200)` | `journalctl --no-pager --lines <lines> --unit <unit>` |
| `host-health` | `host_health` | `uptime`, `df -h`, `free -h`, and `ps` sorted by CPU |

Every MCP tool also takes `host`, a name from `list_hosts`.

Parameters are typed:
- Container and unit names match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`, and a unit may also contain `@`. Neither can start with `-`.
- `lines` is an integer from 1 to 5000.
- `since` is a number and a unit, such as `30m` or `2h`.

Each operation has one timeout for all its commands (30 seconds by default) and a 1 MiB cap on each output stream.

## How a call flows

1. The model calls `docker_logs(host="example-host", container="web", lines=50)`.
2. The MCP server checks the arguments against `ops.json` and looks up `example-host` in the local allowlist. Then it
   runs `ssh -T -n -o BatchMode=yes … -- example-host-ops 'docker-logs container=web lines=50'`.
3. On the remote, sshd sees the remote-tools key. Its `authorized_keys` line forces the command
   `/usr/local/bin/remote-tools gate` and sets `restrict`, so there is no PTY and no port, agent or X11 forwarding.
   The gate reads what was asked for from `$SSH_ORIGINAL_COMMAND`.
4. The gate checks the request again against its own copy of the operations, `/etc/remote-tools/ops.json`, which
   root owns. The request is the operation's name followed by `key=value` pairs. Only letters, digits, spaces and
   `=._@:/-` are allowed, so quotes, `;`, `$()`, backticks and newlines are refused outright. Then the gate runs the
   operation's fixed argv:
   - with no shell;
   - with an environment it builds itself, including `PATH`;
   - under a timeout and an output cap.

   It logs the call to syslog under the tag `remote-tools`.
5. The output comes back with the exit status. The MCP server wraps stdout and stderr in `UNTRUSTED REMOTE` markers,
   each with a random token, and logs the call to `~/.local/state/remote-tools/audit.jsonl`.

If the gate refuses, it exits 126 and gives its reason on stderr. A timeout exits 124.

## Harness support

| Harness | Claimed | Works | Reduced | Missing |
|---|---|---|---|---|
| Claude Code | yes | The MCP tools. They're annotated read-only, so they're safe to allow without a prompt. | — | — |
| Codex | yes | The MCP tools. The annotations matter here: Codex refuses an unannotated tool under `codex exec`. | — | — |
| Cursor | yes | The MCP tools. | — | Unverified: whether `$HOME` expands in Cursor's MCP `command`. |

There are no hooks, so nothing has to be trusted in `/hooks`.

You don't need the plugin at all to use a host's gate. Plain `ssh example-host-ops 'docker-ps'` works from any shell.

## Install

### On each remote host (Ubuntu)

Make a dedicated key on your own machine, and use it only for this:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/remote-tools_ed25519 -C remote-tools
```

Copy this repo and the public key to the host, then run:

```bash
sudo ./remote/install.sh ~/remote-tools_ed25519.pub
```

It does five things:
- creates the `agent-ops` user with a locked password;
- adds `agent-ops` to `docker` and `systemd-journal` when those groups exist;
- installs the gate as `/usr/local/bin/remote-tools`, with `#!/usr/bin/python3 -I`;
- installs the operations as `/etc/remote-tools/ops.json`;
- writes `~agent-ops/.ssh/authorized_keys` with the one line below.

The gate, the operations and `authorized_keys` are all owned by root.

```
command="/usr/local/bin/remote-tools gate",restrict ssh-ed25519 AAAA… remote-tools
```

Running it again installs the current files and replaces the key.

### On your machine

Install the plugin from the `pi` marketplace:

```bash
claude plugin marketplace add piyushsatti/pi-plugins
claude plugin install remote-tools@pi
```

`install.json` lists what goes on the machine: `bin/remote-tools` to `~/.local/bin/` and `ops.json` to `~/.local/share/remote-tools/`. This repo has no deploy script yet, so copy those two files by hand.

Add an ssh alias for each host in `~/.ssh/config`:

```
Host example-host-ops
    HostName example-host.example.invalid
    User agent-ops
    IdentityFile ~/.ssh/remote-tools_ed25519
    IdentitiesOnly yes
```

Next, set up the allowlist:
- Copy `hosts.example.json` to `~/.local/state/remote-tools/hosts.json`.
- `chmod 600` it.
- Name each host and its alias.

Then check it:

```bash
remote-tools hosts                                   # the allowlist
ssh example-host-ops docker-ps                       # the gate answers
ssh example-host-ops 'bash -i'                       # refused (unknown_op), exit 126
```

## Adding an operation

Add an entry to `ops.json`, test it here, and run `install.sh` again on each host. An entry has:
- a description;
- typed `params` (`int` with `min`/`max`/`default`, or `text` with an anchored `pattern`; either can be `optional`);
- `run`, a list of argvs. Each argv starts with a literal program name. An item `{"param": "x"}` is replaced by x's
  value. Adding `"flag": "--x"` puts that flag before the value, or leaves both out when the parameter isn't given.

`remote-tools ops ops.json` checks the file, and the gate refuses the whole file if any entry is wrong. Keep
operations read-only: that's the promise the MCP annotations make. `tests/test_remote_tools.py` needs an exact-argv
case for each new operation, and fails until it has one.

## Threat model

**What it protects:** each remote host, against an agent whose tool calls are hostile, for example after a prompt
injection from a web page, a file or earlier remote output.

**What it trusts:**
- root on each host;
- `/etc/remote-tools/ops.json`;
- sshd;
- the programs the operations run.

What a hostile agent **can't** do with the remote-tools key:

- **Get a shell, copy files, or forward ports.** sshd runs the gate whatever was asked. `restrict` turns off the PTY
  and every kind of forwarding. `scp` and `sftp` are just requests the gate doesn't know.
- **Run anything not in `ops.json`, or pass an argument that isn't typed.** Values must match their pattern. They are
  placed as separate argv items after `--` where the program supports it, and never pass through a shell.
- **Change what's allowed.** The gate, the operations and `authorized_keys` belong to root. The gate checks that its
  operations file isn't writable by group or others.
- **Steer the gate through the environment.** The gate replaces the environment sshd passes on, `PATH` included. It
  starts with `python3 -I`, so `PYTHON*` variables and user site-packages are ignored.
- **Act unseen.** Every request, allowed or refused, goes to syslog on the host (`journalctl -t remote-tools`), and
  to the audit log on your machine when it came through the MCP server.

What it **doesn't** protect against. These are the residual risks:

- **Your other keys.** The gate only covers the remote-tools key. An agent that can run `ssh` with your personal key
  can still log in as you. Deny that path in each harness: allow `ssh <alias>-ops` and deny other `ssh` and `scp` to
  the same hosts. Better still, keep your personal key out of the agent's reach, for example in an ssh agent that
  asks before each use.
- **The `docker` group is root-equivalent.** `agent-ops` needs it for `docker logs`. If the gate were ever bypassed,
  that account could take over the host. That's why the gate is small, takes no shell, and is tested against
  injection.
- **What the output says.** Logs can contain secrets and instructions aimed at the model. Output is capped and
  marked untrusted, but nothing scrubs it.
- **The local side.** `~/.local/state/remote-tools/hosts.json` and the audit log are only as safe as that folder.
  `REMOTE_TOOLS_SSH` (meant for tests) replaces the ssh binary. Whoever controls the harness's MCP config controls
  both. None of this widens what the gate allows.

## Tests

```bash
python3 -B -m unittest discover -s tests -v
```

The tests cover:
- the gate's exact argv for every operation;
- about 40 refused requests (injection, unknown operations and parameters, bounds);
- the environment it passes on;
- timeouts;
- the MCP tools and their ssh argv;
- a round trip from the MCP server through a fake ssh into the real gate;
- the audit log;
- `install.sh` under `--root`.

Verification runs are in [VERIFIED.md](VERIFIED.md).
