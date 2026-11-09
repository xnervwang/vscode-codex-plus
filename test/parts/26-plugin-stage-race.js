// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Several windows installing the plugin at once. Every window of an editor stages the marketplace in the same folder
 * of this extension's global storage, Codex copies the plugin from there into its cache, and each window runs the
 * start-up install three seconds after it activates, so after an update the windows restored together all install at
 * once.
 *
 *   staging      the folder Codex copies from is never seen empty or half written: the copy is built beside it and
 *                put in its place in one step, as Claude Code Plus stages its plugin
 *   installing   a second install waits for the first to finish with Codex before it stages anything
 *
 * The stand-in codex program is the one test/parts/22-plugin-update.js describes, made slow at plugin/install and
 * writing its own process id beside each request, so two installs can be told apart in its log.
 */
const fs = require('fs');
const path = require('path');

const FAKE_APP_SERVER = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
const log = path.join(home, 'fake-codex-requests.jsonl');
let buf = '';
const answer = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
const handle = (msg) => {
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, method: msg.method }) + '\\n');
  if (msg.method === 'marketplace/add') answer(msg.id, { installedRoot: msg.params.source });
  else if (msg.method === 'plugin/install') setTimeout(() => answer(msg.id, {}), 400);
  else if (msg.method === 'config/batchWrite') answer(msg.id, { status: 'ok' });
  else answer(msg.id, {});
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) handle(msg);
  }
});
`;

const listing = (dir) => {
  const out = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
};

module.exports = async ({ eq, note, tmp }) => {
  const install = require('../../src/plugin-install');

  /* ── staging, watched from inside the copy ── */
  const stage = path.join(tmp('global-storage'), 'marketplace');
  install.stageMarketplace(stage, install.SOURCE, install.SHIPPED_PYTHON);
  const whole = listing(stage);
  const realCp = fs.cpSync;
  const seen = [];
  fs.cpSync = function (...args) {
    seen.push(listing(stage));
    return realCp.apply(this, args);
  };
  try { install.stageMarketplace(stage, install.SOURCE, install.SHIPPED_PYTHON); } finally { fs.cpSync = realCp; }
  eq([seen.length, seen.every((l) => JSON.stringify(l) === JSON.stringify(whole))], [1, true],
    'while the marketplace is staged again, the folder Codex copies from still holds the whole earlier copy');
  eq(listing(stage), whole, 'and afterwards it holds the whole new one');
  eq(fs.readdirSync(path.dirname(stage)).filter((n) => n !== 'marketplace'), [], 'with nothing left beside it');

  /* ── two installs at once ── */
  if (process.platform === 'win32') { note('the stand-in codex is a shell script, so two installs at once are not run here'); return; }
  const bin = tmp('fake-codex-slow');
  fs.writeFileSync(path.join(bin, 'app-server.js'), FAKE_APP_SERVER);
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, 'app-server.js'))}\n`);
  fs.chmodSync(codex, 0o755);
  const home = tmp('codex-home-two-installs');
  const shared = path.join(tmp('global-storage-shared'), 'marketplace');
  await Promise.all([
    install.install({ binary: codex, home, stage: shared, python: install.SHIPPED_PYTHON }),
    install.install({ binary: codex, home, stage: shared, python: install.SHIPPED_PYTHON }),
  ]);
  const log = fs.readFileSync(path.join(home, 'fake-codex-requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pids = [...new Set(log.map((r) => r.pid))];
  const runs = log.map((r) => r.pid).filter((p, i, a) => i === 0 || a[i - 1] !== p).length;
  eq([pids.length, runs], [2, 2], 'two installs at once talk to Codex one after the other, not interleaved');
  eq(listing(shared), whole, 'and leave the staged marketplace whole');
};
