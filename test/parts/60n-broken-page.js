// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's recovery page, which its error boundary draws in place of a page when a module fails to load: the page script
 * reports it once (src/page/codex-extras-page.js lookForBroken), and the host builds a new page in its place
 * (src/broken-pages.js).
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

function pageUnder(root, dom) {
  const posted = [];
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: () => {}, location: { pathname: '/index.html', hash: '' } };
  const ctx = vm.createContext(Object.assign({ globalThis: win }, dom.sandbox));
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), ctx);
  return { broken: () => posted.filter((m) => m.kind === 'brokenPage').map((m) => [m.reason, m.file]) };
}

/* Codex's recovery page as React fibers: a heading, the page component above it, then the boundary's fallback. */
function recovery(dom, error) {
  const h = dom.el('h1', { texts: ['ChatGPT hit a snag'] });
  const fallback = { memoizedProps: { error, resetError: () => {}, stayOnPage: false }, return: null };
  const pageComponent = { memoizedProps: { compact: false, description: {} }, return: fallback };
  h['__reactFiber$test'] = { stateNode: h, memoizedProps: { className: 'text-2xl' }, return: pageComponent };
  return h;
}

module.exports = async ({ eq, root }) => {
  /* ── The page ── */
  {
    const dom = createDom();
    const box = dom.el('div');
    dom.setBody(dom.el('body', { kids: [box] }));
    const page = pageUnder(root, dom);
    const watch = dom.live().filter((o) => o.targets.some((t) => t.target === dom.document.body && t.options.subtree)).pop();
    const show = (el) => { while (box.firstChild) box.removeChild(box.firstChild); if (el) box.appendChild(el); watch.fn([]); dom.runTimers(); };

    show(dom.el('h1', { texts: ['A conversation'] }));
    show(recovery(dom, new Error('Cannot read properties of undefined')));
    eq(page.broken(), [], 'a heading with no boundary above it, or a recovery page for any other error, is not reported');
    const failed = new TypeError('Failed to fetch dynamically imported module: https://file+.vscode-resource.vscode-cdn.net/home/u/.vscode/extensions/openai.chatgpt-26.1120.50957/webview/assets/local-conversation-page-6d0661102299.js');
    show(recovery(dom, failed));
    eq(page.broken(), [['module', 'local-conversation-page-6d0661102299.js']], 'the recovery page for a module that failed to load is reported, with the module\'s file name only');
    show(recovery(dom, failed));
    eq(page.broken().length, 1, 'and only once for the page');
  }

  /* ── The host ── */
  const { createBrokenPages, LIMIT } = require(path.join(root, 'src', 'broken-pages.js'));
  const quiet = () => Promise.resolve();
  {
    let t = 1000;
    const lines = [];
    const webview = { html: '<html>page</html>' };
    const b = createBrokenPages({ log: (l) => lines.push(l), sleep: quiet, now: () => t });
    const tab = { webview, key: 'openai-codex://route/local/T1', where: 'in the tab of conversation T1' };
    eq([await b.report(Object.assign({ file: 'local-conversation-page-1.js' }, tab)), webview.html],
      ['loaded', '<html>page</html><!-- Codex Plus loaded this page again at 1000 -->'],
      'the page\'s html is set again, with the time at its end so that VS Code builds a new page');
    t = 2000;
    await b.report(Object.assign({ file: '' }, tab));
    eq(webview.html, '<html>page</html><!-- Codex Plus loaded this page again at 2000 -->', 'a second load replaces that comment rather than adding one');
    eq(lines.slice(0, 2), ['Codex\'s page in the tab of conversation T1 could not load its code (local-conversation-page-1.js)',
      'loaded the page in the tab of conversation T1 again'], 'each part is logged');
    t = 3000;
    eq([await b.report(Object.assign({ file: '' }, tab)), webview.html.endsWith('at 2000 -->')], ['limit', true],
      `a page is loaded again at most ${LIMIT} times in ten minutes, and then left as it is`);
    eq(lines[lines.length - 1], 'the page in the tab of conversation T1 was loaded again 2 times in the last 10 minutes, so it is left for the user', 'with a line when it is left');
    const sidebar = { html: '<html>side</html>' };
    eq(await b.report({ webview: sidebar, key: 'sidebar', where: 'in Codex\'s sidebar', file: '' }), 'loaded', 'another page, such as Codex\'s sidebar, is counted on its own');
    t += 10 * 60e3;
    eq(await b.report(Object.assign({ file: '' }, tab)), 'loaded', 'and the first page is loaded again once ten minutes have passed');
  }
  {
    const lines = [];
    const webview = { get html() { return '<html/>'; }, set html(v) { throw new Error('disposed'); } };
    const b = createBrokenPages({ log: (l) => lines.push(l), sleep: quiet });
    eq([await b.report({ webview, key: 'k', where: 'in a tab of a conversation not started yet', file: '' }), lines[1]],
      ['failed', 'could not load the page in a tab of a conversation not started yet again: disposed'], 'a webview that is already gone is logged and otherwise left alone');
    const fresh = { html: '<html/>' };
    const after = [];
    for (let i = 0; i <= LIMIT; i++) after.push(await b.report({ webview: fresh, key: 'k', where: 'in the same tab', file: '' }));
    eq(after, Array.from({ length: LIMIT }, () => 'loaded').concat(['limit']), 'a load that failed does not count towards the limit');
  }
};
