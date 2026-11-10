#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""The work plan's row command as an MCP server, so a change of row never needs a sandbox approval.

Codex runs shell commands in a sandbox that may write only the workspace and the temporary directory, and the plan lives
under CODEX_HOME. A row changed from the shell therefore stops for an approval every time, which is the one thing a
change of state must not cost. An MCP server is started by Codex itself, outside that sandbox, so the same change made
through one of its tools goes straight through.

It speaks MCP over standard input and output, one JSON-RPC message per line, and offers two tools that take the same
arguments as the row command. Every call is handed to plan-row.py's run(), so the rules for what a row may say live in
one place. A path it is given must be a plan file in this plugin's data directory of the Codex home the server was started
for, named by a thread id: the tools write only there.

A third tool, skill_search, only reads: it searches every installed skill with the words the model gives it
(skill_route.py), which reaches the skills Codex's own list shortens or leaves out.
"""
import importlib.util
import json
import os
import sys
import types

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import PLAN_NAME, PLUGIN_DIR_NAME, STATES, WAITING_ON, codex_home  # noqa: E402
import skill_route  # noqa: E402


def load_row_command():
    spec = importlib.util.spec_from_file_location("plan_row", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                           "plan-row.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROW = load_row_command()
PROTOCOL = "2025-06-18"

PLAN = {"type": "string", "description": "The plan file's absolute path, as the work plan block gives it at the start "
        "of the turn. Before the conversation has a plan, it is "
        "$CODEX_HOME/plugins/data/%s/$CODEX_THREAD_ID.json (CODEX_HOME defaults to ~/.codex)." % PLUGIN_DIR_NAME}
COMMON = {
    "note": {"type": "string", "description": "Replace the row's note; an empty string removes it."},
    "waiting_on": {"type": "string", "enum": list(WAITING_ON) + [""],
                   "description": "Who a waiting row waits on; an empty string removes it."},
    "question": {"type": "string", "description": "With waiting_on user: the one question the user has to answer."},
}
# What Codex's default approval mode reads: a tool that says it is neither destructive nor open-world runs without asking.
# Both hold here - a call changes or adds a row in this plugin's own plan file and nothing else, no tool deletes a row,
# and nothing leaves the machine - and it is the whole reason this server exists (see the module's docstring).
ANNOTATIONS = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False}
TOOLS = [
    {"name": "set_row", "description": "Put a row of this conversation's work plan in a state, or change its note, "
     "description, or who it waits on. The time is read from the clock.",
     "annotations": dict(ANNOTATIONS, title="Change a work plan row"),
     "inputSchema": {"type": "object", "required": ["plan", "row"], "additionalProperties": False, "properties": dict({
         "plan": PLAN,
         "row": {"type": "string", "description": "The number in front of the row, such as 3 or 2.1."},
         "state": {"type": "string", "enum": list(STATES), "description": "Leave it out to keep the row's state."},
         "detail": {"type": "string", "description": "Replace the row's description; an empty string removes it."},
     }, **COMMON)}},
    {"name": "add_row", "description": "Add a row to this conversation's work plan, at the end or under another row. "
     "Creates the plan file when the conversation has none.",
     "annotations": dict(ANNOTATIONS, title="Add a work plan row"),
     "inputSchema": {"type": "object", "required": ["plan", "state", "title"], "additionalProperties": False,
                     "properties": dict({
                         "plan": PLAN,
                         "state": {"type": "string", "enum": list(STATES)},
                         "title": {"type": "string"},
                         "under": {"type": "string", "description": "The row to add it under, such as 2."},
                     }, **COMMON)}},
    {"name": "skill_search", "description": "Search every skill installed for Codex by what you want to do, including "
     "skills that the skills list leaves out or cuts short. Write the query in your own words: rephrase the request, try "
     "synonyms, and turn a request made in another language into English keywords; when nothing fits, search again "
     "with other words. Returns each match's name, full description and SKILL.md path. Read a SKILL.md only if it fits "
     "the task.",
     "annotations": {"title": "Search the installed skills", "readOnlyHint": True, "destructiveHint": False,
                     "idempotentHint": True, "openWorldHint": False},
     "inputSchema": {"type": "object", "required": ["query"], "additionalProperties": False, "properties": {
         "query": {"type": "string", "description": "What you are looking for, in words."},
         "count": {"type": "integer", "minimum": 1, "maximum": skill_route.SEARCH_COUNT_MAX,
                   "description": "How many skills to return; 5 when left out."},
         "cwd": {"type": "string", "description": "The working directory, so that the repository's own skills are "
                 "searched too."},
     }}},
]


class Refused(Exception):
    pass


def trusted_home():
    """The CODEX_HOME this server belongs to, fixed at start.

    An installed copy sits under <CODEX_HOME>/plugins/cache/..., which names its home whatever environment Codex gave
    the server; a copy run from anywhere else falls back to CODEX_HOME or ~/.codex."""
    here = os.path.realpath(os.path.abspath(__file__))
    parts = here.split(os.sep)
    for i in range(len(parts) - 2, 0, -1):
        if parts[i] == "plugins" and parts[i + 1] == "cache":
            return os.sep.join(parts[:i]) or os.sep
    return codex_home()


PLAN_DIR = os.path.realpath(os.path.join(trusted_home(), "plugins", "data", PLUGIN_DIR_NAME))


def plan_path(value):
    # Resolved, so neither a symbolic link nor a look-alike directory elsewhere passes for the plan directory: a server
    # outside the sandbox writes only the plans of the home it was started for.
    path = os.path.realpath(os.path.abspath(os.path.expanduser(str(value or ""))))
    if not PLAN_NAME.match(os.path.basename(path)) or os.path.dirname(path) != PLAN_DIR:
        raise Refused("%s is not a work plan file: a plan is <thread id>.json in %s." % (path, PLAN_DIR))
    return path


def search(args):
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        raise Refused("query is the words to search for, and it is empty.")
    count = args.get("count", 5)
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise Refused("count is a whole number of 1 or more, not %r." % (count,))
    cwd = args.get("cwd") if isinstance(args.get("cwd"), str) else ""
    return skill_route.search_text(PLAN_DIR, query, min(count, skill_route.SEARCH_COUNT_MAX), cwd)


def call(name, args):
    if not isinstance(args, dict):
        raise Refused("The arguments are not an object.")
    if name == "skill_search":
        return search(args)
    ns = types.SimpleNamespace(plan=plan_path(args.get("plan")), note=args.get("note"),
                               waiting_on=args.get("waiting_on"), question=args.get("question"))
    if name == "set_row":
        ns.action, ns.row, ns.state, ns.detail = "set", str(args.get("row") or ""), args.get("state"), args.get("detail")
        if ns.state is not None and ns.state not in STATES:
            raise Refused("state is one of %s, not %r." % (", ".join(STATES), ns.state))
    elif name == "add_row":
        ns.action, ns.state, ns.title, ns.under = "add", args.get("state"), str(args.get("title") or ""), args.get("under")
        ns.detail = None
        if ns.state not in STATES:
            raise Refused("state is one of %s, not %r." % (", ".join(STATES), ns.state))
        if ns.under is not None:
            ns.under = str(ns.under)
    else:
        raise Refused("There is no tool named %r." % name)
    try:
        return ROW.run(ns)
    except ROW.Refused as e:
        raise Refused(str(e))


def respond(msg):
    method = msg.get("method")
    if method == "initialize":
        return {"protocolVersion": (msg.get("params") or {}).get("protocolVersion") or PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "work_plan", "version": "1.0.0"},
                "instructions": "Changes rows of this conversation's work plan; the plan file's path is in the work "
                                "plan block at the start of each turn. skill_search searches every installed skill, "
                                "including the ones the skills list leaves out or cuts short."}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        params = msg.get("params") or {}
        try:
            text, error = call(params.get("name"), params.get("arguments") or {}), False
        except Refused as e:
            text, error = str(e), True
        except Exception as e:  # a bug here must not take the server down with it
            text, error = "The work plan tool failed: %s" % e, True
        return {"content": [{"type": "text", "text": text}], "isError": error}
    if method == "ping":
        return {}
    raise KeyError(method)


def main():
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if not isinstance(msg, dict) or "id" not in msg:
            continue
        reply = {"jsonrpc": "2.0", "id": msg["id"]}
        try:
            reply["result"] = respond(msg)
        except KeyError:
            reply["error"] = {"code": -32601, "message": "Method not found: %s" % msg.get("method")}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
