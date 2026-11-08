// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* VS Code's webview request limit, against a client file system held in memory (test/webview-limit-check.js). */
const cp = require('child_process');
const path = require('path');

module.exports = ({ ok, bad }) => {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'webview-limit-check.js')], { encoding: 'utf8' });
  let verdicts = [];
  try { verdicts = JSON.parse(r.stdout); } catch (_) { bad(`webview-limit-check.js printed no verdicts: ${(r.stderr || r.stdout).slice(0, 300)}`); return; }
  for (const [kind, msg] of verdicts) (kind === 'ok' ? ok : bad)(msg);
};
