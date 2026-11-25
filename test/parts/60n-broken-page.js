// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A Codex page its error boundary replaced with the recovery page because a module failed to load: the page script says
 * so once (src/page/codex-extras-page.js lookForBroken), and the host opens the tab again in its place
 * (src/broken-tabs.js).
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

/* A heading with the fiber chain of Codex's recovery page: the heading, the page component, then the boundary's fallback. */
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
  const { createBrokenTabs, LIMIT } = require(path.join(root, 'src', 'broken-tabs.js'));
  /* Two editor groups; the second has a text file, the broken Codex tab and another Codex tab, with the text file in front. */
  const world = ({ frontAt = 0, focusedColumn = 1 } = {}) => {
    const calls = [];
    const uri = (s) => ({ toString: () => s, s });
    const tab = (label, u, active) => ({ label, input: { uri: uri(u), viewType: 'chatgpt.conversationEditor' }, isActive: active });
    const groups = [
      { viewColumn: 1, isActive: focusedColumn === 1, tabs: [tab('notes.txt', 'file:///ws/notes.txt', true)] },
      { viewColumn: 2, isActive: focusedColumn === 2, tabs: [tab('a.txt', 'file:///ws/a.txt', frontAt === 0), tab('Broken', 'openai-codex://route/local/T1', frontAt === 1),
        tab('Other', 'openai-codex://route/local/T2', frontAt === 2)] },
    ];
    const vscode = {
      Uri: { from: (o) => ({ toString: () => `${o.scheme}://${o.authority}${o.path}` }) },
      /* A URI is kept as its string, anything else as it is. */
      commands: { executeCommand: async (c, ...a) => { calls.push([c, ...a.map((x) => (x && typeof x === 'object' && x.toString !== Object.prototype.toString ? String(x) : x))]); } },
      window: { tabGroups: { get all() { return groups; }, get activeTabGroup() { return groups.find((g) => g.isActive); },
        close: async (t) => { calls.push(['close', t.label]); for (const g of groups) { const i = g.tabs.indexOf(t); if (i >= 0) g.tabs.splice(i, 1); } } } },
    };
    return { vscode, calls };
  };
  const quiet = () => Promise.resolve();
  {
    const { vscode, calls } = world();
    const lines = [];
    const b = createBrokenTabs({ vscode, log: (l) => lines.push(l), sleep: quiet });
    const did = await b.report({ rec: { thread: 'T1', uri: 'openai-codex://route/local/T1' }, file: 'local-conversation-page-1.js' });
    eq([did, calls], ['reopened', [
      ['close', 'Broken'],
      ['vscode.openWith', 'openai-codex://route/local/T1', 'chatgpt.conversationEditor', { viewColumn: 2, preserveFocus: false, preview: false }],
      ['workbench.action.focusSecondEditorGroup'],
      ['moveActiveEditor', { to: 'position', by: 'tab', value: 2 }],
      ['workbench.action.openEditorAtIndex', 0],
      ['workbench.action.focusFirstEditorGroup'],
    ]], 'a background tab is closed, opened again in its group, moved back to its position, the tab in front before shown again, and the focus given back to the group that had it');
    eq(lines, ['Codex\'s page in the tab of conversation T1 could not load its code (local-conversation-page-1.js)',
      'opened the tab of conversation T1 again, at position 2 of editor group 2'], 'and each part is logged');
  }
  {
    const { vscode, calls } = world({ frontAt: 1, focusedColumn: 2 });
    const b = createBrokenTabs({ vscode, sleep: quiet });
    await b.report({ rec: { thread: 'T1', uri: 'openai-codex://route/local/T1' }, file: '' });
    eq(calls.map((c) => c[0]), ['close', 'vscode.openWith', 'workbench.action.focusSecondEditorGroup', 'moveActiveEditor'],
      'a tab in front, in the group with the focus, is opened again in front and nothing else is shown');
  }
  {
    let t = 0;
    const lines = [];
    const { vscode } = world();
    const b = createBrokenTabs({ vscode, log: (l) => lines.push(l), sleep: quiet, now: () => t });
    const results = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      vscode.window.tabGroups.all[1].tabs.splice(1, 0, { label: 'Broken', input: { uri: { toString: () => 'openai-codex://route/local/T1' } }, isActive: false });
      results.push(await b.report({ rec: { thread: 'T1', uri: 'openai-codex://route/local/T1' }, file: '' }));
      t += 60e3;
    }
    t += 10 * 60e3;
    results.push(await b.report({ rec: { thread: 'T1', uri: 'openai-codex://route/local/T1' }, file: '' }));
    eq(results, ['reopened', 'reopened', 'limit', 'reopened'], `a conversation is opened again at most ${LIMIT} times in ten minutes, and again after that`);
    eq(lines.filter((l) => /left for the user/.test(l)).length, 1, 'with a line when it is left');
  }
  {
    const { vscode, calls } = world();
    const lines = [];
    const b = createBrokenTabs({ vscode, log: (l) => lines.push(l), sleep: quiet });
    eq([await b.report({ rec: { thread: '', uri: 'openai-codex://route/extension/panel/new#new-1' }, file: 'new-thread-panel-page-1.js' }),
      await b.report({ rec: { thread: 'T9', uri: 'openai-codex://route/local/T9' }, file: '' }), calls],
    ['unknown', 'gone', []], 'a tab with no conversation yet, or one already gone, is left as it is');
    eq(lines.slice(0, 2), ['Codex\'s page in the tab of a conversation not started yet could not load its code (new-thread-panel-page-1.js)',
      'that tab has no conversation to open again, so it is left for the user'], 'and the first is logged as left for the user');
  }
  {
    /* A New tab whose page failed as its first message was sent: Codex starts the conversation during the wait. */
    const { vscode, calls } = world();
    vscode.window.tabGroups.all[1].tabs[1].input.uri = { toString: () => 'openai-codex://route/extension/panel/new#new-2' };
    const rec = { thread: '', uri: 'openai-codex://route/extension/panel/new#new-2' };
    const b = createBrokenTabs({ vscode, sleep: async () => { rec.thread = 'T5'; } });
    eq([await b.report({ rec, file: '' }), calls[1]],
      ['reopened', ['vscode.openWith', 'openai-codex://route/local/T5', 'chatgpt.conversationEditor', { viewColumn: 2, preserveFocus: false, preview: false }]],
      'a tab whose conversation becomes known during the wait is opened again on that conversation');
  }
};
