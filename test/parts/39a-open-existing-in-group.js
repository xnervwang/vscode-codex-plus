// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Opening a conversation that no tab shows yet, from the session list, the Conversations view or the reopened tabs.
 *
 * Without a viewColumn, VS Code opens the editor in the active group, and when that group is locked (Claude Code locks
 * the group its own panel is in, setting claudeCode.lockEditorGroups) it takes the next unlocked group or opens a new
 * one beside it. So the group is always given, the one a new Codex tab goes in.
 */
const fake = require('../fake-vscode');

module.exports = async ({ eq }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/codex-tabs')];
  const tabs = require('../../src/codex-tabs');
  const A = '01a1c2dd-39e8-7142-b569-2ed9ec1f23cc', B = '01a1c2dd-39e8-7142-b569-2ed9ec1f23cd';
  const asked = [];
  control.state.openWith = (uri, viewType, options) => { asked.push(options && options.viewColumn); };
  const layout = (...groups) => {
    control.groups.length = 0;
    groups.forEach(([tabsIn, active], i) => control.groups.push({ viewColumn: i + 1, tabs: tabsIn, activeTab: tabsIn[0] || null, isActive: !!active }));
    asked.length = 0;
  };
  const other = control.fileTab('/work/a.js');

  layout([[other], true]);
  await tabs.openInTab(vscode, A);
  eq(asked, [1], 'with no Codex tab anywhere, a conversation opens in the first group rather than wherever VS Code puts an editor with no group');

  layout([[other], true], [[control.codexTab(B)]]);
  await tabs.openInTab(vscode, A);
  eq(asked, [2], 'with a group of Codex tabs, it joins them, even when another group is in front');

  layout([[other], true], [[control.codexTab(A)]]);
  await tabs.openInTab(vscode, A, { preserveFocus: true });
  eq(asked, [2], 'one already open is brought forward in its own group');
};
