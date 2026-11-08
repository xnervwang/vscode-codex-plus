// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Everything shipped parses, and the manifest says what the task fixed it to say. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function jsFiles(root) {
  const out = ['extension.js', 'uninstall.js'];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.js')) out.push(r);
    }
  };
  for (const d of ['src', 'build', 'test']) if (fs.existsSync(path.join(root, d))) walk(d);
  return out;
}

module.exports = ({ ok, bad, eq, root }) => {
  for (const f of jsFiles(root)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    try {
      // Wrapped the way Node wraps a CommonJS module, so a top-level `return` parses as it does at run time.
      new vm.Script(`(function (exports, require, module, __filename, __dirname) {${text}\n})`, { filename: f });
      ok(`${f} parses`);
    } catch (e) { bad(`${f}: ${e.message}`); }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  eq([pkg.publisher, pkg.name, pkg.displayName], ['xnervwang', 'codex-extras', 'Codex Extras'], 'extension identity');
  eq(pkg.version, '0.1.0', 'version stays 0.1.0');
  eq(pkg.extensionDependencies, ['openai.chatgpt'], 'depends on the Codex extension');
  const header = /^(\/\/|#) BSD 3-Clause License\n\1 Copyright \(c\) 2026, Xnerv Wang\n\1 All rights reserved\./;
  const missing = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { if (e.name !== '__pycache__' && !e.name.startsWith('.')) walk(r); continue; }
      if (!/\.(js|py|sh)$/.test(e.name)) continue;
      let text = fs.readFileSync(path.join(root, r), 'utf8');
      text = text.replace(/^#!.*\n/, '');
      if (!header.test(text)) missing.push(r);
    }
  };
  walk('.');
  if (missing.length) bad(`missing copyright header: ${missing.join(', ')}`);
  else ok('every source file carries the copyright header');
};
