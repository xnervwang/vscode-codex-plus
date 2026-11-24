// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Every setting that Codex's page draws from (viewOf in src/patching.js, and conversationLinks, which a page gets with
 * the list of conversations) takes effect in the pages already open: the extension redraws them at once rather than at
 * the next turn or list change.
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

/* The settings the fields of viewOf come from, plus codexPlus.conversationLinks. */
const PAGE_SETTINGS = ['enabled', 'timestamps', 'conversationNavigation', 'userMessageColor', 'userMessageEdge', 'lowContextOutline',
  'turnFigures', 'replyDuration', 'chime', 'infoButton', 'chimeButton', 'contextMeter', 'replyImages', 'conversationLinks'];

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  const heard = [];
  vscode.workspace.onDidChangeConfiguration = (fn) => { heard.push(fn); return { dispose() {} }; };
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const patching = require(path.join(root, 'src', 'patching.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  const real = patching.refreshPanels;
  let redrawn = 0;
  patching.refreshPanels = async () => { redrawn++; };
  try {
    const missed = [];
    for (const key of PAGE_SETTINGS) {
      const before = redrawn;
      for (const fn of heard) fn({ affectsConfiguration: (k) => k === 'codexPlus' || k === `codexPlus.${key}` });
      if (redrawn === before) missed.push(key);
    }
    eq(missed, [], 'a change to any setting Codex\'s page draws from redraws the open pages at once');
    const before = redrawn;
    for (const fn of heard) fn({ affectsConfiguration: (k) => k === 'codexPlus' || k === 'codexPlus.sessionList' });
    eq(redrawn, before, 'and a setting the page does not draw from leaves them alone');
  } finally {
    patching.refreshPanels = real;
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
