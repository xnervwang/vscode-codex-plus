// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * codexPlus.loadRestoredTabs: off by default; on, each Codex tab behind another is shown once when the window starts
 * (src/load-tabs.js) and the tab that was in front comes back, and the conversations shown for that moment do not
 * count as read.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const A = '01a1ab0a-0000-7000-8000-00000000000a';
const B = '01a1ab0b-0000-7000-8000-00000000000b';

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];

  /* What is in front counts as read, except while holdSeen() says the tabs are being loaded. */
  {
    const { createCodexSource } = require(path.join(root, 'src', 'codex-source.js'));
    const reader = { threads: () => [], sections: () => new Map(), state: () => null, unread: () => new Map(), hasPlan: () => false,
      thread: () => null, present: () => true, refresh: async () => false, ready: async () => ({ threads: [], readable: true }) };
    const marks = [];
    const seen = { mark: (id) => marks.push(id), unread: () => false, left: () => {}, flush: () => {} };
    let hold = true;
    const src = createCodexSource(vscode, { reader, seen, holdSeen: () => hold });
    try {
      control.setTabs([control.codexTab(A), control.codexTab(B)], 1);
      control.fireTabs();
      eq(marks, [], 'a Codex tab brought to the front while the tabs are being loaded does not count as read');
      hold = false;
      control.setTabs([control.codexTab(A), control.codexTab(B)], 0);
      control.fireTabs();
      eq(marks, [A], 'and one brought to the front afterwards does');
    } finally { src.dispose(); }
  }

  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  try {
    const notes = path.join(home, 'notes.txt');
    control.setTabs([control.codexTab(A), control.fileTab(notes), control.codexTab(B)], 1);
    const moves = () => control.state.commands.filter(([c]) => /^workbench\.action\.(openEditorAtIndex|focus\w+EditorGroup)$/.test(c)).map((c) => c.join(' '));
    control.state.commands.length = 0;
    eq([await ext._loadRestored(() => {}), moves()], [0, []], 'off by default: no tab is brought forward');
    control.state.config.loadRestoredTabs = true;
    const said = [];
    eq([await ext._loadRestored((m) => said.push(m)), moves()], [2, ['workbench.action.focusFirstEditorGroup', 'workbench.action.openEditorAtIndex 0',
      'workbench.action.openEditorAtIndex 2', 'workbench.action.openEditorAtIndex 1', 'workbench.action.focusFirstEditorGroup']],
    'on, each Codex tab behind the text file is shown once, and then the text file is in front again');
    eq(said, ['loaded 2 Codex tab(s) VS Code restored behind another, and put tab 2 of editor group 1 in front again'], 'and the log says how many, and which tab is in front again');
    control.state.commands.length = 0;
    control.state.config.enabled = false;
    eq([await ext._loadRestored(() => {}), moves()], [0, []], 'with Codex Plus turned off, nothing is brought forward');
    delete control.state.config.enabled;
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }

  const text = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const decl = require(path.join(root, 'package.json')).contributes.configuration.properties['codexPlus.loadRestoredTabs'];
  eq([!!decl && decl.default, /holdSeen: \(\) => loadingTabs/.test(text), /loadingTabs = true;[\s\S]{0,400}loadTabs\.loadAll\([\s\S]{0,400}finally \{ loadingTabs = false; \}/.test(text)],
    [false, true, true], 'the setting is declared off by default, and the source is told not to mark anything read while the tabs are loaded');
};
