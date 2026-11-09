// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A backup of Codex's file that could not be written whole. Patching is all or nothing across the two targets
 * (src/patching.js ensurePatched), so a target that fails puts back every target, and putting one back moves its backup
 * over Codex's file. A backup cut short by a full disk would then become Codex's file.
 *
 * The disk fills while the page's backup is being written, after the host's has been patched, which is the order the
 * targets are applied in; the write that fails leaves the first ten bytes behind, as a write to a full disk does. The
 * files are copies of the installed Codex's originals.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../fake-vscode');

function codexInstall() {
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const n of names) if (/^openai\.chatgpt-/.test(n) && fs.existsSync(path.join(root, n, 'out', 'extension.js'))) return path.join(root, n);
  }
  return '';
}

module.exports = async ({ eq, note, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const host = require('../../src/host');
  const page = require('../../src/webview-inject');
  const patching = require('../../src/patching');
  const src = codexInstall();
  if (!src) { note('no Codex extension installed here: a backup cut short is not tried against its files'); return; }
  const original = (t) => fs.readFileSync(fs.existsSync(t.targetFile(src) + t.BACKUP_SUFFIX) ? t.targetFile(src) + t.BACKUP_SUFFIX : t.targetFile(src));
  const origHost = original(host), origPage = original(page);
  const copyOf = (label) => {
    const dir = tmp(label);
    fs.mkdirSync(path.join(dir, 'out'));
    fs.mkdirSync(path.join(dir, 'webview'));
    fs.writeFileSync(host.targetFile(dir), origHost);
    fs.writeFileSync(page.targetFile(dir), origPage);
    return dir;
  };

  /* ── the disk fills while the page's backup is written ── */
  const dir = copyOf('codex-disk-full');
  control.state.extensions.set('openai.chatgpt', { extensionPath: dir, packageJSON: { version: '26.1021.22027' } });
  const pageBackup = page.targetFile(dir) + page.BACKUP_SUFFIX;
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, data, ...rest) {
    if (typeof file === 'string' && file.startsWith(pageBackup)) {
      realWrite.call(fs, file, String(data).slice(0, 10));
      const e = new Error('ENOSPC: no space left on device, write');
      e.code = 'ENOSPC';
      throw e;
    }
    return realWrite.call(fs, file, data, ...rest);
  };
  try { await patching.ensurePatched(vscode, { globalState: fake.memento() }, () => {}, 'on'); } finally { fs.writeFileSync = realWrite; }
  eq([fs.readFileSync(host.targetFile(dir)).equals(origHost), fs.readFileSync(page.targetFile(dir)).equals(origPage)], [true, true],
    'a backup the disk could not hold leaves both of Codex\'s files exactly as they were');
  eq([fs.readdirSync(path.join(dir, 'out')), fs.readdirSync(path.join(dir, 'webview'))], [['extension.js'], ['index.html']],
    'with nothing left beside them');

  /* ── a backup that cannot be Codex's file is not put back ── */
  for (const [t, label, bad] of [[host, 'an empty host backup', ''], [host, 'a host backup that does not parse', 'function ('],
    [page, 'an empty page backup', ''], [page, 'a page backup without Codex\'s entry script', '<html><body></body></html>']]) {
    const d = copyOf(`codex-bad-backup-${label.replace(/\W+/g, '-')}`);
    t.apply(d);
    const patched = fs.readFileSync(t.targetFile(d));
    fs.writeFileSync(t.targetFile(d) + t.BACKUP_SUFFIX, bad);
    const r = t.restore(d);
    eq([r.changed, fs.readFileSync(t.targetFile(d)).equals(patched)], [false, true], `${label} is not moved over Codex's file`);
  }
};
