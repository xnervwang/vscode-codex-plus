#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""The skill search (codex-plugin/agent-work-plan/hooks/skill_route.py and route-skills.py), case by case.

    python3 test/route/test_skill_route.py          every case, one line each
    python3 test/route/test_skill_route.py Vector   only the classes whose name contains "Vector"

test/parts/20b-skill-route.js runs it as part of the suite. Each case builds its own Codex home, home folder and plugin
data directory under a temporary folder, with every AWS and proxy variable taken out of the environment, so nothing
here reads the machine's own configuration or credentials. A local HTTP server stands in for Bedrock, reached through
AWS_ENDPOINT_URL_BEDROCK_RUNTIME, and the credential command is a script that prints made-up keys. Network
access, programs started and credential files opened are watched by guard/sitecustomize.py where a case says it never
touches them.
"""
import array
import contextlib
import datetime
import http.server
import io
import json
import math
import ntpath
import os
import pickle
import shutil
import signal
import socket
import stat
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(ROOT, "codex-plugin", "agent-work-plan", "hooks")
sys.dont_write_bytecode = True
sys.path.insert(0, HOOKS)
sys.path.insert(0, HERE)

import corpus  # noqa: E402
import plan_path  # noqa: E402
import skill_route as route  # noqa: E402

HOOK = os.path.join(HOOKS, "route-skills.py")
INJECT = os.path.join(HOOKS, "inject-work-plan.py")
MCP = os.path.join(HOOKS, "plan-mcp.py")
GUARD = os.path.join(HERE, "guard")
THREAD = "01a1b8e8-f7e2-7251-95a9-a95b65992849"
KEY, SECRET, TOKEN = "AKIDTESTONLYROUTE0001", "secretTESTONLYroute/0000+abcdefghijklmno", "tokenTESTONLYroute-0000"
DIM = 8
AXES = ["review", "fetch", "wake", "cluster", "crash", "disk", "budget", "other"]
CLEAN_ENV = {k: v for k, v in os.environ.items()
             if not k.startswith("AWS_") and k.upper() not in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")
             and k not in ("CODEX_HOME", "CLAUDE_CONFIG_DIR", "PYTHONPATH", "ROUTE_GUARD", "ROUTE_GUARD_LOG")}


def vector_of(text):
    """A made-up embedding: one axis per word of AXES the text holds, and a little of the last one."""
    t = text.lower()
    v = [1.0 if w in t else 0.0 for w in AXES[:-1]] + [0.05]
    return v


@contextlib.contextmanager
def environ(values):
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(values)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


class Bedrock:
    """A local stand-in for bedrock-runtime: records each request and answers with vector_of() for every text, or as
    the case sets it up."""

    def __init__(self):
        self.requests = []
        self.status = 200
        self.delay = 0.0
        self.delay_documents = 0.0
        self.raw = None
        self.shape = "dict"
        self.dim = DIM
        self.fail_paths = {}
        self.vectors = vector_of
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n)
                try:
                    got = json.loads(body.decode("utf-8"))
                except ValueError:
                    got = None
                outer.requests.append({"path": self.path, "headers": dict(self.headers), "body": got, "raw": body})
                texts = (got or {}).get("texts") or []
                doc = (got or {}).get("input_type") == "search_document"
                time.sleep(outer.delay + (outer.delay_documents if doc else 0))
                status = outer.status
                for part, code in outer.fail_paths.items():
                    if part in self.path:
                        status = code
                if status != 200:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"message":"no"}')
                    return
                if outer.raw is not None:
                    data = outer.raw
                else:
                    vecs = [(outer.vectors(t) + [0.0] * outer.dim)[:outer.dim] for t in texts]
                    data = json.dumps({"embeddings": {"float": vecs}} if outer.shape == "dict"
                                      else {"embeddings": vecs}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:
                    pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def texts(self, kind):
        return [r["body"]["texts"] for r in self.requests if r["body"] and r["body"].get("input_type") == kind]


class Home:
    """A Codex home, a home folder and the plugin's data directory, all under one temporary folder."""

    def __init__(self, provider="bedrock", vector=False):
        self.tmp = tempfile.mkdtemp(prefix="route-")
        self.home = os.path.join(self.tmp, "home")
        self.codex = os.path.join(self.tmp, "codex")
        self.data = os.path.join(self.codex, "plugins", "data", plan_path.PLUGIN_DIR_NAME)
        os.makedirs(self.home)
        os.makedirs(self.data)
        self.cred = self.script("cred.py", 'import json\nprint(json.dumps({"Version": 1, "AccessKeyId": "%s", '
                                           '"SecretAccessKey": "%s", "SessionToken": "%s"}))\n' % (KEY, SECRET, TOKEN))
        self.plugins = []
        self.extra_config = ""
        self.provider = provider
        self.settings(skillRouteVector=vector, skillRouteExtraDirs=[])
        self.env = dict(CLEAN_ENV, HOME=self.home, CODEX_HOME=self.codex, CLAUDE_CONFIG_DIR=os.path.join(self.home, ".claude"),
                        AWS_CONFIG_FILE=os.path.join(self.home, ".aws", "config"),
                        AWS_SHARED_CREDENTIALS_FILE=os.path.join(self.home, ".aws", "credentials"),
                        NO_PROXY="127.0.0.1,localhost", PYTHONDONTWRITEBYTECODE="1")
        self.write_config()

    def script(self, name, body):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as fh:
            fh.write("#!%s\n%s" % (sys.executable, body))
        os.chmod(p, 0o755)
        return p

    def provider_block(self):
        if self.provider == "bedrock":
            return ('model_provider = "amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nregion = "us-west-2"\n'
                    '[model_providers.amazon-bedrock.aws.credential_export]\ncommand = "%s"\nargs = []\n' % self.cred)
        return {"openai": 'model_provider = "openai"\n', "oss": 'model_provider = "oss"\n', "none": ""}[self.provider]

    def write_config(self):
        text = self.provider_block() + "".join('[plugins."%s@m"]\nenabled = %s\n' % (n, "true" if on else "false")
                                               for n, on in self.plugins) + self.extra_config
        with open(os.path.join(self.codex, "config.toml"), "w") as fh:
            fh.write(text)

    def settings(self, **values):
        path = os.path.join(self.data, "config.json")
        try:
            with open(path) as fh:
                got = json.load(fh)
        except (OSError, ValueError):
            got = {}
        got.update(values)
        with open(path, "w") as fh:
            json.dump(got, fh)

    def skill(self, root, folder, desc=None, name=None, raw=None):
        d = os.path.join(root, folder)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "SKILL.md")
        if raw is None:
            raw = "---\nname: %s\ndescription: %s\n---\n\nBody.\n" % (name or folder, json.dumps(desc or ""))
        with open(p, "wb") as fh:
            fh.write(raw if isinstance(raw, bytes) else raw.encode("utf-8"))
        return p

    def plugin(self, name, skills, enabled=True, version="1.0.0"):
        base = os.path.join(self.codex, "plugins", "cache", "m", name, version)
        os.makedirs(os.path.join(base, ".codex-plugin"), exist_ok=True)
        with open(os.path.join(base, ".codex-plugin", "plugin.json"), "w") as fh:
            json.dump({"name": name, "skills": "./skills/"}, fh)
        for folder, desc in skills.items():
            self.skill(os.path.join(base, "skills"), folder, desc)
        self.plugins.append((name, enabled))
        self.write_config()
        return os.path.join(base, "skills")

    def user_root(self):
        return os.path.join(self.home, ".agents", "skills")

    def corpus(self):
        root = self.user_root()
        for name, desc in corpus.SKILLS:
            self.skill(root, name.replace(":", "-"), desc, name=name)

    def given(self):
        return route.settings(self.data)

    def build(self, cwd="", **kw):
        with environ(self.env):
            return route.build(self.data, self.codex, cwd, self.given(), **kw)

    def search(self, text, count=5, cwd="", deadline=None):
        with environ(self.env):
            index = route.load_index(self.data)
            conf = route.codex_config(self.codex)
            return route.search(index, text, count, cwd, deadline or time.time() + route.BUDGET, self.data,
                                self.given(), conf)

    def names(self, text, count=5, cwd=""):
        return [s["name"] for s in self.search(text, count, cwd)[0]]

    def run(self, payload, env=None, script=HOOK, timeout=20):
        """Run a hook as Codex would: the payload on stdin, the data directory as its argument."""
        data = payload if isinstance(payload, (bytes, str)) else json.dumps(payload)
        data = data.encode("utf-8") if isinstance(data, str) else data
        t = time.time()
        p = subprocess.run([sys.executable, script, self.data], input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=dict(self.env, **(env or {})), timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace"), time.time() - t

    def prompt(self, text, env=None, cwd=None, **kw):
        return self.run({"hook_event_name": "UserPromptSubmit", "session_id": THREAD, "turn_id": "turn-1",
                         "cwd": cwd if cwd is not None else self.tmp, "prompt": text}, env, **kw)

    def injected(self, text, env=None, cwd=None):
        code, out, err, _ = self.prompt(text, env, cwd)
        if not out.strip():
            return []
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        return [line[2:].split(": ", 1)[0] for line in ctx.split("\n") if line.startswith("- ")]

    def log(self):
        p = os.path.join(route.data_root(self.data), route.LOG_FILE)
        try:
            with open(p, encoding="utf-8") as fh:
                return [json.loads(x) for x in fh if x.strip()]
        except OSError:
            return []

    def wait_built(self, timeout=15):
        lock = os.path.join(route.data_root(self.data), route.BUILD_LOCK)
        end = time.time() + timeout
        while time.time() < end:
            if route.load_index(self.data) and not os.path.isdir(lock):
                return True
            time.sleep(0.05)
        return False

    def bedrock(self, fake):
        self.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = fake.url

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Case(unittest.TestCase):
    provider = "bedrock"
    vector = False

    def setUp(self):
        self.h = Home(self.provider, self.vector)
        self.fake = None

    def tearDown(self):
        if self.fake:
            self.fake.close()
        self.h.close()

    def with_fake(self):
        self.fake = Bedrock()
        self.h.bedrock(self.fake)
        return self.fake

    def guard_log(self, path):
        try:
            with open(path, encoding="utf-8") as fh:
                return [json.loads(x) for x in fh if x.strip()]
        except OSError:
            return []

    def guarded(self, mode="deny"):
        log = os.path.join(self.h.tmp, "guard.jsonl")
        return log, {"PYTHONPATH": GUARD, "ROUTE_GUARD": mode, "ROUTE_GUARD_LOG": log}


class P_Settings(Case):
    def test_routing_settings(self):
        """the routing settings default to keywords on, vector search off, five skills and ~/.claude/skills; a list of
        the wrong type is ignored"""
        os.remove(os.path.join(self.h.data, "config.json"))
        got = route.settings(self.h.data)
        self.assertEqual([got[k] for k in ("skillRoute", "skillRouteVector", "skillRouteCount", "skillRouteExtraDirs",
                                           "skillRouteClaudePlugins")], [True, False, 5, ["~/.claude/skills"], []])
        self.h.settings(skillRouteExtraDirs="not a list", skillRouteClaudePlugins=["a", 3], skillRouteVector="yes")
        got = route.settings(self.h.data)
        self.assertEqual([got["skillRouteExtraDirs"], got["skillRouteClaudePlugins"], got["skillRouteVector"]],
                         [["~/.claude/skills"], [], False])
        self.h.settings(skillRouteExtraDirs=["/a", "/b"], skillRoute=False)
        self.assertEqual(route.settings(self.h.data)["skillRouteExtraDirs"], ["/a", "/b"])
        self.assertEqual(self.h.prompt("the disk is full, clean it")[1:3], ("", ""))


# ── A. input and tokens ──────────────────────────────────────────────────────────────────────────────────────────────


class A_Input(Case):
    def setUp(self):
        super().setUp()
        self.h.corpus()
        self.h.build()

    def test_short_messages_skip_by_characters(self):
        """a message under six characters is skipped, counted in characters: four Chinese characters are 12 bytes"""
        for text in ["", "   \n\t ", "继续做吧", "ok!!", "好的"]:
            self.assertEqual(self.h.injected(text), [], repr(text))
        self.assertEqual(self.h.log()[-1].get("why"), "short")
        self.assertTrue(self.h.injected("磁盘满了吧!"), "exactly six characters is not skipped")

    def test_punctuation_and_emoji_alone_inject_nothing(self):
        """a message of only punctuation or emoji, however long, matches no skill and injects nothing"""
        for text in ["?!?!?!?!...,,,;;", "\U0001F600\U0001F680\U0001F600\U0001F680\U0001F600\U0001F680", "！？。，、：；“”"]:
            self.assertEqual(self.h.injected(text), [], repr(text))

    def test_english_forms(self):
        """case, plurals, hyphenated and camelCase names, a plugin prefix, paths and URLs all reach the skill"""
        self.assertIn("code-review-publish", self.h.names("PUBLISH my CODE REVIEWS"))
        self.assertIn("web-fetching", self.h.names("WebFetching keeps failing"))
        self.assertIn("web-fetching", self.h.names("web-fetching"))
        self.assertIn("Tools-all:skill-authoring", self.h.names("Tools-all:skill-authoring for this"))
        self.assertIn("disk-cleanup", self.h.names("see /var/log/disk-cleanup.log and https://example.com/disk?full=1"))
        self.assertIn("crash-stack-lookup", self.h.names("```\ncore dump at 0x1\n```\nbacktrace please"))

    def test_named_skill_is_not_injected_again(self):
        """a skill the user names with $name is left out: Codex already puts its whole SKILL.md in front of the model"""
        self.assertIn("disk-cleanup", self.h.names("the disk is full, clean it"))
        self.assertNotIn("disk-cleanup", self.h.names("$disk-cleanup the disk is full, clean it"))

    def test_cjk_and_mixed_text(self):
        """Chinese, mixed Chinese and English, traditional characters, kana and full-width punctuation are searched"""
        self.assertIn("disk-cleanup", self.h.names("磁盘满了，怎么办？"))
        self.assertIn("code-review-publish", self.h.names("帮我发一个CR，谢谢！"))
        self.assertIn("weekly-status-report", self.h.names("幫我寫週報" + "，帮我写周报"))
        self.assertEqual(route.tokens("ウェブ"), ["c:ウェ", "c:ェブ"])

    def test_long_message_is_cut_and_fast(self):
        """a 100,000-character message is read only in its first part and the hook stays within its budget"""
        text = "磁盘满了 " + ("字" * 50000) + ("x" * 50000)
        t = time.time()
        names = self.h.names(text)
        self.assertLess(time.time() - t, 1.0)
        self.assertIn("disk-cleanup", names)
        code, out, err, secs = self.h.prompt(text)
        self.assertEqual((code, err), (0, ""))
        self.assertLess(secs, route.BUDGET + 0.5)

    def test_cutting_keeps_characters_whole(self):
        """the cut at 300 and 1,500 characters never splits a multi-byte character or a surrogate pair"""
        text = "\U0001F600" * 2000
        for n in (route.KEYWORD_CHARS, route.QUERY_CHARS):
            part = text[:n]
            self.assertEqual(part.encode("utf-8").decode("utf-8"), part)
            self.assertEqual(len(part), n)
        body = route.embed_request([text[:route.QUERY_CHARS]], "search_query", "m", "us-east-1",
                                   {"key": "k", "secret": "s"})[1]
        self.assertEqual(json.loads(body.decode("utf-8"))["texts"][0], text[:route.QUERY_CHARS])

    def test_common_words_alone_match_nothing(self):
        """a message of common words only, in English or Chinese, puts no skill forward"""
        for text in ["use it when the thing is there", "帮我看一下这个怎么样", "可以，好的，继续", "what do you think"]:
            self.assertEqual(self.h.names(text), [], text)

    def test_repeating_a_word_does_not_drown_the_rest(self):
        """saying one word a hundred times does not push out the skill another word in the message names"""
        names = self.h.names("snapshot lineage " + " ".join(["fetch"] * 100))
        self.assertIn("snapshot-lineage", names[:2])


# ── B. scoring and output ────────────────────────────────────────────────────────────────────────────────────────────


class B_Output(Case):
    def test_name_beats_description_and_triggers_count(self):
        """a skill named for the words ranks above one that only mentions them; trigger phrases add weight"""
        root = self.h.user_root()
        self.h.skill(root, "disk-cleanup", "Reclaim space.")
        self.h.skill(root, "storage-notes", "Notes about disk usage and cleanup of a disk after a disk cleanup.")
        self.h.skill(root, "alpha", "Something about logs. Use when 抓取日志")
        self.h.skill(root, "beta", "Something about logs and 抓取日志 too.")
        self.h.build()
        self.assertEqual(self.h.names("disk cleanup")[0], "disk-cleanup")
        self.assertEqual(self.h.names("抓取日志")[0], "alpha")

    def test_ties_are_ordered_by_name_and_runs_repeat(self):
        """skills with the same score come in name order, and two runs give the same lines byte for byte"""
        root = self.h.user_root()
        for n, other in [("zeta", "red"), ("alpha", "tan"), ("mu", "ash")]:
            self.h.skill(root, n, "widgets %s" % other)
        self.h.build()
        self.assertEqual(self.h.names("widgets"), ["alpha", "mu", "zeta"])
        self.assertEqual(self.h.prompt("widgets please")[1], self.h.prompt("widgets please")[1])

    def test_zero_scores_are_not_injected(self):
        """only skills that matched are injected, never five for the sake of five; none matched injects nothing"""
        root = self.h.user_root()
        self.h.skill(root, "widget-tool", "Widgets.")
        for i in range(8):
            self.h.skill(root, "other-%d" % i, "Lamps number %d." % i)
        self.h.build()
        self.assertEqual(self.h.injected("widgets please"), ["widget-tool"])
        self.assertEqual(self.h.injected("nothing matches this sentence xyzzy"), [])

    def test_count_limits(self):
        """the count is capped at ten; fewer skills than the count, one skill, or none are all fine"""
        with environ(self.h.env):
            self.assertEqual(route.build(self.h.data, self.h.codex, "", self.h.given())["skills"], [])
        self.assertEqual(self.h.injected("widgets everywhere"), [])
        root = self.h.user_root()
        self.h.skill(root, "only-one", "Widgets.")
        self.h.build()
        self.assertEqual(self.h.injected("widgets everywhere"), ["only-one"])
        for i in range(30):
            self.h.skill(root, "w%02d" % i, "Widgets %d." % i)
        self.h.settings(skillRouteCount=50)
        self.h.build()
        self.assertEqual(len(self.h.injected("widgets everywhere")), route.MAX_COUNT)

    def test_lines_are_one_per_skill_and_fit_the_limit(self):
        """every skill is one line however its description is written; long ones are cut, the block fits the limit"""
        root = self.h.user_root()
        self.h.skill(root, "messy", raw="---\nname: messy\ndescription: |\n  line one\n  `code` and \"quotes\"\n"
                                        "  \tand **bold** widgets\n---\n")
        self.h.skill(root, "huge", "widgets " + "很长的描述" * 600)
        for i in range(8):
            self.h.skill(root, "big%d" % i, ("widgets %d " % i) + ("中文字" * 340))
        self.h.settings(skillRouteCount=10)
        self.h.build()
        code, out, err, _ = self.h.prompt("widgets please")
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        lines = ctx.split("\n")
        self.assertEqual(len(lines), 11)
        self.assertTrue(all(l.startswith("- ") and l.endswith("SKILL.md)") for l in lines[1:]))
        self.assertLessEqual(len(ctx.encode("utf-8")), route.CONTEXT_BYTES)
        self.assertLessEqual(len(ctx.encode("utf-8")) / 4, 4000)
        messy = [l for l in lines if l.startswith("- messy:")][0]
        self.assertIn('`code` and "quotes" and **bold** widgets', messy)
        for l in lines[1:]:
            path = l.rsplit("(file: ", 1)[1][:-1]
            self.assertTrue(os.path.isabs(path) and path == os.path.realpath(path))

    def test_descriptions_are_cut_at_1024(self):
        """a description over 1,024 characters is cut to 1,024, as Codex cuts it"""
        root = self.h.user_root()
        self.h.skill(root, "long", "widgets " + "x" * 3000)
        self.h.build()
        desc = route.load_index(self.h.data)["skills"][0]["desc"]
        self.assertEqual(len(desc), route.DESC_CHARS)
        self.assertTrue(desc.endswith("..."))

    def test_work_plan_block_is_left_whole(self):
        """run on the same turn, the work plan hook's block and this one both come out, the plan's untouched"""
        self.h.corpus()
        self.h.build()
        plan = os.path.join(self.h.data, THREAD + ".json")
        with open(plan, "w") as fh:
            json.dump({"nodes": [{"title": "Fix the disk", "state": "doing"}]}, fh)
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": THREAD, "turn_id": "t", "cwd": self.h.tmp,
                   "prompt": "the disk is full, clean it"}
        a = self.h.run(payload, script=INJECT)[1]
        b = self.h.run(payload)[1]
        plan_ctx = json.loads(a)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Fix the disk", plan_ctx)
        self.assertNotIn(route.MARK, plan_ctx)
        self.assertIn("disk-cleanup", json.loads(b)["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(a, self.h.run(payload, script=INJECT)[1].replace("turn", "turn"))


# ── C. finding skills and reading their frontmatter ──────────────────────────────────────────────────────────────────


class C_Discovery(Case):
    def fm(self, raw):
        root = os.path.join(self.h.tmp, "fm")
        p = self.h.skill(root, "s", raw=raw)
        return route.frontmatter(p)

    def test_frontmatter_forms(self):
        """plain, quoted with escapes, folded, literal, multi-line, BOM, CRLF, tabs and extra keys are all read"""
        self.assertEqual(self.fm("---\nname: a\ndescription: plain words\n---\n")["description"], "plain words")
        self.assertEqual(self.fm('---\ndescription: "say \\"hi\\" \\u00e9"\n---\n')["description"], 'say "hi" \u00e9')
        self.assertEqual(self.fm("---\ndescription: 'it''s'\n---\n")["description"], "it's")
        self.assertEqual(self.fm("---\ndescription: >\n  one\n  two\n---\n")["description"], "one two")
        self.assertEqual(self.fm("---\ndescription: |\n  one\n  two\n---\n")["description"], "one\ntwo")
        self.assertEqual(self.fm("---\ndescription: one\n  two\n  three\nother: x\n---\n")["description"],
                         "one two three")
        self.assertEqual(self.fm("\ufeff---\r\nname: b\r\ndescription: crlf\r\n---\r\n")["description"], "crlf")
        self.assertEqual(self.fm("---\ndescription: >\n\tone\n\ttwo\nextra: 1\n---\n")["description"], "one two")

    def test_broken_frontmatter(self):
        """no frontmatter, one never closed, no description or name, and bytes that are not UTF-8 do not break it"""
        self.assertEqual(self.fm("# Just a title\n"), {})
        self.assertEqual(self.fm("---\nname: x\ndescription: never closed\n"), {})
        self.assertEqual(self.fm(b"---\ndescription: caf\xe9 \xff\n---\n")["description"], "caf\ufffd \ufffd")
        root = self.h.user_root()
        self.h.skill(root, "no-name", raw="---\ndescription: widgets\n---\n")
        self.h.skill(root, "no-desc", raw="---\nname: no-desc\n---\n")
        self.h.skill(root, "no-fm", raw="widgets\n")
        self.h.build()
        skills = {s["name"]: s for s in route.load_index(self.h.data)["skills"]}
        self.assertEqual(sorted(skills), ["no-desc", "no-fm", "no-name"])
        self.assertIn("(no description)", route.render([skills["no-desc"]]))

    def test_large_skill_file_reads_only_its_head(self):
        """only the head of a very large SKILL.md is read"""
        p = self.h.skill(os.path.join(self.h.tmp, "fm"), "big", raw="---\ndescription: head\n---\n" + "x" * (8 << 20))
        opened = []
        real = open

        def counting(path, *a, **k):
            fh = real(path, *a, **k)
            if path == p:
                orig = fh.read
                fh.read = lambda n=-1: (opened.append(n), orig(n))[1]
            return fh
        with mock.patch("builtins.open", counting):
            self.assertEqual(route.frontmatter(p)["description"], "head")
        self.assertEqual(opened, [route.FRONTMATTER_BYTES])

    def test_links_spaces_and_loops(self):
        """linked folders are followed, a loop of links ends, and paths with spaces or Chinese work"""
        real = os.path.join(self.h.tmp, "real skills 中文")
        self.h.skill(real, "linked", "widgets via a link")
        os.makedirs(self.h.user_root())
        os.symlink(real, os.path.join(self.h.user_root(), "group"))
        os.symlink(self.h.user_root(), os.path.join(real, "loop"))
        index = self.h.build()
        self.assertEqual([s["name"] for s in index["skills"]], ["linked"])
        self.assertIn("real skills 中文", index["skills"][0]["path"])

    def test_duplicates(self):
        """the same name in several folders keeps the one Codex reads first, and identical descriptions keep one"""
        self.h.skill(os.path.join(self.h.codex, "skills"), "dup", "from the Codex home")
        self.h.skill(self.h.user_root(), "dup", "from the agents folder")
        self.h.skill(self.h.user_root(), "Dup", "case differs")
        self.h.plugin("p", {"copy-a": "The very same words."})
        extra = os.path.join(self.h.tmp, "extra")
        self.h.skill(extra, "copy-b", "The very same words.")
        self.h.settings(skillRouteExtraDirs=[extra])
        index = self.h.build()
        got = {s["name"]: s["desc"] for s in index["skills"]}
        self.assertEqual(got, {"dup": "from the Codex home", "p:copy-a": "The very same words."})

    def test_what_is_left_out(self):
        """skills turned off in skills.config or by allow_implicit_invocation: false are left out; Claude-only
        plugins and extra folders are searched only when their settings name them"""
        root = self.h.plugin("p", {"on": "widgets on", "off": "widgets off"})
        self.h.extra_config = '[[skills.config]]\nname = "p:off"\nenabled = false\n'
        self.h.write_config()
        quiet = self.h.skill(self.h.user_root(), "quiet", "widgets quiet")
        os.makedirs(os.path.join(os.path.dirname(quiet), "agents"))
        with open(os.path.join(os.path.dirname(quiet), "agents", "openai.yaml"), "w") as fh:
            fh.write("interface:\n  display_name: Quiet\npolicy:\n  allow_implicit_invocation: false\n")
        claude = os.path.join(self.h.home, ".claude")
        cp = os.path.join(self.h.tmp, "claude-plugin")
        self.h.skill(os.path.join(cp, "skills"), "cl", "widgets from claude")
        os.makedirs(os.path.join(claude, "plugins"))
        with open(os.path.join(claude, "plugins", "installed_plugins.json"), "w") as fh:
            json.dump({"plugins": {"Cl@x": [{"installPath": cp}]}}, fh)
        extra = os.path.join(self.h.tmp, "extra")
        self.h.skill(extra, "ex", "widgets extra")
        self.h.build()
        self.assertEqual(sorted(self.h.names("widgets")), ["p:on"])
        self.h.settings(skillRouteClaudePlugins=["Cl"], skillRouteExtraDirs=[extra])
        self.h.build()
        self.assertEqual(sorted(self.h.names("widgets")), ["Cl:cl", "ex", "p:on"])
        self.h.settings(skillRouteExtraDirs=[])
        self.h.build()
        self.assertEqual(sorted(self.h.names("widgets")), ["Cl:cl", "p:on"])
        self.assertTrue(os.path.isdir(root))

    def test_repository_skills_apply_in_their_repository(self):
        """a repository's .agents/skills is searched only when the working directory is in that repository"""
        repo = os.path.join(self.h.tmp, "repo")
        os.makedirs(os.path.join(repo, ".git"))
        self.h.skill(os.path.join(repo, ".agents", "skills"), "repo-only", "widgets of the repo")
        sub = os.path.join(repo, "src", "deep")
        os.makedirs(sub)
        self.h.build(cwd=sub)
        self.assertEqual(self.h.names("widgets", cwd=sub), ["repo-only"])
        self.assertEqual(self.h.names("widgets", cwd=self.h.tmp), [])


# ── D. the index's life ──────────────────────────────────────────────────────────────────────────────────────────────


class D_Index(Case):
    def test_first_turn_returns_and_builds(self):
        """with no index the turn returns at once and a rebuild starts in the background"""
        self.h.corpus()
        code, out, err, secs = self.h.prompt("the disk is full, clean it")
        self.assertEqual((code, out, err), (0, "", ""))
        self.assertLess(secs, 1.0)
        self.assertTrue(self.h.wait_built())
        self.assertIn("disk-cleanup", self.h.injected("the disk is full, clean it"))

    def test_changes_are_noticed(self):
        """an edited, deleted or newly added skill (in a new folder too) makes the index out of date"""
        root = self.h.user_root()
        p = self.h.skill(root, "a", "widgets")
        self.h.build()
        with environ(self.h.env):
            fresh = lambda: route.stale(route.load_index(self.h.data), self.h.codex, "", self.h.given())
            self.assertEqual(fresh(), "")
            self.h.skill(root, "a", "gadgets now")
            self.assertTrue(fresh())
            self.h.build()
            self.h.skill(root, "b", "new one")
            self.assertTrue(fresh())
            self.h.build()
            os.remove(p)
            self.assertTrue(fresh())
            self.h.build()
            self.h.skill(os.path.join(root, "group"), "c", "nested in a new folder")
            self.assertTrue(fresh())
            self.h.build()
            # Within one tick of a coarse clock, as two folders made one after the other usually are.
            st = os.stat(root)
            os.makedirs(os.path.join(root, "d"))
            self.h.skill(root, "d", "made at once")
            os.utime(root, ns=(st.st_atime_ns, st.st_mtime_ns))
            self.assertEqual(fresh(), "a folder changed")

    def test_two_writes_in_one_second(self):
        """two writes with the same modification time are detected by size, or by inode when the file is replaced by
        rename"""
        root = self.h.user_root()
        p = self.h.skill(root, "a", "widgets one")
        st = os.stat(p)
        self.h.build()
        with environ(self.h.env):
            fresh = lambda: route.stale(route.load_index(self.h.data), self.h.codex, "", self.h.given())
            with open(p, "a") as fh:
                fh.write("more")
            os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
            self.assertEqual(fresh(), "a file changed")
            self.h.build()
            st = os.stat(p)
            tmp = p + ".new"
            with open(p, "rb") as src, open(tmp, "wb") as dst:
                dst.write(src.read().replace(b"one", b"two"))
            os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
            os.replace(tmp, p)
            self.assertEqual(os.stat(p).st_size, st.st_size)
            self.assertEqual(fresh(), "a file changed")

    def test_rebuild_does_not_hold_the_hook(self):
        """the hook returns while its rebuild is still running: the rebuild holds none of the hook's pipes"""
        self.h.corpus()
        self.h.settings(skillRouteVector=True)
        fake = self.with_fake()
        fake.delay_documents = 3.0
        code, out, err, secs = self.h.prompt("the disk is full, clean it")
        returned = time.time()
        self.assertLess(secs, 1.5)
        self.assertTrue(self.h.wait_built(20))
        build = [r for r in self.h.log() if r.get("ev") == "build"][-1]
        self.assertGreater(build["t"] - returned, 2.0, "the rebuild went on for seconds after the hook returned")
        self.assertGreater(build["ms"], 2500)

    def test_one_rebuild_at_a_time(self):
        """two rebuilds started together build once; the lock keeps the second out"""
        self.h.corpus()
        self.h.settings(skillRouteVector=True)
        fake = self.with_fake()
        fake.delay_documents = 1.0
        procs = [subprocess.Popen([sys.executable, os.path.join(HOOKS, "skill_route.py"), "--build", self.h.data, "--cwd", ""],
                                  env=self.h.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(2)]
        for p in procs:
            p.wait(30)
        self.assertEqual(len([r for r in self.h.log() if r.get("ev") == "build"]), 1)
        self.assertEqual(len(fake.texts("search_document")), 1)
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": THREAD, "turn_id": "t", "cwd": "", "prompt": "x" * 9}
        shutil.rmtree(route.data_root(self.h.data))
        self.h.settings(skillRouteVector=False)
        both = [subprocess.Popen([sys.executable, HOOK, self.h.data], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, env=self.h.env) for _ in range(2)]
        for p in both:
            p.communicate(json.dumps(payload).encode())
        self.assertTrue(self.h.wait_built())
        time.sleep(0.5)
        self.assertEqual(len([r for r in self.h.log() if r.get("ev") == "build"]), 1)

    def test_index_is_never_read_half_written(self):
        """a reader running while the index is rewritten sees the old or the new index, never part of one"""
        self.h.corpus()
        self.h.build()
        stop, seen = [False], []

        def writer():
            while not stop[0]:
                self.h.build()
        t = threading.Thread(target=writer)
        t.start()
        try:
            for _ in range(200):
                seen.append(route.load_index(self.h.data) is not None)
        finally:
            stop[0] = True
            t.join()
        self.assertTrue(all(seen))

    def test_bad_index_files(self):
        """a damaged, cut short or older index is treated as none and rebuilt; a hook never fails on it"""
        self.h.corpus()
        self.h.build()
        path = os.path.join(route.data_root(self.h.data), route.INDEX_FILE)
        good = open(path, "rb").read()
        for bad in (b"not a pickle", good[:len(good) // 2], pickle.dumps({"version": 1, "skills": []})):
            with open(path, "wb") as fh:
                fh.write(bad)
            self.assertIsNone(route.load_index(self.h.data))
            code, out, err, _ = self.h.prompt("the disk is full, clean it")
            self.assertEqual((code, err), (0, ""))
            self.assertTrue(self.h.wait_built())
            os.remove(os.path.join(route.data_root(self.h.data), route.BUILT_AT))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root writes anywhere")
    def test_unwritable_data_directory(self):
        """when the data directory cannot be written, the search still works for the turn, without keeping an index"""
        self.h.corpus()
        os.chmod(self.h.data, 0o500)
        try:
            self.assertIn("disk-cleanup", self.h.injected("the disk is full, clean it"))
            self.assertFalse(os.path.exists(route.data_root(self.h.data)))
        finally:
            os.chmod(self.h.data, 0o700)

    def test_deleted_skill_is_not_offered(self):
        """a skill whose file is gone is not injected even before the index is rebuilt"""
        p = self.h.skill(self.h.user_root(), "gone", "widgets")
        self.h.skill(self.h.user_root(), "stays", "widgets too")
        self.h.build()
        os.remove(p)
        self.assertEqual(self.h.names("widgets"), ["stays"])


# ── E. the hook's input and output ───────────────────────────────────────────────────────────────────────────────────


class E_Contract(Case):
    def test_any_input_exits_quietly(self):
        """no prompt, unknown fields, not JSON, a huge payload or nothing at all: exit 0, no half JSON, no stderr"""
        self.h.corpus()
        self.h.build()
        for payload in [{"hook_event_name": "UserPromptSubmit"}, {"prompt": "the disk is full", "zzz": [1, {"a": 2}]},
                        b"{not json", b"", b"\xff\xfe\x00", json.dumps({"prompt": "disk " * 400000}).encode(), b"[]",
                        b"null", {"prompt": 42}, {"prompt": None, "cwd": 7}]:
            code, out, err, _ = self.h.run(payload)
            self.assertEqual((code, err), (0, ""), repr(payload)[:60])
            if out.strip():
                self.assertIn("additionalContext", json.loads(out)["hookSpecificOutput"])

    def test_hook_entry_is_set_up_for_codex(self):
        """hooks.json runs the hook on UserPromptSubmit with additionalContextLimit 4000, and on Stop"""
        with open(os.path.join(HOOKS, "hooks.json")) as fh:
            hooks = json.load(fh)["hooks"]
        ups = [h for g in hooks["UserPromptSubmit"] for h in g["hooks"] if "route-skills.py" in h["command"]]
        stop = [h for g in hooks["Stop"] for h in g["hooks"] if "route-skills.py" in h["command"]]
        self.assertEqual([h.get("additionalContextLimit") for h in ups], [4000])
        self.assertEqual(len(stop), 1)
        self.assertNotIn("additionalContextLimit", stop[0])


# ── F. vector search: the switch, the configuration, credentials ─────────────────────────────────────────────────────


class F_Switch(Case):
    def assert_untouched(self, prompt="the disk is full, clean it", prebuilt=True):
        self.h.corpus()
        os.makedirs(os.path.join(self.h.home, ".aws"))
        with open(os.path.join(self.h.home, ".aws", "credentials"), "w") as fh:
            fh.write("[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n" % (KEY, SECRET))
        with open(os.path.join(self.h.codex, "auth.json"), "w") as fh:
            fh.write('{"tokens": {"access_token": "%s"}}' % TOKEN)
        if prebuilt:
            self.h.build()
        log, env = self.guarded("deny")
        env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = "http://127.0.0.1:9"
        code, out, err, _ = self.h.prompt(prompt, env)
        self.assertEqual((code, err), (0, ""))
        if not prebuilt:
            self.assertTrue(self.h.wait_built())
            code, out, err, _ = self.h.prompt(prompt, env)
        self.assertIn("disk-cleanup", json.loads(out)["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.guard_log(log), [])
        self.assertEqual(self.h.log()[-1]["via"], "keyword")

    def test_default_with_bedrock_touches_nothing(self):
        """vector search off (the default) with a Bedrock provider touches no credentials and no network, in the turn
        and in its rebuild"""
        self.assert_untouched(prebuilt=False)

    def test_on_but_not_bedrock_touches_nothing(self):
        """vector search on with OpenAI, a ChatGPT sign-in, a local model or no provider: nothing touched, keywords work"""
        for provider in ("openai", "none", "oss"):
            self.h.close()
            self.h = Home(provider, vector=True)
            self.assert_untouched()

    def test_the_guard_sees_what_it_should(self):
        """the guard itself works: with vector search on and Bedrock, it records the credential command and the socket"""
        self.h.corpus()
        self.h.settings(skillRouteVector=True)
        self.with_fake()
        self.h.build()
        log, env = self.guarded("record")
        self.h.prompt("the disk is full, clean it", env)
        kinds = {r["kind"] for r in self.guard_log(log)}
        self.assertLessEqual({"program", "connect"}, kinds)
        self.assertEqual(self.h.log()[-1]["via"], "vector")


class F_Config(Case):
    def test_provider_forms(self):
        """the provider is Bedrock by its built-in id, through a profile, or by a table with aws; otherwise it is not"""
        t = lambda s: route.bedrock_provider(route._Toml(s).parse())
        self.assertEqual(t('model_provider = "amazon-bedrock"\n'), {})
        self.assertEqual(t('model_provider = "amazon-bedrock"\n[model_providers."amazon-bedrock".aws]\nregion = "r"\n'),
                         {"region": "r"})
        self.assertEqual(t('profile = "w"\n[profiles.w]\nmodel_provider = "amazon-bedrock"\n'), {})
        self.assertEqual(t('model_provider = "corp"\n[model_providers.corp.aws]\nprofile = "p"\n'), {"profile": "p"})
        self.assertEqual(t('model_provider = "corp"\n[model_providers.corp]\nbase_url = "x"\n'), None)
        self.assertEqual(t('model_provider = "openai"\n'), None)
        self.assertEqual(t(""), None)

    def test_region_order(self):
        """the region is the provider's own, then AWS_REGION, then AWS_DEFAULT_REGION, then the profile's, else none"""
        cfg = os.path.join(self.h.home, ".aws", "config")
        os.makedirs(os.path.dirname(cfg))
        with open(cfg, "w") as fh:
            fh.write("[default]\nregion = from-profile\n[profile p]\nregion = from-p\n")
        with environ(self.h.env):
            self.assertEqual(route.region_of({}), "from-profile")
            self.assertEqual(route.region_of({"profile": "p"}), "from-p")
            os.environ["AWS_DEFAULT_REGION"] = "from-default-env"
            self.assertEqual(route.region_of({}), "from-default-env")
            os.environ["AWS_REGION"] = "from-env"
            self.assertEqual(route.region_of({}), "from-env")
            self.assertEqual(route.region_of({"region": " own "}), "own")
            os.remove(cfg)
            del os.environ["AWS_REGION"], os.environ["AWS_DEFAULT_REGION"]
            self.assertEqual(route.region_of({}), "")

    def test_credential_sources(self):
        """credential_export, a named profile, the environment and the default profile are read in that order"""
        aws_dir = os.path.join(self.h.home, ".aws")
        os.makedirs(aws_dir)
        with open(os.path.join(aws_dir, "credentials"), "w") as fh:
            fh.write("[named]\naws_access_key_id = N1\naws_secret_access_key = N2\n"
                     "[default]\naws_access_key_id = D1\naws_secret_access_key = D2\n")
        with open(os.path.join(aws_dir, "config"), "w") as fh:
            fh.write("[profile proc]\ncredential_process = %s\n[profile sso]\nsso_session = x\n" % self.h.cred)
        with environ(self.h.env):
            self.assertEqual(route.credentials({"credential_export": {"command": self.h.cred}}, 5)["key"], KEY)
            self.assertEqual(route.credentials({"profile": "named"}, 5)["key"], "N1")
            self.assertEqual(route.credentials({"profile": "proc"}, 5)["token"], TOKEN)
            for bad in ("sso", "missing"):
                with self.assertRaises(route.Unavailable):
                    route.credentials({"profile": bad}, 5)
            self.assertEqual(route.credentials({}, 5)["key"], "D1")
            os.environ.update(AWS_ACCESS_KEY_ID="E1", AWS_SECRET_ACCESS_KEY="E2", AWS_SESSION_TOKEN="E3")
            self.assertEqual(route.credentials({}, 5), {"key": "E1", "secret": "E2", "token": "E3"})
            del os.environ["AWS_ACCESS_KEY_ID"]
            os.remove(os.path.join(aws_dir, "credentials"))
            with self.assertRaises(route.Unavailable):
                route.credentials({}, 5)

    def test_unreadable_configuration_falls_back(self):
        """a provider with no credentials or no region falls back to keywords and is marked unavailable"""
        self.h.corpus()
        self.h.settings(skillRouteVector=True)
        self.with_fake()
        self.h.build()
        index = route.load_index(self.h.data)
        self.assertTrue(index["dim"])
        with open(os.path.join(self.h.codex, "config.toml"), "w") as fh:
            fh.write('model_provider = "amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nregion = "us-west-2"\n')
        names, how, _, why = self.h.search("the disk is full, clean it")
        self.assertEqual(how, "keyword")
        self.assertIn("no AWS credentials", why)
        self.assertTrue(route.vector_state(self.h.data).get("offUntil"))


class F_Credentials(Case):
    def run_cred(self, body, timeout=1.0):
        p = self.h.script("c.py", body)
        with environ(self.h.env):
            return route.run_credentials([p], timeout)

    def test_command_results(self):
        """a credential command's good output is read; bad output, a failing exit, a huge output or expired keys are not"""
        self.assertEqual(self.run_cred('print(\'{"AccessKeyId": "a", "SecretAccessKey": "b"}\')'),
                         {"key": "a", "secret": "b", "token": ""})
        self.assertEqual(self.run_cred('print("export AWS_ACCESS_KEY_ID=a\\nAWS_SECRET_ACCESS_KEY=b")')["secret"], "b")
        for body, err in [('print("garbage")', route.Unavailable), ('import sys; sys.exit(3)', route.Unavailable),
                          ('import sys; sys.stdout.write("x" * (1 << 20))', route.Unavailable),
                          ('print(\'{"AccessKeyId": "a", "SecretAccessKey": "b", "Expiration": "2001-01-01T00:00:00Z"}\')',
                           route.Transient)]:
            with self.assertRaises(err, msg=body):
                self.run_cred(body)

    def test_hung_command_is_killed_with_its_children(self):
        """a credential command that hangs is killed after its time, together with the processes it started"""
        pidfile = os.path.join(self.h.tmp, "child.pid")
        body = ("import subprocess, time\np = subprocess.Popen(['sleep', '30'])\nopen(%r, 'w').write(str(p.pid))\n"
                "time.sleep(30)\n" % pidfile)
        t = time.time()
        with self.assertRaises(route.Transient):
            self.run_cred(body, timeout=0.5)
        self.assertLess(time.time() - t, 2.0)
        time.sleep(0.3)
        child = int(open(pidfile).read())
        with self.assertRaises(OSError):
            os.kill(child, 0)

    def test_credentials_are_written_nowhere(self):
        """after vector searches, no file, log line, injected text or stderr holds a key, secret or token"""
        self.h.corpus()
        self.h.settings(skillRouteVector=True)
        self.with_fake()
        outs = [self.h.prompt("the disk is full, clean it")]
        self.assertTrue(self.h.wait_built())
        outs += [self.h.prompt(q) for q in ("the disk is full, clean it", "wake me up", "fetch that page")]
        self.h.run({"hook_event_name": "Stop", "session_id": THREAD, "turn_id": "turn-1", "transcript_path": "/none"})
        self.assertEqual(self.h.log()[-2]["via"], "vector")
        blobs = [o[1] + o[2] for o in outs]
        for d, _, files in os.walk(self.h.data):
            for f in files:
                blobs.append(open(os.path.join(d, f), "rb").read().decode("latin-1"))
        for secret in (KEY, SECRET, TOKEN):
            self.assertFalse(any(secret in b for b in blobs), secret)


class F_Signing(Case):
    CREDS = {"key": "AKIDEXAMPLE", "secret": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}
    WHEN = datetime.datetime(2015, 8, 30, 12, 36, 0)

    def test_published_examples(self):
        """AWS's published Signature Version 4 examples give their published signatures"""
        iam = route.sign("GET", "iam.amazonaws.com", "/", {"Action": "ListUsers", "Version": "2010-05-08"},
                         {"content-type": "application/x-www-form-urlencoded; charset=utf-8"}, b"", self.CREDS,
                         "us-east-1", "iam", now=self.WHEN)
        self.assertTrue(iam["authorization"].endswith(
            "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"))
        vanilla = route.sign("GET", "example.amazonaws.com", "/", {}, {}, b"", self.CREDS, "us-east-1", "service",
                             now=self.WHEN)
        self.assertTrue(vanilla["authorization"].endswith(
            "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"))

    def test_bedrock_request(self):
        """the model id's colon is encoded in the path, the session token is a signed header"""
        with environ(self.h.env):
            url, body, headers = route.embed_request(["hi"], "search_query", "us.cohere.embed-v4:0", "us-west-2",
                                                     dict(self.CREDS, token="T0K"))
        self.assertEqual(url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.cohere.embed-v4%3A0/invoke")
        self.assertEqual(headers["x-amz-security-token"], "T0K")
        self.assertIn("x-amz-security-token", headers["authorization"].split("SignedHeaders=")[1])

    def test_same_signature_as_botocore(self):
        """botocore signs the same Bedrock request with the same signature"""
        try:
            from botocore.auth import SigV4Auth
            from botocore.awsrequest import AWSRequest
            from botocore.credentials import Credentials
        except ImportError:
            self.skipTest("botocore is not installed here")
        creds = dict(self.CREDS, token="session-token")
        with environ(self.h.env), mock.patch("skill_route.datetime") as dt:
            dt.datetime.utcnow.return_value = self.WHEN
            url, body, ours = route.embed_request(["one", "two"], "search_document", "cohere.embed-v4:0", "eu-west-1",
                                                  creds)
        req = AWSRequest(method="POST", url=url, data=body,
                         headers={"content-type": "application/json", "accept": "application/json"})
        with mock.patch("botocore.auth.datetime") as dt:
            dt.datetime.utcnow.return_value = self.WHEN
            SigV4Auth(Credentials(creds["key"], creds["secret"], creds["token"]), "bedrock", "eu-west-1").add_auth(req)
        self.assertEqual(ours["authorization"], req.headers["Authorization"])


# ── G. vector search: requests and answers ───────────────────────────────────────────────────────────────────────────


class G_Requests(Case):
    vector = True

    def setUp(self):
        super().setUp()
        self.h.corpus()
        self.with_fake()
        self.h.build()

    def test_request_holds_only_the_message(self):
        """the request carries the message alone, cut to 1,500 characters; queries and skills use different input types"""
        text = "讲" * 3000
        self.h.prompt(text)
        query = self.fake.texts("search_query")[-1]
        self.assertEqual(query, [text[:route.QUERY_CHARS]])
        self.assertEqual(set(self.fake.requests[-1]["body"]), {"texts", "input_type", "truncate", "embedding_types"})
        docs = self.fake.texts("search_document")
        self.assertTrue(docs and all(t.split(":")[0] for t in docs[0]))
        self.assertNotEqual(self.fake.requests[0]["body"]["input_type"], self.fake.requests[-1]["body"]["input_type"])
        self.assertEqual(self.fake.requests[-1]["path"], "/model/us.cohere.embed-v4%3A0/invoke")

    def test_answer_shapes(self):
        """both of Cohere v4's answer shapes are read; a wrong length, empty, NaN, cut-off or non-JSON answer is not"""
        self.fake.shape = "list"
        self.assertEqual(self.h.search("wake me up")[1], "vector")
        for raw, mark in [(b'{"embeddings": {"float": [[1, 2]]}}', True), (b'{"embeddings": {"float": []}}', False),
                          (b'{"embeddings": {"float": [[NaN, 1, 1, 1, 1, 1, 1, 1]]}}', False), (b'{"embeddings": {"fl', False),
                          (b"<html>proxy</html>", False), (b'{"embeddings": {"float": [[0,0,0,0,0,0,0,0]]}}', False)]:
            route.vector_state(self.h.data)
            try:
                os.remove(os.path.join(route.data_root(self.h.data), route.VECTOR_STATE))
            except OSError:
                pass
            self.fake.raw = raw
            names, how, _, why = self.h.search("wake me up")
            self.assertEqual(how, "keyword", raw)
            self.assertEqual(bool(route.vector_state(self.h.data).get("offUntil")), mark, raw)

    def test_errors_and_marks(self):
        """403, 404 and 400 mark the search unavailable; 429 and 5xx fall back for the turn only"""
        for code, mark in [(429, False), (500, False), (503, False), (400, True), (403, True), (404, True)]:
            try:
                os.remove(os.path.join(route.data_root(self.h.data), route.VECTOR_STATE))
            except OSError:
                pass
            self.fake.status = code
            self.assertEqual(self.h.search("wake me up")[1], "keyword", code)
            self.assertEqual(bool(route.vector_state(self.h.data).get("offUntil")), mark, code)
        self.fake.status = 200
        self.assertEqual(self.h.search("wake me up")[1], "keyword", "still off after a 404")

    def test_connection_failures(self):
        """a refused connection and a name that does not resolve fall back without a mark; a TLS failure marks"""
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        for url, mark in [("http://127.0.0.1:%d" % port, False), ("http://route-test.invalid", False),
                          ("https://127.0.0.1:%d" % self.fake.server.server_address[1], True)]:
            self.h.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = url
            try:
                os.remove(os.path.join(route.data_root(self.h.data), route.VECTOR_STATE))
            except OSError:
                pass
            self.assertEqual(self.h.search("wake me up")[1], "keyword", url)
            self.assertEqual(bool(route.vector_state(self.h.data).get("offUntil")), mark, url)

    def test_mark_lapses(self):
        """the mark lapses after its time, and when the region, the credentials or the setting change"""
        self.fake.status = 403
        self.h.search("wake me up")
        self.fake.status = 200
        self.assertEqual(self.h.search("wake me up")[1], "keyword")
        state = route.vector_state(self.h.data)
        state["offUntil"] = time.time() - 1
        with open(os.path.join(route.data_root(self.h.data), route.VECTOR_STATE), "w") as fh:
            json.dump(state, fh)
        self.assertEqual(self.h.search("wake me up")[1], "vector")
        self.fake.status = 403
        self.h.search("wake me up")
        self.fake.status = 200
        with open(os.path.join(self.h.codex, "config.toml")) as fh:
            text = fh.read()
        with open(os.path.join(self.h.codex, "config.toml"), "w") as fh:
            fh.write(text.replace("us-west-2", "us-east-2"))
        self.assertEqual(self.h.search("wake me up")[1], "vector")

    def test_budget_holds_when_bedrock_hangs(self):
        """when Bedrock never answers, the whole hook still ends within about 1.6 seconds, with the keyword results"""
        keyword = self.h.prompt("wake me up every few minutes", env={"AWS_ENDPOINT_URL_BEDROCK_RUNTIME": "http://x.invalid"})
        self.fake.delay = 10
        code, out, err, secs = self.h.prompt("wake me up every few minutes")
        self.assertLess(secs, 1.65)
        self.assertEqual(out, keyword[1])
        self.assertEqual(self.h.log()[-1]["via"], "keyword")
        slow = self.h.script("slow-cred.py", "import time; time.sleep(5)")
        with open(os.path.join(self.h.codex, "config.toml")) as fh:
            text = fh.read()
        with open(os.path.join(self.h.codex, "config.toml"), "w") as fh:
            fh.write(text.replace(self.h.cred, slow))
        code, out, err, secs = self.h.prompt("wake me up every few minutes")
        self.assertLess(secs, 1.65)
        self.assertEqual(out, keyword[1])

    def test_https_proxy_is_used(self):
        """HTTPS_PROXY is honoured: the request goes to the proxy as a CONNECT to Bedrock's own host"""
        seen = []

        class Proxy(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_CONNECT(self):
                seen.append(self.path)
                self.send_response(403)
                self.end_headers()
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            del self.h.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"]
            self.h.env["HTTPS_PROXY"] = "http://127.0.0.1:%d" % server.server_address[1]
            self.h.env["NO_PROXY"] = ""
            self.assertEqual(self.h.search("wake me up")[1], "keyword")
            self.assertEqual(seen, ["bedrock-runtime.us-west-2.amazonaws.com:443"])
        finally:
            server.shutdown()
            server.server_close()


# ── H. vector search: the index's vectors ────────────────────────────────────────────────────────────────────────────


class H_Vectors(Case):
    vector = True

    def test_cache_by_text_and_model(self):
        """a rebuild asks only for skills whose text changed; another model or another length embeds everything again"""
        root = self.h.user_root()
        for i in range(5):
            self.h.skill(root, "s%d" % i, "widgets number %d" % i)
        fake = self.with_fake()
        self.h.build()
        self.assertEqual([len(t) for t in fake.texts("search_document")], [5])
        self.h.skill(root, "s3", "changed words")
        self.h.build()
        self.assertEqual([len(t) for t in fake.texts("search_document")], [5, 1])
        fake.dim = 12
        self.h.skill(root, "s4", "changed too")
        index = self.h.build()
        self.assertEqual([len(t) for t in fake.texts("search_document")], [5, 1, 1])
        self.assertFalse(index["dim"] == 12 and all(index["has"]))
        index = self.h.build()
        self.assertEqual((index["dim"], all(index["has"])), (12, True))
        fake.fail_paths = {"us.cohere": 400}
        self.h.skill(root, "s0", "changed again")
        index = self.h.build()
        self.assertEqual(index["model"], "global." + route.EMBED_MODEL)
        self.assertEqual(len(fake.texts("search_document")[-1]), 5)

    def test_batches_and_long_text(self):
        """skills are sent at most 96 at a time, each text cut to 2,048 characters"""
        root = self.h.user_root()
        for i in range(200):
            self.h.skill(root, "s%03d" % i, ("widgets %d " % i) + "y" * 5000)
        fake = self.with_fake()
        self.h.build()
        sizes = [len(t) for t in fake.texts("search_document")]
        self.assertEqual(sizes, [96, 96, 8])
        self.assertLessEqual(max(len(x) for t in fake.texts("search_document") for x in t), route.DOC_CHARS)

    def test_partial_vectors(self):
        """when only some vectors arrive, the index still works and skills without one keep their keyword place"""
        root = self.h.user_root()
        for i in range(100):
            self.h.skill(root, "s%03d" % i, "gadgets %d" % i)
        self.h.skill(root, "zz-wake", "wake me up widgets")
        self.with_fake()
        calls = [0]
        old = route.embed

        def flaky(texts, input_type, *a, **k):
            if input_type == "search_document":
                calls[0] += 1
                if calls[0] >= 2:
                    raise route.Transient("server error")
            return old(texts, input_type, *a, **k)
        with mock.patch("skill_route.embed", flaky), mock.patch("skill_route.time.sleep"):
            index = self.h.build()
        self.assertEqual(sum(index["has"]), 96)
        names, how, _, _ = self.h.search("wake me up widgets")
        self.assertEqual(how, "vector")
        self.assertEqual(names[0]["name"], "zz-wake")

    def test_cosine_order_and_ties(self):
        """vector results follow cosine similarity, ties go by name, and a zero query vector falls back"""
        root = self.h.user_root()
        self.h.skill(root, "b-wake", "wake soon")
        self.h.skill(root, "a-wake", "wake now")
        self.h.skill(root, "crash-and-wake", "crash wake")
        self.h.skill(root, "disk", "disk")
        fake = self.with_fake()
        self.h.build()
        names = [s["name"] for s in self.h.search("wake")[0]]
        self.assertEqual(names[:3], ["a-wake", "b-wake", "crash-and-wake"])
        fake.vectors = lambda t: [0.0] * DIM
        self.assertEqual(self.h.search("wake")[1], "keyword")


# ── I. the log, skill_search and what the extension shows ────────────────────────────────────────────────────────────


class I_Log(Case):
    def test_log_holds_no_words_of_the_user(self):
        """a message with a unique marker leaves the marker in no file of the data directory, on either path"""
        self.h.corpus()
        marker = "zq9MARKERxv7 the disk is full, clean it"
        for vector in (False, True):
            self.h.settings(skillRouteVector=vector)
            if vector and not self.fake:
                self.with_fake()
            self.h.build()
            self.h.prompt(marker)
            self.h.run({"hook_event_name": "Stop", "session_id": THREAD, "turn_id": "turn-1", "transcript_path": "/x",
                        "last_assistant_message": marker})
        for d, _, files in os.walk(self.h.data):
            for f in files:
                self.assertNotIn(b"zq9MARKERxv7", open(os.path.join(d, f), "rb").read(), f)

    def test_log_rotates_and_failure_does_not_matter(self):
        """the log is rotated past its size, and a log that cannot be written leaves the injection as it was"""
        for _ in range(4000):
            route.log(self.h.data, {"ev": "inject", "skills": ["a" * 40]})
        p = os.path.join(route.data_root(self.h.data), route.LOG_FILE)
        self.assertLessEqual(os.path.getsize(p), route.LOG_MAX + 200)
        self.assertTrue(os.path.exists(p + ".1"))
        self.h.corpus()
        self.h.build()
        os.remove(p)
        os.mkdir(p)
        self.assertIn("disk-cleanup", self.h.injected("the disk is full, clean it"))

    def test_stop_records_skill_files_read(self):
        """on Stop the turn's reads of SKILL.md files are recorded by skill name, from this turn only"""
        self.h.corpus()
        index = self.h.build()
        path = [s["path"] for s in index["skills"] if s["name"] == "disk-cleanup"][0]
        rollout = os.path.join(self.h.tmp, "rollout.jsonl")
        rows = [{"type": "turn_context", "payload": {"turn_id": "old"}},
                {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command",
                 "arguments": json.dumps({"cmd": "cat " + path.replace("disk-cleanup", "web-fetching")})}},
                {"type": "turn_context", "payload": {"turn_id": "turn-1"}},
                {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command",
                 "arguments": json.dumps({"cmd": "sed -n 1,80p " + path})}},
                {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command",
                 "arguments": json.dumps({"cmd": "cat /elsewhere/odd/SKILL.md"})}}]
        with open(rollout, "w") as fh:
            fh.write("\n".join(json.dumps(r) for r in rows) + "\n")
        code, out, err, _ = self.h.run({"hook_event_name": "Stop", "session_id": THREAD, "turn_id": "turn-1",
                                        "transcript_path": rollout, "cwd": self.h.tmp})
        self.assertEqual((code, out, err), (0, "", ""))
        rec = self.h.log()[-1]
        self.assertEqual((rec["ev"], rec["skills"], rec.get("unknown")), ("read", ["disk-cleanup"], 1))


class I_SkillSearch(Case):
    def call(self, args, name="skill_search"):
        msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": name, "arguments": args}}]
        p = subprocess.run([sys.executable, MCP], input="\n".join(json.dumps(m) for m in msgs).encode() + b"\n",
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.h.env, timeout=30)
        replies = [json.loads(l) for l in p.stdout.decode().splitlines() if l.strip()]
        return replies[1]["result"]["tools"], replies[2]["result"]

    def setUp(self):
        super().setUp()
        self.h.corpus()

    def test_tool_is_described_and_read_only(self):
        """skill_search is listed as read-only and says the model may search in its own words"""
        tools, _ = self.call({"query": "disk"})
        tool = [t for t in tools if t["name"] == "skill_search"][0]
        self.assertEqual(tool["annotations"]["readOnlyHint"], True)
        self.assertIn("own words", tool["description"])
        self.assertIn("English", tool["description"])

    def test_results_and_arguments(self):
        """it returns name, description and path, takes Chinese and long queries, and caps or refuses bad counts"""
        _, r = self.call({"query": "the disk is full"})
        self.assertFalse(r["isError"])
        first = r["content"][0]["text"].split("\n")[0]
        self.assertTrue(first.startswith("- disk-cleanup: ") and first.endswith("SKILL.md)"))
        self.assertIn("disk-cleanup", self.call({"query": "磁盘满了"})[1]["content"][0]["text"])
        self.assertFalse(self.call({"query": "disk " * 10000})[1]["isError"])
        self.assertEqual(len(self.call({"query": "cluster", "count": 500})[1]["content"][0]["text"].split("\n")),
                         min(route.SEARCH_COUNT_MAX, len([s for s in corpus.SKILLS if "cluster" in s[1].lower()])))
        for bad in ({"query": ""}, {"query": "   "}, {"query": "disk", "count": 0}, {"query": "disk", "count": -3},
                    {"query": 5}, {}, {"query": "disk", "count": "x"}):
            self.assertTrue(self.call(bad)[1]["isError"], bad)

    def test_turned_off_skills_are_not_returned(self):
        """a skill turned off in skills.config is not returned"""
        self.h.extra_config = '[[skills.config]]\nname = "disk-cleanup"\nenabled = false\n'
        self.h.write_config()
        self.assertNotIn("disk-cleanup", self.call({"query": "the disk is full"})[1]["content"][0]["text"])


# ── J. how well the keyword search finds the right skill ─────────────────────────────────────────────────────────────


class J_Quality(unittest.TestCase):
    TOP5_FLOOR = 0.85      # of QUERIES, measured 100% when this was written
    BY_NAME_FLOOR = 0.92   # first place for BY_NAME, measured 36 of 36

    @staticmethod
    def skills():
        out = []
        for n, d in corpus.SKILLS:
            m = route.TRIGGER.search(d)
            out.append({"name": n, "short": n.split(":")[-1], "desc": d, "triggers": m.group(1).strip() if m else "",
                        "path": "/x", "kind": "plugin", "root": "/r"})
        return out

    def rates(self):
        sk = self.skills()
        idx = {"keyword": route.keyword_index(sk)}
        top = lambda q, n: [sk[i]["name"] for i in route.ranked(route.keyword_scores(idx, q), sk)][:n]
        top5 = sum(1 for q, w in corpus.QUERIES if w in top(q, 5)) / len(corpus.QUERIES)
        first = sum(1 for q, w in corpus.BY_NAME if top(q, 1) == [w]) / len(corpus.BY_NAME)
        negatives = [len(top(q, 5)) for q in corpus.NEGATIVES]
        return top5, first, negatives

    def test_floors(self):
        """the right skill is in the top five for 85% or more of the requests, first for 92% of those that name it,
        and the negative sentences get no skills"""
        top5, first, negatives = self.rates()
        self.assertGreaterEqual(top5, self.TOP5_FLOOR)
        self.assertGreaterEqual(first, self.BY_NAME_FLOOR)
        self.assertEqual(sum(negatives), 0)

    def test_floors_have_teeth(self):
        """without CJK pairs the top-five floor fails, and without the weight on names the first-place floor fails"""
        orig = route.tokens
        with mock.patch("skill_route.tokens", lambda t: [x for x in orig(t) if not x.startswith("c:")]):
            self.assertLess(self.rates()[0], self.TOP5_FLOOR)
        with mock.patch("skill_route.W_NAME", route.W_DESC):
            self.assertLess(self.rates()[1], self.BY_NAME_FLOOR)


# ── K. scale and platforms ───────────────────────────────────────────────────────────────────────────────────────────


WORDS = ("cluster review fetch wake crash disk budget build deploy release test plan report ticket triage log metric "
         "query snapshot vacuum branch merge package publish token cost latency model session panel").split()


class K_Scale(Case):
    vector = True

    def timed(self, count, vector):
        root = self.h.user_root()
        for i in range(count):
            w = [WORDS[(i * k) % len(WORDS)] for k in (1, 3, 7)]
            self.h.skill(root, "skill-%04d-%s" % (i, w[0]), "Handles %s and %s for %s. Use when %s %s 第%d号" %
                         (w[0], w[1], w[2], w[1], w[2], i))
        self.h.settings(skillRouteVector=vector)
        if vector:
            fake = self.with_fake()
            fake.dim = 1536
            fake.vectors = lambda t: [math.sin(len(t) + j) for j in range(1536)]
        self.h.build()
        times = []
        with environ(self.h.env):
            for q in range(30):
                t = time.time()
                index = route.load_index(self.h.data)
                route.stale(index, self.h.codex, "", self.h.given(), self.h.data, route.codex_config(self.h.codex))
                _, how, timings, _ = route.search(index, "%s %s please" % (WORDS[q % len(WORDS)], WORDS[(q * 5) % len(WORDS)]),
                                                  5, "", time.time() + 5, self.h.data, self.h.given(),
                                                  route.codex_config(self.h.codex))
                times.append((time.time() - t) * 1000 - timings["net"])
                self.assertEqual(how, "vector" if vector else "keyword")
        times.sort()
        return statistics.median(times), times[int(len(times) * 0.95) - 1]

    def test_300_skills(self):
        """with 300 skills the local work of a turn is 100 ms or less at the median and 300 ms or less at p95, both ways"""
        for vector in (False, True):
            p50, p95 = self.timed(300, vector)
            print("        300 skills, %s: local p50 %.1f ms, p95 %.1f ms" % ("vector" if vector else "keyword", p50, p95))
            self.assertLessEqual(p50, 100)
            self.assertLessEqual(p95, 300)

    def test_2000_skills(self):
        """with 2,000 skills the local work of a turn stays under a second, both ways"""
        for vector in (False, True):
            p50, p95 = self.timed(2000, vector)
            print("        2000 skills, %s: local p50 %.1f ms, p95 %.1f ms" % ("vector" if vector else "keyword", p50, p95))
            self.assertLess(p95, 1000)


class K_Platform(Case):
    def test_windows_paths(self):
        """a Windows data directory names its Codex home, and a backslash path to a SKILL.md is matched by its folder"""
        self.assertEqual(route.home_of(r"C:\Users\me\.codex\plugins\data\agent-work-plan-codex-extras", ntpath),
                         r"C:\Users\me\.codex")
        dirs = {r"C:\work\repo\.agents\skills", r"C:\work\repo\.git"}

        class Fake:
            isabs, normpath, join, dirname = ntpath.isabs, ntpath.normpath, ntpath.join, ntpath.dirname
            isdir = staticmethod(lambda p: p in dirs)
            exists = staticmethod(lambda p: p in dirs)
        self.assertEqual(route.repo_dirs(r"C:\work\repo\src", Fake), [r"C:\work\repo\.agents\skills"])
        self.h.skill(self.h.user_root(), "disk-cleanup", "disk")
        index = self.h.build()
        rollout = os.path.join(self.h.tmp, "r.jsonl")
        with open(rollout, "w") as fh:
            fh.write(json.dumps({"type": "turn_context", "payload": {"turn_id": "t"}}) + "\n")
            fh.write(json.dumps({"type": "response_item", "payload": {"type": "function_call", "arguments": json.dumps(
                {"command": r"Get-Content C:\Users\me\.agents\skills\disk-cleanup\SKILL.md"})}}) + "\n")
        self.assertEqual(route.skills_read(plan_path.open_tail(rollout), "t", index, ""), (["disk-cleanup"], 0))

    def test_names_differing_in_case(self):
        """two skills whose names differ only in letter case, as one folder on a case-insensitive disk, are one skill"""
        a = os.path.join(self.h.tmp, "a")
        b = os.path.join(self.h.tmp, "b")
        self.h.skill(a, "Web-Fetching", "first")
        self.h.skill(b, "web-fetching", "second")
        self.h.settings(skillRouteExtraDirs=[a, b])
        self.assertEqual([s["desc"] for s in self.h.build()["skills"]], ["first"])


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for name, obj in sorted(globals().items()):
        if isinstance(obj, type) and issubclass(obj, unittest.TestCase) and obj not in (Case,) and only in name:
            suite.addTests(loader.loadTestsFromTestCase(obj))

    def said(test):
        return " ".join((test._testMethodDoc or test.id()).split())

    class Result(unittest.TextTestResult):
        def addSuccess(self, test):
            print("ok    %s" % said(test))
            sys.stdout.flush()

        def addFailure(self, test, err):
            print("FAIL  %s\n%s" % (said(test), self._exc_info_to_string(err, test)))
            self.failures.append((test, ""))

        def addError(self, test, err):
            print("FAIL  %s (error)\n%s" % (said(test), self._exc_info_to_string(err, test)))
            self.errors.append((test, ""))

        def addSkip(self, test, reason):
            print("note  %s: %s" % (said(test), reason))
            self.skipped.append((test, reason))

    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, resultclass=Result, verbosity=0).run(suite)
    bad = len(result.failures) + len(result.errors)
    print("%d passed, %d failed, %d skipped" % (result.testsRun - bad - len(result.skipped), bad, len(result.skipped)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
