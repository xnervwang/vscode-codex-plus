// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch target in Codex's page: webview/index.html, which Codex reads from disk each time it builds a page and
 * fills in with its base and content-security tags.
 *
 * The page's policy runs scripts from the extension's own folder and no inline ones, so the addition is a file,
 * webview/codex-extras-page.js, copied from src/page/, and one module script tag for it placed ahead of Codex's own entry
 * script, so it runs first. The tag carries the digest of the script, so a page patched by an older version is
 * recognised as outdated.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyEdits, moveBack } = require('./edits');

const PAGE_FILE = 'codex-extras-page.js';
const PAGE_SOURCE = path.join(__dirname, 'page', PAGE_FILE);
const ANY_MARK = '<!-- CODEX-EXTRAS-PAGE v';
const BACKUP_SUFFIX = '.codex-extras-page.bak';
const VERSION = 1;

const pageScript = () => fs.readFileSync(PAGE_SOURCE, 'utf8');
const mark = () => `${ANY_MARK}${VERSION}-${crypto.createHash('sha256').update(pageScript()).digest('hex').slice(0, 12)} -->`;

const EDITS = [{
  name: 'page script',
  re: /(<script type="module" crossorigin src="\.\/assets\/index-[\w-]+\.js"><\/script>)/g,
  to: (m, entry) => `${mark()}<script type="module" src="./${PAGE_FILE}"></script>\n    ${entry}`,
}];

const htmlFile = (codexExtensionPath) => path.join(codexExtensionPath, 'webview', 'index.html');

/** Pure transform of index.html. Returns { out } or { error }. */
function patchSource(html) {
  if (html.includes(ANY_MARK)) return { error: 'the page already carries a patch' };
  try { new vm.Script(pageScript(), { filename: PAGE_FILE }); } catch (e) { return { error: `the page script does not parse: ${e.message}` }; }
  const r = applyEdits(html, EDITS);
  return r.error ? { error: r.error } : { out: r.out, chosen: r.chosen };
}

function status(codexExtensionPath) {
  const file = htmlFile(codexExtensionPath);
  if (!fs.existsSync(file)) return 'missing';
  const html = fs.readFileSync(file, 'utf8');
  if (html.includes(mark()) && fs.existsSync(path.join(path.dirname(file), PAGE_FILE))) return 'patched';
  if (html.includes(ANY_MARK)) return 'outdated';
  return 'clean';
}

function writeAtomic(file, text) {
  const tmp = `${file}.codex-extras.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

function apply(codexExtensionPath) {
  const file = htmlFile(codexExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const state = status(codexExtensionPath);
  if (state === 'missing') return { changed: false, current: false, message: `Codex page not found at ${file}` };
  if (state === 'patched') return { changed: false, current: true, message: 'already patched' };
  const original = state === 'outdated' ? (fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : '') : fs.readFileSync(file, 'utf8');
  if (!original || original.includes(ANY_MARK)) return { changed: false, current: false, message: 'an older page patch is present without a clean backup; reinstall Codex' };
  const r = patchSource(original);
  if (r.error) return { changed: false, current: false, message: r.error };
  /* Written as the patched file is: a backup cut short would be put back over Codex's page by the next restore. */
  if (state === 'clean') writeAtomic(backup, original);
  writeAtomic(path.join(path.dirname(file), PAGE_FILE), pageScript());
  writeAtomic(file, r.out);
  /* A restore in another window can have moved the backup over the page since it was read; the page is patched now,
     so its backup is put back from the copy just patched from. */
  if (!fs.existsSync(backup)) writeAtomic(backup, original);
  return { changed: true, current: true, message: 'patched' };
}

/* Whether a backup can stand for Codex's page: one holding the entry script the patch anchors on, as the page it was
   taken from did. Anything else is not put back over it. */
const usableBackup = (html) => new RegExp(EDITS[0].re.source).test(html);

function restore(codexExtensionPath) {
  const file = htmlFile(codexExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  if (!usableBackup(original)) return { changed: false, message: 'backup is not a Codex page; not restored, reinstall Codex' };
  const r = moveBack(backup, file);
  /* Unless another window has patched the page again since the move: the script then belongs to that patch. */
  let clean = false;
  try { clean = !fs.readFileSync(file, 'utf8').includes(ANY_MARK); } catch (_) { /* gone */ }
  if (r.changed && clean) { try { fs.unlinkSync(path.join(path.dirname(file), PAGE_FILE)); } catch (_) { /* never copied */ } }
  return r;
}

module.exports = { id: 'openai.chatgpt', name: 'Codex page', VERSION, ANY_MARK, BACKUP_SUFFIX, PAGE_FILE, EDITS, mark,
  patchSource, status, apply, restore, targetFile: htmlFile };
