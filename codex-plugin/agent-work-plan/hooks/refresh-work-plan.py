#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Before an automatic compaction, ask for the descriptions of the `doing` rows to be brought up to date.

A compaction replaces the conversation with a summary, and a summary keeps coverage rather than emphasis. What the next
turn needs in order to carry on is narrower than that and has to be written for that moment: for each row being worked
on, the exact next step, what not to do, and the user's own words that are written nowhere else. The `detail` of the
row is where that goes, and the plan is what gets read after the compaction (see resume-work-plan.py).

How full the context is never reaches the model, so this measures it from the rollout: every model call ends with a
token_count event carrying the input tokens it sent and the model's context window. Codex compacts on its own once a
call would pass 90% of the model's full window, and the window it reports has 5% already held back, so the compaction
line is 0.9 / 0.95 of the reported window, or the user's own model_auto_compact_token_limit when that is lower. The
marks are fractions of that line.

It speaks once per mark per stretch between compactions: after each tool call (PostToolUse, as added context) or at the
end of a turn (Stop, which keeps the turn going for one more step). A drop in context well below the lowest mark means a
compaction happened, and the marks are armed again.
"""
import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import (MCP_TOOLS, WATERMARK_SUFFIX, children, context_window, current_context, latest_reply_matches,
                       listed, open_tail, plan_file, read_payload, settings, side_file, write_quietly)

# The share of the compaction line at which each request is made. Two, so that a turn that blows past the first in one
# long tool call still gets the second before the line.
MARKS = (0.70, 0.85)
COMPACT_SHARE = 0.9 / 0.95


def compaction_line(window, limit=0):
    """Where Codex compacts: 90% of the full window, or the user's own limit when that is lower."""
    line = int(window * COMPACT_SHARE)
    return min(line, int(limit)) if limit and limit > 0 else line


def doing_rows(nodes, prefix=""):
    out = []
    for i, node in enumerate(listed(nodes)):
        if not isinstance(node, dict):
            continue
        num = (prefix + "." if prefix else "") + str(i + 1)
        if node.get("state") == "doing":
            out.append((num, str(node.get("title") or "")))
        out.extend(doing_rows(children(node), num))
    return out


def read_state(path):
    try:
        with open(side_file(path, WATERMARK_SUFFIX), encoding="utf-8") as fh:
            state = json.load(fh)
        return state if isinstance(state, dict) else {}
    except Exception:
        return {}


def due_mark(state, context, line):
    """The highest mark `context` has passed that has not been spoken about since the last compaction, or None; and
    the state to keep."""
    spoken = [m for m in state.get("spoken", []) if isinstance(m, (int, float))]
    if context < MARKS[0] * line * 0.5:
        spoken = []
    passed = [m for m in MARKS if context >= m * line]
    fresh = [m for m in passed if m not in spoken]
    keep = {"spoken": sorted(set(spoken) | set(passed)), "context": context}
    return (max(fresh) if fresh else None), keep


def message(mark, context, line, rows, path):
    shown = "; ".join("%s. %s" % (num, title[:60]) for num, title in rows[:6]) + ("; ..." if len(rows) > 6 else "")
    return ("The context is at %d%% of the point where Codex compacts it on its own (%d of about %d tokens). Before "
            "that happens, give every row that is `doing` a description written for whoever picks it up after the "
            "compaction: the exact next step, anything not to do, and the user's own words that are written nowhere "
            "else. Use set_row with detail (%s, plan=%s). Rows now `doing`: %s. Then carry on with the work."
            % (round(100 * context / line), context, line, MCP_TOOLS, path, shown))


def main():
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict) or payload.get("agent_id") or payload.get("stop_hook_active"):
        return 0
    event = payload.get("hook_event_name")
    if event not in ("PostToolUse", "Stop"):
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        return 0
    rows = doing_rows(plan.get("nodes") if isinstance(plan, dict) else None)
    tail = open_tail(payload.get("transcript_path"))
    context, window = current_context(tail), context_window(tail)
    if not context or not window:
        return 0
    line = compaction_line(window, limits["compactTokenLimit"])
    mark, keep = due_mark(read_state(path), context, line)
    # The state is written whether or not anything is said, so a mark passed while no row was `doing` is not raised
    # later about rows that started after it; and if it cannot be written, nothing is said, so this never repeats.
    if not write_quietly(side_file(path, WATERMARK_SUFFIX), json.dumps(keep)):
        return 0
    if mark is None or not rows:
        return 0
    if latest_reply_matches(tail, limits["quietWhenReplyMatches"], payload.get("last_assistant_message")):
        return 0
    text = message(mark, context, line, rows, path)
    if event == "Stop":
        print(json.dumps({"decision": "block", "reason": text}))
    else:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}}))
    return 0


def selftest():
    bad = []
    line = compaction_line(258400)
    check = lambda label, cond: (None if cond else bad.append(label), print("%-4s %s" % ("PASS" if cond else "FAIL", label)))
    check("the line is 90% of the full window", line == int(258400 / 0.95 * 0.9))
    check("a lower limit the user set is where Codex compacts", compaction_line(258400, 150000) == 150000)
    check("and a higher one changes nothing", compaction_line(258400, 400000) == line)
    m, keep = due_mark({}, int(0.5 * line), line)
    check("below the first mark nothing is due", m is None and keep["spoken"] == [])
    m, keep = due_mark(keep, int(0.72 * line), line)
    check("passing the first mark makes it due", m == 0.70)
    m, keep = due_mark(keep, int(0.80 * line), line)
    check("and it is not due again", m is None)
    m, keep = due_mark(keep, int(0.90 * line), line)
    check("the second mark is due once passed", m == 0.85)
    m, keep = due_mark(keep, int(0.10 * line), line)
    check("a compaction re-arms the marks", m is None and keep["spoken"] == [])
    m, keep = due_mark(keep, int(0.95 * line), line)
    check("one jump past both marks says the higher one", m == 0.85 and keep["spoken"] == [0.70, 0.85])
    print("all checks pass" if not bad else "%d checks FAILED" % len(bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
