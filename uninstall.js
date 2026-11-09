// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Run by VS Code once this extension has been uninstalled (the vscode:uninstall script): puts Codex's own files back in
 * the Codex installs beside it. No VS Code API is available here, so they are found by folder name.
 *
 * Only in the extensions folder this copy was installed in, which is the one it runs from. Another editor on the same
 * machine (Insiders, the desktop build, a Remote SSH server) has its own copy of this extension, or none, and its Codex
 * is that copy's to patch and to put back.
 */
const fs = require('fs');
const path = require('path');
const targets = require('./src/adapters');

const roots = [path.dirname(__dirname)];
for (const root of roots) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (_) { continue; }
  for (const name of names.filter((n) => /^openai\.chatgpt-/.test(n))) {
    for (const t of [...targets].reverse()) {
      try { const r = t.restore(path.join(root, name)); if (r.changed) console.log(`${name}: ${t.name} ${r.message}`); } catch (_) { /* next */ }
    }
  }
}
