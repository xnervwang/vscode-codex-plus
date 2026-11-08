#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Say so, once, when a turn starts working and no row of the work plan is `doing`.

The injection asks for `doing` at the start of every turn, and a turn that keeps the plan only as bookkeeping before
its closing summary leaves the tree beside the conversation showing nothing being worked on for the whole time the work
runs - the one time the state is any use. So this speaks at the moment the work starts rather than at either end of the
turn.

Codex has no event after a batch of tool calls, so this runs after every one (PostToolUse) and keeps its count in the
turn mark the injection hook left (see plan_path.py). It speaks only when all of these hold:
  - this is the main thread, not a sub-agent;
  - the turn has made at least remindMinCalls calls or changed at least nudgeMinChanges things, not counting the
    plan's own;
  - no row is `doing`;
  - it has not already spoken in this turn.

It refuses nothing and does not guess which row is being worked on: that is a judgement about the work, which a script
cannot make. Without the turn mark there is nothing to go on, and it stays silent.
"""
import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from changes import changes
from plan_path import MCP_SERVER, MCP_TOOLS, any_in, plan_file, read_payload, read_turn, settings, write_turn


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def keeps_plan(payload, name):
    """A call that names the plan, or goes to the plan's own tools, is the plan being kept, not the work it describes."""
    tool = str(payload.get("tool_name") or "")
    if MCP_SERVER in tool:
        return True
    return name in json.dumps(payload.get("tool_input"), ensure_ascii=False, default=str)


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict) or payload.get("agent_id"):
        return 0
    path = plan_file(payload)
    if not path or keeps_plan(payload, os.path.basename(path)):
        return 0
    prompt = payload.get("turn_id")
    if not isinstance(prompt, str) or not prompt:
        return 0
    turn = read_turn(path)
    if not turn or turn.get("prompt") != prompt or turn.get("reminded") or turn.get("settled"):
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    turn["calls"] = count(turn.get("calls")) + 1
    turn["changes"] = count(turn.get("changes")) + int(changes(payload.get("tool_name"), payload.get("tool_input")))
    if turn["calls"] < limits["remindMinCalls"] and turn["changes"] < limits["nudgeMinChanges"]:
        write_turn(path, turn)
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        return 0
    if not isinstance(plan, dict):
        return 0
    if any_in(plan.get("nodes"), "doing"):
        turn["settled"] = True
        write_turn(path, turn)
        return 0
    turn["reminded"] = True
    # A mark that cannot be written would make this speak after every call for the rest of the turn, which is the one
    # outcome worth avoiding; silence is the safe side.
    if not write_turn(path, turn):
        return 0
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": (
            "This turn has started working, and no row of the work plan is `doing`. Mark the one you are working on "
            "before going on with %s (plan=%s): set_row with state doing, or add_row with state doing if this is new "
            "work the user asked for or something they asked you to look into. The tree beside this conversation "
            "shows `doing` while the work runs, which is the only time it is any use. This is said once per turn."
            % (MCP_TOOLS, path)),
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
