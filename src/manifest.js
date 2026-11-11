// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch target in Codex's package.json: a "when" on Codex's button on the editor tab bar, so that VS Code hides it
 * while this extension shows its own. Codex titles that button "Open Codex Sidebar" whatever codexPlus.tabBarButton
 * says, and a command's title can only be changed in its manifest. Without this extension running the context key is
 * never set, and the clause shows Codex's button.
 *
 * VS Code keeps the manifests it scanned in a cache, which it uses again until the modification time of the profile's
 * extensions.json changes.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { applyEdits, shapesOf } = require('./edits');
const { patchTarget } = require('./patch-target');

const VERSION = 1;
const ANY_MARK = 'CODEX-EXTRAS-MANIFEST v';
const BACKUP_SUFFIX = '.codex-extras-manifest.bak';
const TMP_SUFFIX = '.codex-extras-manifest.tmp';
const CONTEXT_KEY = 'codexPlus.ownsTabBarButton';
const WHEN = `!${CONTEXT_KEY}`;
/* JSON has no comments, so the mark goes in an extra key of the button's menu entry. */
const MARK_KEY = 'codexExtrasPatch';

const EDITS = [{
  name: 'tab bar button when',
  re: /\{(\s*)"command"\s*:\s*"chatgpt\.openSidebar"\s*,\s*"group"\s*:\s*"navigation"(\s*)\}/g,
  to: (m, inner, end) => `${m.slice(0, m.length - end.length - 1)},${inner}"when": ${JSON.stringify(WHEN)},`
    + `${inner}"${MARK_KEY}": ${JSON.stringify(MARK)}${end}}`,
}];

const MARK = ANY_MARK + VERSION + '-' + crypto.createHash('sha256')
  .update(EDITS.map((e) => [e.name, ...shapesOf(e).map((s) => [String(s.re), String(s.to), s.note || ''].join('\0'))].join('\0')).join('\n'))
  .digest('hex').slice(0, 12);

const manifestFile = (codexExtensionPath) => path.join(codexExtensionPath, 'package.json');
const titleBar = (m) => (m && m.contributes && m.contributes.menus && Array.isArray(m.contributes.menus['editor/title'])
  ? m.contributes.menus['editor/title'] : []);

function carries(m) {
  return titleBar(m).some((i) => !!i && i.command === 'chatgpt.openSidebar' && i.when === WHEN);
}

function patchSource(src) {
  if (src.includes(ANY_MARK)) return { error: 'the manifest already carries a patch' };
  let before;
  try { before = JSON.parse(src); } catch (e) { return { error: `the manifest is not JSON: ${e.message}` }; }
  const r = applyEdits(src, EDITS, 'Codex');
  if (r.error) return { error: r.error };
  let after;
  try { after = JSON.parse(r.out); } catch (e) { return { error: `the patched manifest is not JSON: ${e.message}` }; }
  const want = JSON.parse(JSON.stringify(before));
  const entries = titleBar(want).filter((i) => !!i && i.command === 'chatgpt.openSidebar');
  if (entries.length === 1) Object.assign(entries[0], { when: WHEN, [MARK_KEY]: MARK });
  if (entries.length !== 1 || JSON.stringify(want) !== JSON.stringify(after)) return { error: 'the edit did not land on the tab bar button alone' };
  return { out: r.out, chosen: r.chosen };
}

function usableBackup(text) {
  try { JSON.parse(text); } catch (_) { return false; }
  return new RegExp(EDITS[0].re.source).test(text);
}

/* The default profile's extensions.json is in the extensions folder that holds Codex's own. */
function touchProfile(codexExtensionPath) {
  const file = path.join(path.dirname(path.resolve(codexExtensionPath)), 'extensions.json');
  const now = new Date();
  try { fs.utimesSync(file, now, now); } catch (_) { /* no extensions.json here: nothing to do */ }
}

const target = patchTarget({
  file: manifestFile, mark: MARK, anyMark: ANY_MARK, backupSuffix: BACKUP_SUFFIX, tmpTag: TMP_SUFFIX,
  transform: patchSource, usableBackup,
  afterRestore: (dir, r) => { if (r && r.changed) touchProfile(dir); },
  say: {
    missing: (file) => `Codex manifest not found at ${file}`,
    noBackup: 'an older patch is present but its backup is missing; reinstall Codex',
    markedBackup: 'an older patch is present and its backup carries one too; reinstall Codex',
    badBackup: 'backup is not a Codex manifest; not restored, reinstall Codex',
  },
});

function apply(dir) {
  const r = target.apply(dir);
  if (r.changed) touchProfile(dir);
  return r;
}

/* standsAlone: applied on its own rather than all or nothing with the host and page patches, which work without it. */
module.exports = {
  id: 'openai.chatgpt', name: 'Codex manifest', standsAlone: true, VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, MARK_KEY, WHEN, CONTEXT_KEY,
  EDITS, patchSource, carries, status: target.status, apply, restore: target.restore, targetFile: manifestFile,
};
