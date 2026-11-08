#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Turn a direct write to the work plan file into a pointer to the plan's own tools.

Codex's sandbox lets a shell command or a patch write only the workspace and the temporary directory, and the plan lives
under CODEX_HOME. A write there therefore stops for an approval, and whoever approves it has no way to see that the same
change was one tool call away. The row tools also keep what a direct write does not: the clock read for `since`, the
lock against another writer, and the limits on a description and a question.

So a patch that touches a plan file, or a shell command that writes into the plan directory, is refused before it asks,
with the tool to use instead. Reading the plan - `cat`, `sed -n`, `jq` - is left alone: it needs no approval, and it is
how the plan is read after a compaction.
"""
import json
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from changes import shell_command
from plan_path import MCP_TOOLS, PLUGIN_DIR_NAME, read_payload, settings


def shell_targets(command):
    """What a shell command writes to: redirect targets, tee's files, and the whole argument list of a command that
    changes files in place (cp, mv, rm, touch, sed -i, ...). Over-inclusive on purpose for the last kind: one of those
    commands naming the plan directory anywhere is taken as writing into it."""
    out = [m.group(1) for m in re.finditer(r"(?:^|[\s;&|(])\d?>>?\s*([^\s|;&)]+)", command)]
    out += [m.group(1) for m in re.finditer(r"\btee\s+(?:-a\s+)?([^\s|;&]+)", command)]
    out += [m.group(0) for m in re.finditer(r"\b(?:cp|mv|rm|touch|truncate|install|ln|sed\s+-i)\s[^|;&\n]*", command)]
    out += [m.group(1) for m in re.finditer(r"open\(\s*['\"]([^'\"]+)['\"]\s*,\s*(?:mode\s*=\s*)?['\"][^'\"]*[wax]", command)]
    return out


def writes_plan(tool, tool_input):
    text = json.dumps(tool_input, ensure_ascii=False, default=str) if not isinstance(tool_input, str) else tool_input
    if PLUGIN_DIR_NAME not in text:
        return False
    if tool in ("apply_patch", "Write", "Edit"):
        return True
    if tool == "Bash":
        command = shell_command(tool_input)
        # The row command itself, run by hand, is how a person keeps the plan without the tools; let it ask.
        if "plan-row.py" in command:
            return False
        return any(PLUGIN_DIR_NAME in t for t in shell_targets(command))
    return False


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict) or not settings()["enabled"]:
        return 0
    if not writes_plan(str(payload.get("tool_name") or ""), payload.get("tool_input")):
        return 0
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            "This writes the work plan file directly, which the sandbox would stop for an approval. Use %s instead: "
            "they need no approval and keep the plan's times and limits. To change a title or move a row, which the "
            "tools do not do, ask the user to edit the file." % MCP_TOOLS),
    }}))
    return 0


def selftest():
    plan = "/home/u/.codex/plugins/data/%s/01a1b8e8-f7e2-7251-95a9-a95b65992849.json" % PLUGIN_DIR_NAME
    cases = [
        ("apply_patch", "*** Begin Patch\n*** Update File: %s\n" % plan, True),
        ("Bash", {"command": "cat %s" % plan}, False),
        ("Bash", {"command": "jq . %s > /tmp/x" % plan}, False),
        ("Bash", {"command": "python3 -c \"open('%s','w').write('{}')\"" % plan}, True),
        ("Bash", {"command": "echo '{}' > %s" % plan}, True),
        ("Bash", {"command": "python3 /x/hooks/plan-row.py %s set 1 done" % plan}, False),
        ("Bash", {"command": "echo hi > /tmp/other"}, False),
        ("Bash", {"command": "cp /tmp/x %s" % plan}, True),
        ("Bash", {"command": "sed -n 1,5p %s" % plan}, False),
        ("Bash", {"command": "cat %s | tee %s.bak" % (plan, plan)}, True),
        ("apply_patch", "*** Begin Patch\n*** Update File: src/a.py\n", False),
    ]
    bad = 0
    for tool, given, want in cases:
        got = writes_plan(tool, given)
        if got != want:
            bad += 1
        print("%-4s %s %s" % ("PASS" if got == want else "FAIL", tool, str(given)[:70].replace("\n", " ")))
    print("all checks pass" if not bad else "%d checks FAILED" % bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
