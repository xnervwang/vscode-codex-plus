# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Loaded by any Python started with this folder on PYTHONPATH: records, and with ROUTE_GUARD=deny refuses, every
network connection, every name lookup, every program started and every credential file opened, into the file named by
ROUTE_GUARD_LOG. The skill routing tests put it under the hook to prove which paths never touch any of them.

The one program it lets through is the index rebuild the hook starts (skill_route.py --build), which runs under this
same guard.
"""
import builtins
import io
import json
import os

LOG = os.environ.get("ROUTE_GUARD_LOG")
MODE = os.environ.get("ROUTE_GUARD")

if LOG and MODE in ("deny", "record"):
    import socket
    import subprocess

    def note(kind, what):
        with real_open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"pid": os.getpid(), "kind": kind, "what": str(what)[:300]}) + "\n")

    def refuse(kind, what):
        note(kind, what)
        if MODE == "deny":
            raise OSError("refused by the test guard: %s %s" % (kind, what))

    real_open = builtins.open
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo
    real_popen_init = subprocess.Popen.__init__

    def connect(self, address):
        refuse("connect", address)
        return real_connect(self, address)

    def connect_ex(self, address):
        refuse("connect", address)
        return real_connect_ex(self, address)

    def getaddrinfo(host, *args, **kwargs):
        refuse("lookup", host)
        return real_getaddrinfo(host, *args, **kwargs)

    def popen_init(self, args, *rest, **kwargs):
        argv = list(args) if isinstance(args, (list, tuple)) else [args]
        rebuild = len(argv) > 2 and str(argv[1]).endswith("skill_route.py") and argv[2] == "--build"
        if not rebuild:
            refuse("program", argv)
        return real_popen_init(self, args, *rest, **kwargs)

    def guarded_open(file, *args, **kwargs):
        p = str(file)
        parts = p.replace("\\", "/").split("/")
        if ".aws" in parts or parts[-1] in ("auth.json", "credentials"):
            refuse("open", p)
        return real_open(file, *args, **kwargs)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.getaddrinfo = getaddrinfo
    subprocess.Popen.__init__ = popen_init
    builtins.open = guarded_open
    io.open = guarded_open
