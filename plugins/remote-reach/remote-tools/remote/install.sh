#!/bin/sh
# Install the remote-tools gate on this host, for one public key. Run as root on the remote:
#
#   sudo ./remote/install.sh ~/remote-tools_ed25519.pub
#
# It creates the agent-ops user (locked password, in the docker and systemd-journal groups when they exist),
# installs the gate as /usr/local/bin/remote-tools and the operations as /etc/remote-tools/ops.json, both owned by
# root, and writes agent-ops's authorized_keys, owned by root, with that key bound to the gate. Running it again
# installs the current files and replaces the key.
#
# --root DIR installs under DIR instead of / and skips the user, group and owner steps (the tests use it).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
root=""
if [ "${1:-}" = "--root" ]; then
  [ $# -ge 2 ] || { echo "usage: $0 [--root DIR] PUBLIC_KEY_FILE" >&2; exit 2; }
  root=$2
  shift 2
fi
[ $# -eq 1 ] || { echo "usage: $0 [--root DIR] PUBLIC_KEY_FILE" >&2; exit 2; }
user=agent-ops
home=/var/lib/agent-ops

# One plain public key line: type, base64 and an optional comment. Any options in it are refused, so the only
# options on the installed line are the ones written below.
key=$(cat "$1")
case "$key" in
  *"
"*) echo "refused: $1 must hold exactly one line" >&2; exit 1 ;;
esac
if ! printf '%s\n' "$key" | grep -Eq '^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._-]+)?$'; then
  echo "refused: $1 is not a plain public key line (type, key, optional comment)" >&2
  exit 1
fi

if [ -z "$root" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "refused: run as root (sudo)" >&2; exit 1; }
  [ -x /usr/bin/python3 ] || { echo "refused: /usr/bin/python3 is required" >&2; exit 1; }
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --home-dir "$home" --create-home --shell /bin/sh --comment "remote-tools gate" "$user"
  fi
  passwd -l "$user" >/dev/null
  for group in docker systemd-journal; do
    if getent group "$group" >/dev/null; then
      usermod -aG "$group" "$user"
    else
      echo "note: no $group group; the operations that need it will fail" >&2
    fi
  done
  set -- -o root -g root
else
  set --
fi

install -d -m 0755 "$@" "$root/usr/local/bin" "$root/etc/remote-tools" "$root$home/.ssh"

# Each file is written beside its target with its final owner and mode, then renamed over it, so sshd and the
# gate never read half a file. The gate runs with -I: no PYTHON* variables, no user site-packages, no script
# directory on sys.path.
gate=$root/usr/local/bin/remote-tools
ops=$root/etc/remote-tools/ops.json
keys=$root$home/.ssh/authorized_keys
trap 'rm -f "$gate.src" "$gate.new" "$ops.new" "$keys.src" "$keys.new"' EXIT
place() {  # place MODE SRC DEST [install owner flags...]
  mode=$1 src=$2 dest=$3
  shift 3
  install -m "$mode" "$@" "$src" "$dest.new"
  mv -f "$dest.new" "$dest"
}
sed '1s|.*|#!/usr/bin/python3 -I|' "$here/bin/remote-tools" > "$gate.src"
place 0755 "$gate.src" "$gate" "$@"
place 0644 "$here/ops.json" "$ops" "$@"
python3 -B "$gate" ops "$ops" >/dev/null

printf 'command="/usr/local/bin/remote-tools gate",restrict %s\n' "$key" > "$keys.src"
place 0644 "$keys.src" "$keys" "$@"

echo "installed: $gate, $ops, $keys"
