// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks, from inside the VS Code that run.js started, what the extension did to fresh installs on this platform: that
 * Codex's three patched files carry the patch with the originals kept beside them, and that the work plan plugin went
 * into the temporary CODEX_HOME run.js set rather than anyone's ~/.codex.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = test(); } catch (_) { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(1000);
  }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };

async function run() {
  const results = [];
  const ok = (cond, msg, detail) => {
    results.push(!!cond);
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}${cond || !detail ? '' : ': ' + detail}`);
  };
  console.log(`\nin VS Code ${vscode.version} on ${process.platform}-${process.arch}`);

  const mine = vscode.extensions.getExtension('xnervwang.codex-plus');
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  const core = vscode.extensions.getExtension('xnervwang.agent-plus');
  ok(!!mine, 'this extension is installed');
  ok(!!codex, 'Codex is installed', codex ? '' : 'not found');
  ok(!!core, 'Agent Plus is installed', core ? '' : 'not found');
  if (!mine || !codex || !core) throw new Error('an extension is missing');
  /* The installed copy's modules: that copy did the patching. */
  const from = (name) => require(path.join(mine.extensionPath, 'src', name));
  const ADAPTERS = from('adapters'), install = from('plugin-install'), files = from('codex-files');
  console.log(`  Codex ${codex.packageJSON.version} at ${codex.extensionPath}`);
  let activated = '';
  try { await mine.activate(); } catch (e) { activated = e && e.message; }
  ok(!activated && mine.isActive, 'this extension activates', activated);

  for (const a of ADAPTERS) {
    const file = a.targetFile(codex.extensionPath);
    const patched = await until(() => a.status(codex.extensionPath) === 'patched', 120000);
    ok(patched, `${a.name}: patched`, `${a.status(codex.extensionPath)}: ${file}`);
    const backup = read(file + a.BACKUP_SUFFIX);
    ok(backup && !backup.includes(a.ANY_MARK), `${a.name}: Codex's own file is kept beside it, unpatched`, file + a.BACKUP_SUFFIX);
  }

  const home = files.codexHome();
  ok(home === process.env.CODEX_HOME, 'the extension reads the CODEX_HOME run.js made', home);
  ok(await until(() => install.installedVersions(home).length > 0, 180000), 'the work plan plugin is in that Codex home',
    `nothing in ${install.cacheDir(home)}`);
  ok(install.pluginLoadState(home) === 'loaded', 'and Codex is set to load it', install.pluginLoadState(home));

  const failures = results.filter((r) => !r).length;
  console.log(`\nin VS Code: ${results.length - failures} passed, ${failures} failed`);
  if (failures) throw new Error(`${failures} check(s) failed`);
}

module.exports = { run };
