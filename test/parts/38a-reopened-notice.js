// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * When Codex tabs that VS Code did not restore are reopened at start-up, the status bar shows how many for ten
 * seconds, as Claude Code Plus does. Nothing is shown when there were none.
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: true };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  try {
    const memory = (ids) => ({ reopenDropped: async () => ids });
    control.state.statusMessages.length = 0;
    await ext._reopenDropped(memory(['01a1f0f0-0000-7000-8000-000000000001', '01a1f0f0-0000-7000-8000-000000000002']), () => {});
    eq(control.state.statusMessages, [['Reopened 2 Codex tabs VS Code did not restore', 10000]], 'two tabs reopened are said in the status bar, for ten seconds');
    control.state.statusMessages.length = 0;
    await ext._reopenDropped(memory(['01a1f0f0-0000-7000-8000-000000000003']), () => {});
    eq(control.state.statusMessages, [['Reopened 1 Codex tab VS Code did not restore', 10000]], 'and one, in the singular');
    control.state.statusMessages.length = 0;
    await ext._reopenDropped(memory([]), () => {});
    eq(control.state.statusMessages, [], 'and none says nothing');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
