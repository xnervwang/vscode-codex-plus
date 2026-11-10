// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The patch target in Codex's page: webview/index.html, which Codex reads from disk each time it builds a page and
 * fills in with its base and content-security tags.
 *
 * The page's policy runs scripts from the extension's own folder and no inline ones, so the addition is a file,
 * webview/codex-extras-page.js, made from src/page/ (Agent Plus's shared page code, kit.js, then this extension's
 * script), and one module script tag for it placed ahead of Codex's own entry script, so it runs first. The tag carries
 * the digest of the whole file, so a page patched by an older version is recognised as outdated.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyEdits } = require('./edits');
const { writeAtomic } = require('./files');
const { patchTarget } = require('./patch-target');

const PAGE_FILE = 'codex-extras-page.js';
const PAGE_SOURCE = path.join(__dirname, 'page', PAGE_FILE);
const KIT_SOURCE = path.join(__dirname, 'page', 'kit.js');
const ANY_MARK = '<!-- CODEX-EXTRAS-PAGE v';
const BACKUP_SUFFIX = '.codex-extras-page.bak';
const VERSION = 1;

const pageScript = () => fs.readFileSync(KIT_SOURCE, 'utf8') + '\n' + fs.readFileSync(PAGE_SOURCE, 'utf8');
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
  const r = applyEdits(html, EDITS, 'Codex');
  return r.error ? { error: r.error } : { out: r.out, chosen: r.chosen };
}

const OLDER = 'an older page patch is present without a clean backup; reinstall Codex';
const pageFile = (codexExtensionPath) => path.join(path.dirname(htmlFile(codexExtensionPath)), PAGE_FILE);

const target = patchTarget({
  file: htmlFile, mark, anyMark: ANY_MARK, backupSuffix: BACKUP_SUFFIX, tmpTag: '.codex-extras',
  /* An empty page is no Codex page to patch. */
  transform: (html) => (html ? patchSource(html) : { error: OLDER }),
  /* A backup can stand for Codex's page when it holds the entry script the patch anchors on, as the page it was taken
     from did. Anything else is not put back over it. */
  usableBackup: (html) => new RegExp(EDITS[0].re.source).test(html),
  ready: (dir) => fs.existsSync(pageFile(dir)),
  beforeWrite: (dir) => writeAtomic(pageFile(dir), pageScript(), undefined, { tag: '.codex-extras' }),
  /* The page script goes with the patch, unless another window has patched the page again since the move. */
  afterRestore: (dir, r) => {
    let clean = false;
    try { clean = !fs.readFileSync(htmlFile(dir), 'utf8').includes(ANY_MARK); } catch (_) { /* gone */ }
    if (r.changed && clean) { try { fs.unlinkSync(pageFile(dir)); } catch (_) { /* never copied */ } }
  },
  say: {
    missing: (file) => `Codex page not found at ${file}`, noBackup: OLDER, markedBackup: OLDER,
    badBackup: 'backup is not a Codex page; not restored, reinstall Codex',
  },
});

module.exports = { id: 'openai.chatgpt', name: 'Codex page', VERSION, ANY_MARK, BACKUP_SUFFIX, PAGE_FILE, EDITS, mark, pageScript,
  patchSource, status: target.status, apply: target.apply, restore: target.restore, targetFile: htmlFile };
