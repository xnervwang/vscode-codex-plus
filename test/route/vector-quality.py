#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Vector search hit rates on the made-up catalogue of corpus.py, measured against Amazon Bedrock.

    python3 test/route/vector-quality.py <codex home>

<codex home> is a Codex home whose config.toml sets the Amazon Bedrock provider with credentials (its credential_export,
profile, or the AWS environment variables), the same way Codex is set up. It reads only that config.toml and writes only
to a temporary folder. It is not part of the suite, since it needs
credentials and the network: it makes one request at a time, waits and retries on a throttle, and sends the catalogue's
descriptions and the requests of corpus.py, nothing else.

It prints the top-five hit rate, the first-place rate for name-only requests, and how many skills the negative
sentences get, for both the vector and the keyword search.
"""
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(ROOT, "codex-plugin", "agent-work-plan", "hooks"))
sys.path.insert(0, HERE)

import corpus  # noqa: E402
import skill_route as route  # noqa: E402


def embed_all(texts, model, region, aws):
    out = []
    creds = route.credentials(aws, 10)
    for start in range(0, len(texts), route.EMBED_BATCH):
        part = texts[start:start + route.EMBED_BATCH]
        for attempt in range(6):
            try:
                out += route.embed(part, "search_query", model, region, creds, 30)
                break
            except route.Transient as e:
                if attempt == 5:
                    raise
                print("  waiting after: %s" % e)
                time.sleep(2 * 2 ** attempt)
    return out


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    conf = route.codex_config(argv[1])
    aws = route.bedrock_provider(conf)
    if aws is None:
        print("%s does not set the Amazon Bedrock provider" % argv[1])
        return 2
    tmp = tempfile.mkdtemp(prefix="vector-quality-")
    try:
        home = os.path.join(tmp, "codex")
        data = os.path.join(home, "plugins", "data", "agent-work-plan-codex-extras")
        os.makedirs(data)
        shutil.copy(os.path.join(argv[1], "config.toml"), os.path.join(home, "config.toml"))
        with open(os.path.join(data, "config.json"), "w") as fh:
            json.dump({"skillRouteVector": True, "skillRouteExtraDirs": [os.path.join(tmp, "skills")]}, fh)
        for name, desc in corpus.SKILLS:
            d = os.path.join(tmp, "skills", name.replace(":", "-"))
            os.makedirs(d)
            with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
                fh.write("---\nname: %s\ndescription: %s\n---\n" % (name, json.dumps(desc, ensure_ascii=False)))
        index = route.build(data, home, "", route.settings(data))
        # The index also holds skills from the user's own folders (~/.agents/skills and the like); only the
        # catalogue's are ranked.
        mine = [i for i, s in enumerate(index["skills"]) if s["kind"] == "extra"]
        if not index.get("dim") or not all(index["has"][i] for i in mine):
            print("the skills could not all be embedded: %s" % route.vector_state(data).get("why", "unknown"))
            return 1
        skills = index["skills"]
        dim = index["dim"]
        blob = __import__("array").array("f")
        blob.frombytes(index["vectors"])
        asked = [q for q, _ in corpus.QUERIES] + [q for q, _ in corpus.BY_NAME] + list(corpus.NEGATIVES)
        vecs = embed_all([q[:route.QUERY_CHARS] for q in asked], index["model"], index["region"], aws)
        top = {}
        for q, v in zip(asked, vecs):
            scores = {i: sum(a * b for a, b in zip(v, blob[i * dim:(i + 1) * dim])) for i in mine}
            top[q] = [skills[i]["name"] for i in route.ranked(scores, skills)]
        kw = {q: [skills[i]["name"] for i in route.ranked({i: v for i, v in route.keyword_scores(index, q).items() if i in mine},
                                                          skills)] for q in asked}
        for label, got in (("vector", top), ("keyword", kw)):
            five = sum(1 for q, w in corpus.QUERIES if w in got[q][:5]) / len(corpus.QUERIES)
            first = sum(1 for q, w in corpus.BY_NAME if got[q][:1] == [w]) / len(corpus.BY_NAME)
            neg = sum(min(5, len(got[q])) for q in corpus.NEGATIVES)
            print("%-8s top five %.1f%% of %d requests; first %.1f%% of %d name-only requests; %d skills given to the %d "
                  "sentences no skill is for" % (label, 100 * five, len(corpus.QUERIES), 100 * first, len(corpus.BY_NAME),
                                                 neg, len(corpus.NEGATIVES)))
        missed = [(q, w, top[q][:3]) for q, w in corpus.QUERIES if w not in top[q][:5]]
        for q, w, t in missed:
            print("  vector missed: %r wanted %s, got %s" % (q, w, ", ".join(t)))
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
