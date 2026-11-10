// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Codex session list as a tree view created with createTreeView. Like Claude Code's list, it follows the
 * conversation in front by selecting its row in Open sessions without taking the focus, but only while the list is
 * visible, because revealing a row of a hidden view opens the view. Several rows can be selected at once, so archived
 * conversations can be deleted together.
 */
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { SessionsProvider, createFollower } = require('../../src/sessions-view');

  /* ── the provider can say where a row sits, and which row is a conversation's in Open sessions ── */
  const threads = [1, 2].map((n) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', updatedMs: Date.now(), createdMs: Date.now() }));
  const provider = new SessionsProvider(vscode, { memento: fake.memento(), stateOf: () => null,
    memory: { openThreads: () => [ID(1), ID(2)], recentlyClosed: () => [], frontAt: () => 0 },
    reader: { threads: () => threads, sections: () => new Map(), state: () => null, thread: () => null },
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  provider.refresh();
  const row = provider.rowOf(ID(2));
  eq([row && row.kind, row && row.group, row && row.thread.id, provider.rowOf('nothing')], ['thread', 'open', ID(2), null],
    'a conversation open here has its row in Open sessions, and one that is not has none');
  const parent = provider.getParent(row);
  eq([parent && parent.kind, parent && parent.group.key, provider.getParent(parent)], ['group', 'open', undefined],
    'a row\'s parent is its group, and a group has none, which is what revealing a row needs');

  /* ── following the conversation in front ── */
  let front = ID(1);
  const view = vscode.window.createTreeView('a view', {});
  const follow = createFollower(view, provider, () => front);
  follow();
  eq(view.reveals.map((r) => [r.el.thread.id, r.o]), [[ID(1), { select: true, focus: false }]],
    'the row of the conversation in front is selected and scrolled to, and the focus stays where it was');
  follow();
  eq(view.reveals.length, 1, 'asked again with the same conversation in front, it does nothing');
  view.visible = false;
  front = ID(2);
  follow();
  eq(view.reveals.length, 1, 'while the list is not visible nothing is revealed, which would open it');
  view.fireVisibility(true);
  eq(view.reveals.map((r) => r.el.thread.id), [ID(1), ID(2)], 'and once it is shown again it goes to the conversation in front then');

  /* ── the extension registers it that way ── */
  const home = tmp('home');
  const made = fixture.codexHome(home, [{ title: 'Kept', cwd: home, archived: true, turns: [{}] }, { title: 'Also kept', cwd: home, archived: true, turns: [{}] }]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  try {
    const tree = control.state.treeViews['codexPlus.sessions'];
    eq([!!tree, tree && tree.opts.canSelectMany, tree && tree.opts.treeDataProvider instanceof SessionsProvider], [true, true, true],
      'the session list is a tree view of its own, with several rows selectable at once');
    await new Promise((r) => setTimeout(r, 300));
    const said = [];
    control.answer('permanently', (message) => { said.push(message); return undefined; });
    const [a, b] = made.map((t) => ({ kind: 'thread', thread: { id: t.id }, group: 'archived' }));
    await control.state.handlers['codexPlus.deleteArchivedThread'](a, [a, b]);
    eq(said, ['Delete 2 archived conversations permanently?'], 'deleting with two archived rows selected asks once, for both');
    said.length = 0;
    await control.state.handlers['codexPlus.deleteArchivedThread'](a, [b]);
    eq(said, ['Delete "Kept" permanently?'], 'and a right-click on a row outside the selection deletes that row alone');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
