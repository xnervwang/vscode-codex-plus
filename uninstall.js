// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Run by VS Code once this extension has been uninstalled (the vscode:uninstall script), and started by deactivate as
 * soon as the extension host restarts after an uninstall (src/uninstall-plan.js finishUninstall), since VS Code itself
 * runs it only when it deletes the folder, which in remote development is the next start of the remote server. So it
 * usually runs twice, and every step is safe to repeat. No VS Code API is available here, so Codex is found by folder
 * name.
 *
 * It puts Codex's own files back in the extensions folder this copy was installed in, and in any other editor's on this
 * machine that no longer holds a copy of this extension. Another editor that still holds one leaves its Codex to that
 * copy.
 *
 * Once no editor holds a copy, it removes the work plan plugin from Codex (src/plugin-install.js uninstall):
 * the plans are copied to CODEX_HOME first, and nothing is removed when they cannot be. A plugin already gone is
 * left alone, and so is one no codex program is left to remove; the hooks of such a plugin do nothing once VS Code has
 * deleted this extension's global storage (src/plugin-install.js writeHookSettings).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const targets = require('./src/adapters');
const plan = require('./src/uninstall-plan');
const install = require('./src/plugin-install');
const { codexBinary } = require('./src/appserver');

const manifest = (() => { try { return require('./package.json'); } catch (_) { return {}; } })();
const id = manifest.publisher && manifest.name ? `${manifest.publisher}.${manifest.name}` : plan.ID;
const ids = [id, ...plan.FORMER_IDS];
const extensionsDir = path.dirname(__dirname);

for (const root of plan.restoreDirs(extensionsDir, { id: ids })) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (_) { continue; }
  for (const name of names.filter((n) => /^openai\.chatgpt-/.test(n))) {
    for (const t of [...targets].reverse()) {
      try { const r = t.restore(path.join(root, name)); if (r.changed) console.log(`${name}: ${t.name} ${r.message}`); } catch (_) { /* next */ }
    }
  }
}

/* A second run started while the first is still removing the plugin leaves it to the first. */
const LOCK_STALE_MS = 120000;
function takeLock(home) {
  const lock = path.join(os.tmpdir(), `codex-plus-removing-${crypto.createHash('sha256').update(home).digest('hex').slice(0, 16)}`);
  for (let i = 0; i < 2; i++) {
    try { fs.mkdirSync(lock); return lock; } catch (e) {
      if (!e || e.code !== 'EEXIST') return '';
      let old = false;
      try { old = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch (_) { continue; }
      if (!old) return '';
      try { fs.rmdirSync(lock); } catch (_) { return ''; }
    }
  }
  return '';
}

async function removePlugin() {
  if (!plan.lastCopy(extensionsDir, { id: ids })) return;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!install.installedVersions(home).length) return;
  const own = path.resolve(extensionsDir);
  const binary = [own, ...plan.roots(own).filter((d) => d !== own)].flatMap((d) => plan.codexInstalls(d))
    .map((d) => codexBinary(d)).find(Boolean);
  if (!binary) return;
  const lock = takeLock(home);
  if (!lock) return;
  try {
    const kept = await install.uninstall({ binary, home });
    console.log(`removed the work plan plugin from ${home}${kept ? `; the plans were copied to ${kept}` : ''}`);
  } catch (e) {
    console.log(`the work plan plugin was not removed from ${home}: ${(e && e.message) || e}`);
  } finally {
    try { fs.rmdirSync(lock); } catch (_) { /* gone */ }
  }
}

removePlugin();
