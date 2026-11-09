// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's conversation page as Codex's host builds it, from the installed extension's own webview folder, which is
 * served read only and never copied: index.html with its base tag filled in and this extension's patch applied by the
 * same transform the extension applies (src/webview-inject.js), and the stand-ins for VS Code and for Codex's host put
 * ahead of the page script. The page script itself is the repository's, read on every request.
 */
const fs = require('fs');
const path = require('path');
const inject = require('../../../src/webview-inject');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE_SCRIPT = path.join(ROOT, 'src', 'page', inject.PAGE_FILE);

/* The installed extensions of Codex, newest version first: [{ dir, version }]. */
function codexInstalls(home = require('os').homedir()) {
  const out = [];
  for (const base of [path.join(home, '.vscode-server', 'extensions'), path.join(home, '.vscode', 'extensions')]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (_) { continue; }
    for (const n of names) {
      if (!/^openai\.chatgpt-\d/.test(n)) continue;
      try {
        const version = JSON.parse(fs.readFileSync(path.join(base, n, 'package.json'), 'utf8')).version;
        if (fs.existsSync(path.join(base, n, 'webview', 'index.html'))) out.push({ dir: path.join(base, n), version });
      } catch (_) { /* not a whole install */ }
    }
  }
  const key = (v) => String(v).split('.').map((x) => x.padStart(8, '0')).join('.');
  return out.sort((a, b) => (key(b.version) > key(a.version) ? 1 : -1));
}

/* index.html as Codex ships it: the backup the patch keeps when the installed one carries the patch. */
function cleanHtml(dir) {
  const file = path.join(dir, 'webview', 'index.html');
  const html = fs.readFileSync(fs.existsSync(file + inject.BACKUP_SUFFIX) ? file + inject.BACKUP_SUFFIX : file, 'utf8');
  if (html.includes(inject.ANY_MARK)) throw new Error(`${file} carries the patch and has no backup beside it to read Codex's own page from`);
  return html;
}

/*
 * The capnweb module of Codex's page: the asset holding both the transport's encodingLevel and the session's
 * getRemoteMain. Its file name changes with each Codex build, so it is found by what it contains.
 */
function capnwebAsset(dir) {
  const assets = path.join(dir, 'webview', 'assets');
  for (const n of fs.readdirSync(assets)) {
    if (!/^dist-[\w-]+\.js$/.test(n)) continue;
    const text = fs.readFileSync(path.join(assets, n), 'utf8');
    if (text.includes('encodingLevel') && text.includes('getRemoteMain') && /export\s*\{/.test(text)) return n;
  }
  return '';
}

/*
 * `route` is the page's first route. `pre` are the scripts run before the page script, in order, as
 * { src, module }. `version` goes in the meta tag Codex's host writes.
 */
function pageHtml(dir, { route, pre, version, sessionId = '00000000-0000-4000-8000-000000000001' }) {
  const patched = inject.patchSource(cleanHtml(dir));
  if (patched.error) throw new Error(`the page patch did not apply: ${patched.error}`);
  let html = patched.out.replace('<!-- PROD_BASE_TAG_HERE -->', '<base href="/codex-webview/">').replace('<!-- PROD_CSP_TAG_HERE -->', '');
  const metas = [`<meta name="initial-route" content="${route}">`, `<meta name="codex-extension-version" content="${version}">`,
    `<meta name="codex-session-id" content="${sessionId}">`, '<meta name="codex-build-flavor" content="prod">'].join('\n');
  html = html.replace('</head>', `${metas}\n</head>`);
  const ours = `<script type="module" src="./${inject.PAGE_FILE}"></script>`;
  if (!html.includes(ours)) throw new Error('the patched page has no page script tag');
  const tags = pre.map((s) => `<script${s.module ? ' type="module"' : ''} src="${s.src}"></script>`).join('\n    ');
  return html.replace(ours, `${tags}\n    ${ours}`);
}

module.exports = { ROOT, PAGE_SCRIPT, codexInstalls, capnwebAsset, pageHtml };
