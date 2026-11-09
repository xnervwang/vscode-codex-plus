// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A short-lived client of `codex app-server`, the JSON-RPC interface Codex's own VS Code extension talks to.
 *
 * Everything this extension changes in Codex's configuration goes through it rather than through an edit of
 * config.toml: the app-server takes Codex's own lock on the file, keeps its formatting, and tells running threads to
 * reload. Each use starts its own process with the CODEX_HOME it is told, sends its requests in order, and stops it.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

/*
 * The codex program the Codex extension runs: the one it ships under bin/<platform>/, unless the user pointed
 * `chatgpt.cliExecutable` at another. `extensionPath` is the Codex extension's folder.
 */
function codexBinary(extensionPath, configured = '') {
  if (configured && fs.existsSync(configured)) return configured;
  if (!extensionPath) return '';
  const bin = path.join(extensionPath, 'bin');
  let dirs;
  try { dirs = fs.readdirSync(bin); } catch (_) { return ''; }
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] || process.arch;
  const plat = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform] || process.platform;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const want = dirs.find((d) => d.startsWith(plat) && d.includes(arch)) || dirs.find((d) => d.startsWith(plat)) || dirs[0];
  const file = want ? path.join(bin, want, exe) : '';
  return file && fs.existsSync(file) ? file : '';
}

class AppServer {
  /** `binary` is a codex program; `codexHome` the CODEX_HOME it runs with (empty keeps the environment's). */
  constructor(binary, codexHome = '', { timeoutMs = 60000 } = {}) {
    this.binary = binary;
    this.codexHome = codexHome;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = '';
    this.stderr = '';
  }

  start() {
    if (this.child) return Promise.resolve();
    const env = { ...process.env };
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    this.child = cp.spawn(this.binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-8000); });
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`codex app-server exited (${code}): ${this.stderr.slice(-400)}`));
      this.pending.clear();
      this.child = null;
    });
    this.child.on('error', (e) => {
      for (const { reject } of this.pending.values()) reject(e);
      this.pending.clear();
    });
    return this.request('initialize', {
      clientInfo: { name: 'codex-plus', title: 'Codex Plus', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }).then((r) => { this.notify('initialized'); return r; });
  }

  onData(d) {
    this.buffer += d;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id == null || !this.pending.has(msg.id)) continue;
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.message || 'app-server error'), { rpc: msg.error }));
      else resolve(msg.result);
    }
  }

  notify(method, params) {
    if (this.child) this.child.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('codex app-server is not running')); return; }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server did not answer ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  stop() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch (_) { /* closed */ }
    try { this.child.kill(); } catch (_) { /* gone */ }
    this.child = null;
  }
}

/** Run `fn(server)` against a fresh app-server and stop it afterwards, whatever happens. */
async function withAppServer(binary, codexHome, fn, opts) {
  const server = new AppServer(binary, codexHome, opts);
  try {
    await server.start();
    return await fn(server);
  } finally { server.stop(); }
}

module.exports = { AppServer, withAppServer, codexBinary };
