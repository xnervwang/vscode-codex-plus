// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Ctrl/Cmd+Shift+T reopens the Codex conversation closed last, as Claude Code's own shortcut reopens its last closed
 * session, and only while the tab closed last was a Codex tab: the key is VS Code's Reopen Closed Editor otherwise. The
 * key is bound behind a context key the tab events keep, so nothing runs until it is pressed.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const { TabMemory } = require('../../src/tab-memory');

  const mem = fake.memento();
  const memory = new TabMemory(vscode, mem, { titleOf: () => 'a title' });
  try {
    const a = control.codexTab(ID(1)), b = control.codexTab(ID(2)), file = control.fileTab('/work/a.js');
    control.setTabs([a, b, file], 0);
    control.fireTabs({ opened: [a, b, file] });
    eq(memory.lastClosedWasCodex(), false, 'with nothing closed yet the key is VS Code\'s');
    control.setTabs([b, file], 0);
    control.fireTabs({ closed: [a] });
    eq(memory.lastClosedWasCodex(), true, 'a Codex tab closed last takes the key');
    control.setTabs([b], 0);
    control.fireTabs({ closed: [file] });
    eq(memory.lastClosedWasCodex(), false, 'a file closed after it gives the key back to VS Code, which reopens the file');
    control.setTabs([], 0);
    control.fireTabs({ closed: [b] });
    eq([memory.lastClosedWasCodex(), memory.reopenTarget()], [true, ID(2)], 'the conversation to reopen is the one closed last');
    memory.reopened();
    eq(memory.lastClosedWasCodex(), false, 'once reopened, the key goes back to what was closed before it, the file');
  } finally { memory.dispose(); }

  /* ── through the extension: the context key, and the command ── */
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = require('os').tmpdir();
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  process.env.CODEX_HOME = path.join(home, 'codex-plus-no-such-home');
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(path.join(home, 'codex-plus-gs')), extensionPath: root });
  try {
    const c = control.codexTab(ID(5));
    control.setTabs([c], 0);
    control.fireTabs({ opened: [c] });
    control.setTabs([], 0);
    control.fireTabs({ closed: [c] });
    eq(control.state.context['codexPlus.lastClosedWasCodex'], true, 'closing a Codex tab gives the extension the key');
    control.state.commands.length = 0;
    await control.state.handlers['codexPlus.reopenClosedSession']();
    const opened = control.state.commands.find((x) => x[0] === 'vscode.openWith');
    eq([opened && String(opened[1].path), control.state.context['codexPlus.lastClosedWasCodex']], [`/local/${ID(5)}`, false],
      'and pressing it opens that conversation in a tab, after which the key is VS Code\'s again');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }

  const kb = (pkg.contributes.keybindings || []).find((k) => k.command === 'codexPlus.reopenClosedSession');
  eq(kb && [kb.key, kb.mac, kb.when], ['ctrl+shift+t', 'cmd+shift+t', 'codexPlus.lastClosedWasCodex && config.codexPlus.reopenClosedSessionShortcut'],
    'the key is Ctrl+Shift+T (Cmd+Shift+T on a Mac), only while a Codex tab was closed last and the setting is on');
  const setting = pkg.contributes.configuration.properties['codexPlus.reopenClosedSessionShortcut'];
  eq(setting && setting.default, true, 'and the setting is on unless turned off, as Claude Code\'s is');
  const cmd = pkg.contributes.commands.find((c) => c.command === 'codexPlus.reopenClosedSession');
  eq(cmd && cmd.title, 'Codex Plus: Reopen Closed Codex Conversation', 'the command it runs is named after this extension');
};
