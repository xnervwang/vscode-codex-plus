// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The whole suite, with no dependencies. Run it after every change:
 *
 *   node test/check.js
 *
 * Each file in test/parts/ is one subject and is run in file-name order. A part exports a function taking the shared
 * harness (ok, bad, note, eq, tmp, root); a part that cannot run here (no Codex install, no Python) says so with note()
 * rather than passing silently, and the count of those is printed with the total.
 *
 * The extension host reads Codex's state database through node:sqlite. A Node that has it only behind a flag is
 * restarted with the flag, so the same checks run whichever Node is on PATH.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.CODEX_EXTRAS_CHECK_CHILD) {
  let has = true;
  try { require('node:sqlite'); } catch (_) { has = false; }
  if (!has) {
    const r = cp.spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, CODEX_EXTRAS_CHECK_CHILD: '1' } });
    process.exit(r.status == null ? 1 : r.status);
  }
}

const root = path.join(__dirname, '..');
let passed = 0, failures = 0, skipped = 0;
const ok = (msg) => { passed++; console.log('  ok    ' + msg); };
const bad = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const note = (msg) => { skipped++; console.log('  note  ' + msg); };
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok(msg); else bad(`${msg}: got ${g}, want ${w}`);
};
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-extras-check-'));
let n = 0;
/** A fresh empty directory for one check, removed with the rest when the suite ends. */
const tmp = (name = 'd') => { const d = path.join(scratch, `${++n}-${name}`); fs.mkdirSync(d, { recursive: true }); return d; };
/* The extension reads its Codex home from CODEX_HOME alone. A part sets it to a home of its own before activating, and
   this one stands in otherwise, so nothing the suite starts can reach the user's own ~/.codex. */
process.env.CODEX_HOME = tmp('default-codex-home');

const only = process.argv[2] || '';
(async () => {
  const dir = path.join(__dirname, 'parts');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    if (only && !f.includes(only)) continue;
    console.log(`\n── ${f.replace(/\.js$/, '')}`);
    try {
      await require(path.join(dir, f))({ ok, bad, note, eq, tmp, root });
    } catch (e) {
      bad(`${f} threw: ${e && e.stack || e}`);
    }
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* left for the OS */ }
  console.log(`\n${passed} passed, ${failures} failed, ${skipped} could not run here`);
  process.exit(failures ? 1 : 0);
})();
