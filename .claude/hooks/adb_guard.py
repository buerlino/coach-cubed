#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""PreToolUse hook for Bash (.claude/settings.json): coach's phone is 4d42e62f and nothing else.

Blocks, with exit code 2 and the reason on stderr (Claude Code shows it to the model):
- any command that names HA24BZ2Y, the tablet pascaline's night shifts run on;
- an ANDROID_SERIAL set to anything but 4d42e62f or the pipeline's coach-no-device;
- an adb call that doesn't start with `-s 4d42e62f`, except `adb devices`, `version`, `help` and `start-server`,
  which touch no device; and kill-server, connect, disconnect or a server option even with the phone named.

The command is split into simple commands (`;`, `&&`, `||`, `|`, `&`, subshells, `$( )`, backticks, newlines), and an
adb counts only in command position, after variable assignments and wrappers such as `timeout 60` or `nice -n 19`;
`bash -c` and `eval` strings are checked the same way. Scripts that call adb themselves are not seen here: theirs name
the phone (pipeline/stay-awake.sh), and the pipeline's ANDROID_SERIAL covers the rest. docs/pipeline.md, "The phone".
"""
import json
import re
import shlex
import sys

PHONE = "4d42e62f"
TABLET = "HA24BZ2Y"
SERIALS_OK = {PHONE, "coach-no-device"}
NO_DEVICE_ARGS = {"devices", "version", "help", "start-server"}
SERVER_WIDE = {"kill-server", "connect", "disconnect", "-H", "-P", "-L"}
SEPARATORS = {";", ";;", "&&", "||", "|", "|&", "&", "(", ")"}
# wrappers whose options (and numeric arguments) come before the command they run
WRAPPERS = {"timeout", "nice", "ionice", "nohup", "setsid", "exec", "command", "sudo", "env", "time", "stdbuf",
            "xargs", "watch", "chrt", "taskset"}
TAKES_VALUE = {"-u", "--unset", "-C", "--chdir", "-I", "-n", "-c", "-k", "-s", "--signal", "--kill-after"}
SHELLS = {"bash", "sh", "dash", "zsh"}


def simple_commands(cmd):
    """Yield the token lists of the simple commands in a shell command line (approximate, never executes)."""
    text = cmd.replace("`", " ; ").replace("\n", " ; ")
    lex = shlex.shlex(text, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        tokens = list(lex)
    except ValueError:  # an unbalanced quote: fall back to plain words
        tokens = text.split()
    current = []
    for tok in tokens:
        if tok in SEPARATORS:
            if current:
                yield current
            current = []
        else:
            current.append(tok)
    if current:
        yield current


def program(tokens):
    """The command a simple command runs and its arguments, past assignments and wrappers."""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == "$" or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            i += 1
        elif tok.rsplit("/", 1)[-1] in WRAPPERS:
            i += 1
            while i < len(tokens) and (tokens[i].startswith("-") or re.match(r"^\d+(\.\d+)?[smhd]?$", tokens[i])
                                       or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[i])):
                i += 2 if tokens[i] in TAKES_VALUE and i + 1 < len(tokens) else 1
        else:
            return tok.rsplit("/", 1)[-1], tokens[i + 1:]
    return None, []


def check(cmd, depth=0):
    """None when the command may run, else the reason it may not."""
    if TABLET.lower() in cmd.lower():
        return (f"{TABLET} is the tablet pascaline's night shifts run on; coach never names it, not even to read "
                f"its state. coach's phone is {PHONE} (docs/pipeline.md, \"The phone\").")
    for m in re.finditer(r"ANDROID_SERIAL=([^\s;&|)]*)", cmd):
        value = m.group(1).strip("'\"")
        if value and value not in SERIALS_OK:
            return f"ANDROID_SERIAL may only be {PHONE} in coach (this sets it to {value!r})."
    for tokens in simple_commands(cmd):
        prog, args = program(tokens)
        if prog in SHELLS or prog == "eval":
            inner = args
            if prog in SHELLS:
                flags = [k for k, a in enumerate(args) if re.match(r"^-[a-z]*c[a-z]*$", a)]
                inner = args[flags[0] + 1:flags[0] + 2] if flags else []
            if inner and depth < 3:
                reason = check(" ".join(inner), depth + 1)
                if reason:
                    return reason
            continue
        if prog != "adb":
            continue
        if args[:1] and args[0] in NO_DEVICE_ARGS:
            continue
        shown = " ".join(args)
        if args[:2] != ["-s", PHONE]:
            if args[:1] == ["-s"] and len(args) > 1:
                return f"adb may only reach {PHONE}, not {args[1]!r}: run `adb -s {PHONE} {' '.join(args[2:])}`."
            return (f"every adb command names the phone: run `adb -s {PHONE} {shown}` "
                    f"(a bare adb reaches whatever is attached, at night pascaline's tablet).")
        bad = SERVER_WIDE.intersection(args[2:])
        if bad:
            return f"adb {' '.join(sorted(bad))} acts on the adb server other projects share: not from coach."
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    cmd = (data.get("tool_input") or {}).get("command")
    if data.get("tool_name", "Bash") != "Bash" or not isinstance(cmd, str):
        return 0
    reason = check(cmd)
    if reason:
        print(f"adb guard (.claude/hooks/adb_guard.py): {reason}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
