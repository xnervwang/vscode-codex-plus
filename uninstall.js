// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Run by VS Code once this extension has been uninstalled (the vscode:uninstall script): puts Codex's own files back in
 * every Codex install on this machine that carries the patch. No VS Code API is available here, so the installs are
 * found by folder name in the usual extension folders.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const targets = require('./src/adapters');

const roots = [
  path.join(os.homedir(), '.vscode', 'extensions'),
  path.join(os.homedir(), '.vscode-server', 'extensions'),
  path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  path.join(os.homedir(), '.vscode-server-insiders', 'extensions'),
  path.join(os.homedir(), '.cursor', 'extensions'),
];
for (const root of roots) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (_) { continue; }
  for (const name of names.filter((n) => /^openai\.chatgpt-/.test(n))) {
    for (const t of [...targets].reverse()) {
      try { const r = t.restore(path.join(root, name)); if (r.changed) console.log(`${name}: ${t.name} ${r.message}`); } catch (_) { /* next */ }
    }
  }
}
