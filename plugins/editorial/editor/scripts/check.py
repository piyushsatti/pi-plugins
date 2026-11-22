#!/usr/bin/env python3
"""Mechanical checks for a draft: leaks and hard wrapping. Prints findings; exit 1 if any."""

import ipaddress
import re
import sys
from pathlib import Path

PUBLIC_EMAIL = re.compile(
    r"@users\.noreply\.github\.com$|@example\.(com|org|net)$", re.IGNORECASE
)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SECRET = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}"
    r"|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})"
    r"|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}",
    re.IGNORECASE,
)
IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
INTERNAL_HOST = re.compile(
    r"\b[\w-]+(?:\.[\w-]+)*\.(?:internal|local|lan|corp|intranet|ts\.net)\b",
    re.IGNORECASE,
)
DIGITS = re.compile(r"\b\d(?:[ -]?\d){11,18}\b")
FENCE = re.compile(r"^\s*(```|~~~)")
BLOCK_START = re.compile(r"^\s*([-*+>|#]|\d+[.)]\s)")


def private_ip(text):
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


def line_findings(number, line):
    for match in EMAIL.finditer(line):
        if not PUBLIC_EMAIL.search(match.group()):
            yield number, "email", match.group()
    for match in SECRET.finditer(line):
        yield number, "secret", match.group()[:12] + "..."
    for match in IPV4.finditer(line):
        if private_ip(match.group()):
            yield number, "private-ip", match.group()
    for match in INTERNAL_HOST.finditer(line):
        yield number, "internal-host", match.group()
    for match in DIGITS.finditer(line):
        yield number, "long-number", match.group()


def wrap_findings(lines):
    in_fence = False
    previous = ""
    front_matter = bool(lines) and lines[0].strip() == "---"
    for number, line in enumerate(lines, 1):
        if front_matter:
            front_matter = number == 1 or line.strip() != "---"
            continue
        if FENCE.match(line):
            in_fence = not in_fence
            previous = ""
            continue
        prose = (
            not in_fence
            and line.strip()
            and not BLOCK_START.match(line)
            and not line.startswith(("    ", "\t"))
        )
        if (
            prose
            and previous
            and not previous.rstrip().endswith((".", ":", "!", "?", "|", "  "))
        ):
            yield number, "hard-wrap", "paragraph continues from the line above"
        previous = line if prose else ""


def check(text):
    lines = text.splitlines()
    findings = [f for n, line in enumerate(lines, 1) for f in line_findings(n, line)]
    findings += list(wrap_findings(lines))
    return sorted(findings)


def main(paths):
    if not paths:
        print("usage: check.py FILE...", file=sys.stderr)
        return 2
    found = False
    for path in paths:
        for number, kind, detail in check(Path(path).read_text(encoding="utf-8")):
            found = True
            print(f"{path}:{number}: {kind}: {detail}")
    if not found:
        print("no findings")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
