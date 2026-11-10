#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Give each turn the installed skills that best fit the user's message, and note afterwards which ones it read.

On UserPromptSubmit it searches the skill index (skill_route.py) for the message and puts the best few in front of the
model, each with its full description and the path of its SKILL.md. A message under six characters gets nothing. The
whole run, network included, is held to 1.5 seconds, and anything that goes wrong leaves the turn with the keyword
results or with nothing; it never stops the turn.

On Stop it reads the turn back from the rollout and writes down which SKILL.md files its tool calls named. Together the
two log lines say how often the model read what it was given. Neither holds the user's words.
"""
import time

T0 = time.time()  # the budget counts from here, so that loading the modules below is inside it

import json  # noqa: E402
import os  # noqa: E402
import sys  # noqa: E402

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plan_path import data_dir, open_tail, read_payload, settings  # noqa: E402
import skill_route as route  # noqa: E402


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
    record = dict(ids, ev="inject", via=how, skills=[s["name"] for s in top], ms=round((time.time() - t0) * 1000, 1),
                  msLoad=round((t_load - t0) * 1000, 1), msLocal=round(timings["local"], 1),
                  msNet=round(timings["net"], 1))
    if failed:
        record["fellBack"] = failed[:160]
    if why:
        record["rebuild"] = why
    route.log(directory, record)
    return route.render(top) if top else None


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
