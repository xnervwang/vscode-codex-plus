// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One window bringing an older patch up to this build while another puts Codex's file back ("Remove the Patch from
 * Codex", or the uninstall hook). The upgrade patches from the backup, the copy of Codex's own file, and a restore
 * moves that backup over the file. Run between the upgrade reading the backup and writing its patch, the restore takes
 * the backup away, and the upgrade would then leave a patched file with nothing to restore it from.
 *
 * The restore is run from inside the upgrade's read of the backup, right after it returns, which is that moment. The
 * files are copies of the installed Codex's originals, aged to an older patch the way test/parts/50-patch.js ages them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function codexInstall() {
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names) if (/^openai\.chatgpt-/.test(n) && fs.existsSync(path.join(root, n, 'out', 'extension.js'))) return path.join(root, n);
  }
  return '';
}

module.exports = async ({ eq, note, tmp }) => {
  const host = require('../../src/host');
  const page = require('../../src/webview-inject');
  const src = codexInstall();
  if (!src) { note('no Codex extension installed here: a restore during an upgrade is not tried against its files'); return; }
  for (const t of [host, page]) {
    const pristine = fs.readFileSync(fs.existsSync(t.targetFile(src) + t.BACKUP_SUFFIX) ? t.targetFile(src) + t.BACKUP_SUFFIX : t.targetFile(src));
    const dir = tmp(`upgrade-race-${t.name.replace(/\W+/g, '-')}`);
    fs.mkdirSync(path.join(dir, 'out'));
    fs.mkdirSync(path.join(dir, 'webview'));
    const file = t.targetFile(dir), backup = file + t.BACKUP_SUFFIX;
    fs.writeFileSync(file, pristine);
    t.apply(dir);
    const text = fs.readFileSync(file, 'utf8');
    const dash = text.indexOf('-', text.indexOf(t.ANY_MARK) + t.ANY_MARK.length);
    fs.writeFileSync(file, `${text.slice(0, dash + 1)}d00000000000${text.slice(dash + 13)}`);
    const before = t.status(dir);

    const realRead = fs.readFileSync;
    let restored = null;
    fs.readFileSync = function (p, ...rest) {
      const out = realRead.call(fs, p, ...rest);
      if (p === backup && restored === null) { restored = 'running'; fs.readFileSync = realRead; restored = t.restore(dir).message; }
      return out;
    };
    let r;
    try { r = t.apply(dir); } finally { fs.readFileSync = realRead; }
    eq([before, restored, r && r.current], ['outdated', 'restored', true], `${t.name}: the restore ran in the middle of the upgrade`);
    const now = t.status(dir);
    eq([now, fs.existsSync(backup) && !realRead(backup, 'utf8').includes(t.ANY_MARK)], [now, now === 'patched'],
      `${t.name}: whichever finished last, a patched file is left with its backup`);
    t.restore(dir);
    eq([t.status(dir), realRead(file).equals(pristine)], ['clean', true], `${t.name}: so Codex's own file can still be put back`);
  }
};
