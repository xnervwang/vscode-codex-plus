#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Leave a mark while Codex asks the user to approve something, for the VS Code windows that cannot see the request.

Codex asks its client for an approval over the app-server connection and writes nothing about it to any file, so a VS Code
window sees only the requests of its own app-server. A conversation running in another window, or in Codex's own terminal
interface, waits for the user unseen. PermissionRequest runs in the Codex process that has the conversation, just
before the approval is asked for, so this hook marks the conversation there; the extension reads the marks
(src/waiting-marks.js).

A mark is waiting/<thread>.<key>.json beside the plans: <thread> is the conversation that asks (a sub-agent's own thread,
not the conversation that started it), <key> names the tool and what it runs, and the file holds
{"at": ms, "session", "thread", "turn", "tool"}. It is removed by the events that follow an approval: PostToolUse of the
same call once the tool has run, Stop, SubagentStop and Interrupt at the end of the thread's turn, and UserPromptSubmit,
which starts another turn. A denied call gets no PostToolUse, so its mark goes at the end of the turn, or sooner when the
window running the conversation sees the request answered.

The hook writes nothing to standard output and always exits 0, which Codex takes as no decision.
"""
import glob
import hashlib
import json
import os
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import SESSION_NAME, data_dir, read_payload, write_quietly

WAITING_DIR = "waiting"
CLEARS = ("PostToolUse", "Stop", "SubagentStop", "Interrupt", "UserPromptSubmit")


def thread_of(payload):
    for field in ("agent_id", "session_id"):
        value = str(payload.get(field) or "").strip()
        if SESSION_NAME.match(value):
            return value
    return ""


def key_of(tool, tool_input):
    """The key of one call, the same in PermissionRequest and PostToolUse, which share no call id: the tool and
    its command, or all its arguments except the description, which only the approval carries."""
    if isinstance(tool_input, dict) and isinstance(tool_input.get("command"), str):
        subject = tool_input["command"]
    elif isinstance(tool_input, dict):
        subject = json.dumps({k: v for k, v in tool_input.items() if k != "description"}, sort_keys=True, default=str)
    else:
        subject = json.dumps(tool_input, sort_keys=True, default=str)
    return hashlib.sha1(("%s\n%s" % (tool, subject)).encode("utf-8", "replace")).hexdigest()[:16]


def marks_of(directory, thread):
    return glob.glob(os.path.join(directory, WAITING_DIR, glob.escape(thread) + ".*.json"))


def remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def mark(directory, payload, thread, now):
    os.makedirs(os.path.join(directory, WAITING_DIR), exist_ok=True)
    key = key_of(str(payload.get("tool_name") or ""), payload.get("tool_input"))
    write_quietly(os.path.join(directory, WAITING_DIR, "%s.%s.json" % (thread, key)), json.dumps({
        "at": int(now * 1000), "session": str(payload.get("session_id") or ""), "thread": thread,
        "turn": str(payload.get("turn_id") or ""), "tool": str(payload.get("tool_name") or "")}) + "\n")


def clear(directory, payload, thread):
    event = payload.get("hook_event_name")
    if event == "PostToolUse":
        key = key_of(str(payload.get("tool_name") or ""), payload.get("tool_input"))
        remove(os.path.join(directory, WAITING_DIR, "%s.%s.json" % (thread, key)))
        return
    turn = str(payload.get("turn_id") or "")
    for path in marks_of(directory, thread):
        # A message the user sends into the running turn does not answer the approval that turn is waiting on.
        if event == "UserPromptSubmit" and turn:
            try:
                with open(path, encoding="utf-8") as fh:
                    if json.load(fh).get("turn") == turn:
                        continue
            except Exception:
                pass
        remove(path)


def handle(payload, directory, now=None):
    if not isinstance(payload, dict):
        return
    thread = thread_of(payload)
    if not thread:
        return
    event = payload.get("hook_event_name")
    if event == "PermissionRequest":
        mark(directory, payload, thread, time.time() if now is None else now)
    elif event in CLEARS:
        clear(directory, payload, thread)


def main():
    try:
        handle(read_payload(), data_dir())
    except Exception:
        pass
    return 0


def selftest():
    import shutil
    import tempfile
    root = tempfile.mkdtemp()
    bad = 0

    def check(what, got, want):
        nonlocal bad
        if got != want:
            bad += 1
        print("%-4s %s%s" % ("PASS" if got == want else "FAIL", what, "" if got == want else ": got %r, want %r" % (got, want)))

    main_id, sub_id = "01a1b8e8-f7e2-7251-95a9-a95b65992849", "01a1b8e8-f7e2-7251-95a9-a95b6599284a"
    listed = lambda: sorted(os.path.basename(p) for p in glob.glob(os.path.join(root, WAITING_DIR, "*.json")))
    ask = {"hook_event_name": "PermissionRequest", "session_id": main_id, "turn_id": "t1", "tool_name": "Bash",
           "tool_input": {"command": "make test", "description": "Run the tests outside the sandbox"}}
    try:
        handle(ask, root, now=1000.0)
        check("PermissionRequest leaves one mark, named by the thread", [n.split(".")[0] for n in listed()], [main_id])
        with open(glob.glob(os.path.join(root, WAITING_DIR, "*.json"))[0], encoding="utf-8") as fh:
            check("the mark says when, which turn and which tool", json.load(fh),
                  {"at": 1000000, "session": main_id, "thread": main_id, "turn": "t1", "tool": "Bash"})
        handle(dict(ask, hook_event_name="PostToolUse", tool_input={"command": "make lint"}), root)
        check("PostToolUse of another call leaves it", len(listed()), 1)
        handle(dict(ask, hook_event_name="PostToolUse", tool_input={"command": "make test"}, tool_use_id="c1"), root)
        check("PostToolUse of the same command, without the description, takes it away", listed(), [])
        handle(dict(ask, agent_id=sub_id, agent_type="worker"), root)
        handle(ask, root)
        check("a sub-agent's request is marked under the sub-agent's own thread", sorted(n.split(".")[0] for n in listed()), [main_id, sub_id])
        handle({"hook_event_name": "Stop", "session_id": main_id, "turn_id": "t1"}, root)
        check("Stop takes away the marks of its own thread only", [n.split(".")[0] for n in listed()], [sub_id])
        handle({"hook_event_name": "SubagentStop", "session_id": main_id, "agent_id": sub_id, "turn_id": "t9"}, root)
        check("SubagentStop takes away the sub-agent's", listed(), [])
        handle(ask, root)
        handle({"hook_event_name": "UserPromptSubmit", "session_id": main_id, "turn_id": "t1", "prompt": "also"}, root)
        check("a message sent into the same turn leaves the mark", len(listed()), 1)
        handle({"hook_event_name": "UserPromptSubmit", "session_id": main_id, "turn_id": "t2", "prompt": "next"}, root)
        check("the next turn's first message takes it away", listed(), [])
        handle(ask, root)
        handle({"hook_event_name": "Interrupt", "session_id": main_id, "turn_id": "t1"}, root)
        check("Interrupt takes it away", listed(), [])
        handle(dict(ask, session_id="../../etc"), root)
        handle(dict(ask, tool_input="*** Begin Patch"), root)
        check("a session id that is not one is ignored; a tool input that is not an object is keyed as it is",
              [n.split(".")[0] for n in listed()], [main_id])
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("all checks pass" if not bad else "%d checks FAILED" % bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
