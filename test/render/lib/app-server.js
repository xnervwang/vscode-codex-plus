// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's own app-server, the program in the installed Codex extension, run against a made-up CODEX_HOME inside a
 * network namespace that has no network at all (`unshare -rn`). JSON-RPC over stdio, one message per line.
 */
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { started } = require('./cdp');

/* Whether this machine lets an unprivileged user make a namespace with no network; '' when it does, else why not. */
function offlineProblem() {
  const r = spawnSync('unshare', ['-rn', 'true'], { encoding: 'utf8' });
  if (r.error) return `unshare could not be run (${r.error.code || r.error.message})`;
  return r.status === 0 ? '' : `unshare -rn failed: ${(r.stderr || '').trim().slice(0, 200)}`;
}

function start({ binary, codexHome, home, version, log }) {
  const env = { PATH: process.env.PATH, CODEX_HOME: codexHome, HOME: home, LANG: 'C.UTF-8', RUST_LOG: 'warn',
    HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  const proc = started(spawn('unshare', ['-rn', binary, 'app-server'], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] }));
  const logStream = fs.createWriteStream(log);
  proc.stderr.on('data', (d) => logStream.write(d));
  let buf = '', next = 1;
  const pending = new Map();
  const handlers = { notification: null, request: null };
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(String(msg.id))) {
        const p = pending.get(String(msg.id));
        pending.delete(String(msg.id));
        p(msg);
      } else if (msg.id !== undefined && msg.method) { if (handlers.request) handlers.request(msg); } else if (msg.method && handlers.notification) handlers.notification(msg);
    }
  });
  const write = (m) => { try { proc.stdin.write(JSON.stringify(m) + '\n'); } catch (_) { /* gone */ } };
  /* `id` may be the page's own; the reply is matched back by it. */
  const request = (method, params, id) => new Promise((resolve) => {
    const rid = id !== undefined ? id : `h${next++}`;
    pending.set(String(rid), resolve);
    write({ id: rid, method, params });
  });
  const notify = (method, params) => write({ method, params });
  const respond = (id, result) => write({ id, result });
  const ready = request('initialize', { clientInfo: { name: 'codex_vscode', title: 'Codex Extension', version },
    capabilities: { experimentalApi: true } }).then((r) => { notify('initialized', {}); return r; });
  const stop = () => { try { proc.kill('SIGKILL'); } catch (_) { /* gone */ } logStream.end(); };
  return { request, notify, respond, ready, stop, handlers };
}

module.exports = { start, offlineProblem };
