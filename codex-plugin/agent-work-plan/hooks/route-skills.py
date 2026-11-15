#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""UserPromptSubmit and Stop hook of the skill search.

On UserPromptSubmit it searches the skill index (skill_route.py) for the message and puts the best few in front of the
model, each with its full description and the path of its SKILL.md. A message under six characters gets nothing. The
whole run, network included, is held to 1.5 seconds, and anything that goes wrong leaves the turn with the keyword
results or with nothing.

On Stop it reads the turn back from the rollout and logs which SKILL.md files its tool calls named, so the log shows
whether the model read the skills it was given.
"""
import time

T0 = time.time()  # the budget counts from here, so that loading the modules below is inside it

import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import (COMPACTED_SUFFIX, data_dir, open_tail, plan_file, read_payload, settings, side_file,  # noqa: E402
                       write_quietly)
import skill_route as route  # noqa: E402

"""Skills given earlier in the conversation.

ROUTED_SUFFIX beside the plan records, as name -> [path, description], the skills the conversation was given in full and
still has in its context. They are read from the transcript, where Codex writes each routing block as a developer
message when the block's turn starts, so a block whose prompt never reached the model is not there. Each turn reads only
the part of the transcript added since the previous turn. A compaction (the compaction hook's COMPACTED_SUFFIX mark, or
Codex's own compacted row) or a rollback (thread_rolled_back) empties the record, since both take earlier messages out
of the context.

When a skill this turn's search found is in the record with the same path and description, it is not given again.
ORDER_LINE then lists every skill found, in order of fit, and marks those with GIVEN_EARLIER; the others, including a
skill whose description has changed, are given in full. A turn that found nothing already given gets no ORDER_LINE, and
a sub-agent's thread is given every skill in full.

src/user-times.js takes the skill names from ORDER_LINE for the line under each reply.
"""
ROUTED_SUFFIX = ".routed"
ROUTED_FORMAT = 1
ORDER_LINE = "In order of fit: "
GIVEN_EARLIER = " (given earlier)"
ORDER_END = (". Those given earlier had their description and file given in full earlier in this conversation and are not "
             "repeated here.")
# Transcript read at most in one turn; past it, the record starts over and every skill is given in full.
READ_MAX = 64 << 20
FULL_LINE = re.compile(r"^- ([^\s:][^:]*(?::[^\s:][^:]*)?): (.*) \(file: (.+)\)$")
RESETS = ("compacted", "context_compacted", "thread_rolled_back")


def sub_agent(payload):
    """Whether the thread is a sub-agent's: the event says so, or its transcript's session_meta has a sub-agent source."""
    if payload.get("agent_id"):
        return True
    path = payload.get("transcript_path")
    if not isinstance(path, str) or not path:
        return False
    try:
        with open(path, "rb") as fh:
            row = json.loads(fh.readline(1 << 20))
        source = (row.get("payload") or {}).get("source") if row.get("type") == "session_meta" else None
    except Exception:
        return False
    return isinstance(source, dict) and "subagent" in source


def blocks_in(row):
    """The full lines of the routing blocks in one transcript row: [(name, path, description)]."""
    p = row.get("payload") if row.get("type") == "response_item" else None
    if not isinstance(p, dict) or p.get("type") != "message" or p.get("role") != "developer":
        return []
    out = []
    for part in p.get("content") if isinstance(p.get("content"), list) else []:
        text = part.get("text") if isinstance(part, dict) and isinstance(part.get("text"), str) else ""
        at = text.find(route.MARK)
        if at < 0:
            continue
        for line in text[at:].split("\n")[1:]:
            if line.startswith(ORDER_LINE):
                continue
            m = FULL_LINE.match(line)
            if not m:
                break
            out.append((m.group(1), m.group(3), m.group(2)))
    return out


def given_earlier(plan, transcript):
    """The record of ROUTED_SUFFIX, name -> [path, description], updated from the transcript and saved beside the
    plan."""
    if not plan or not isinstance(transcript, str) or not transcript:
        return {}
    compacted = ""
    try:
        with open(side_file(plan, COMPACTED_SUFFIX), encoding="utf-8") as fh:
            compacted = fh.read().strip()
    except Exception:
        pass
    try:
        with open(side_file(plan, ROUTED_SUFFIX), encoding="utf-8") as fh:
            kept = json.load(fh)
    except Exception:
        kept = {}
    if not isinstance(kept, dict) or kept.get("format") != ROUTED_FORMAT or kept.get("transcript") != transcript:
        kept = {}
    given = kept.get("given") if isinstance(kept.get("given"), dict) else {}
    offset = kept.get("offset") if isinstance(kept.get("offset"), int) else 0
    if kept.get("compacted", "") != compacted:
        given = {}
    try:
        size = os.path.getsize(transcript)
    except OSError:
        return {}
    if size < offset:
        given, offset = {}, 0
    if size - offset > READ_MAX:
        given, offset = {}, size
    data = b""
    if size > offset:
        try:
            with open(transcript, "rb") as fh:
                fh.seek(offset)
                data = fh.read(size - offset)
        except OSError:
            return {}
    end = data.rfind(b"\n") + 1
    for raw in data[:end].split(b"\n"):
        if not any(k.encode() in raw for k in RESETS) and route.MARK.encode() not in raw:
            continue
        try:
            row = json.loads(raw.decode("utf-8"))
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        if row.get("type") == "compacted" or (row.get("type") == "event_msg" and payload.get("type") in RESETS):
            given = {}
            continue
        for name, path, desc in blocks_in(row):
            given[name] = [path, desc]
    write_quietly(side_file(plan, ROUTED_SUFFIX), json.dumps(
        {"format": ROUTED_FORMAT, "transcript": transcript, "offset": offset + end, "compacted": compacted, "given": given},
        ensure_ascii=False))
    return given


def block(top, given):
    """The text for this turn's skills, and the names given in full and only named."""
    full = [s for s in top if given.get(s["name"]) != [s["path"], route.one_line(s["desc"]) or "(no description)"]]
    named = [s["name"] for s in top if s not in full]
    if not named:
        return route.render(top), [s["name"] for s in top], []
    order = ORDER_LINE + ", ".join(s["name"] + ("" if s in full else GIVEN_EARLIER) for s in top) + ORDER_END
    text = route.render(full, limit=route.CONTEXT_BYTES - len(order.encode("utf-8")) - 1)
    head, _, rest = text.partition("\n")
    return "\n".join([head, order] + ([rest] if rest else [])), [s["name"] for s in full], named


def submitted(payload, directory, given, t0):
    text = str(payload.get("prompt") or "").strip()
    ids = {"thread": str(payload.get("session_id") or ""), "turn": str(payload.get("turn_id") or "")}
    if len(text) < route.MIN_CHARS:
        route.log(directory, dict(ids, ev="skip", why="short"))
        return None
    home = route.home_of(directory)
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else ""
    conf = route.codex_config(home)
    index = route.load_index(directory)
    t_load = time.time()
    why = route.stale(index, home, cwd, given, directory, conf)
    if why and not route.writable(directory):
        # Nowhere to keep an index: build one for this turn alone, by keywords only.
        index = route.build(directory, home, cwd, given, embed_now=False, write=False)
        t_load = time.time()
    elif why:
        route.spawn_build(directory, cwd)
    if index is None:
        route.log(directory, dict(ids, ev="skip", why="the index is being built"))
        return None
    count = max(1, min(route.MAX_COUNT, int(given.get("skillRouteCount") or 5)))
    top, how, timings, failed = route.search(index, text, count, cwd, t0 + route.BUDGET, directory, given, conf)
    out, full, named = None, [], []
    if top:
        earlier = {} if sub_agent(payload) else given_earlier(plan_file(payload, directory), payload.get("transcript_path"))
        out, full, named = block(top, earlier)
    record = dict(ids, ev="inject", via=how, skills=[s["name"] for s in top], full=full, named=named,
                  ms=round((time.time() - t0) * 1000, 1), msLoad=round((t_load - t0) * 1000, 1),
                  msLocal=round(timings["local"], 1), msNet=round(timings["net"], 1))
    if failed:
        record["fellBack"] = failed[:160]
    if why:
        record["rebuild"] = why
    route.log(directory, record)
    return out


def stopped(payload, directory):
    tail = open_tail(payload.get("transcript_path"))
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else ""
    names, unknown = route.skills_read(tail, str(payload.get("turn_id") or ""), route.load_index(directory), cwd)
    record = {"thread": str(payload.get("session_id") or ""), "turn": str(payload.get("turn_id") or ""), "ev": "read",
              "skills": names}
    if unknown:
        record["unknown"] = unknown
    route.log(directory, record)


def main():
    t0 = T0
    try:
        payload = read_payload()
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    directory = data_dir()
    given = settings()
    if not given.get("skillRoute"):
        return 0
    event = payload.get("hook_event_name")
    try:
        if event == "Stop":
            stopped(payload, directory)
            return 0
        text = submitted(payload, directory, given, t0)
    except Exception as e:  # a bug here must never stop the turn
        route.log(directory, {"ev": "error", "why": "%s: %s" % (type(e).__name__, str(e)[:160])})
        return 0
    if text:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event or "UserPromptSubmit",
                                                 "additionalContext": text}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
