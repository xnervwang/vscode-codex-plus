// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The rest of Claude Code's menus on the session list: Mark as Read on an unread conversation in place of Mark as
 * Unread, a group header's four (Start New Session in This Group, New Group, Rename Group, Delete Group), and the words
 * the list shows when there is nothing in it. Every item's title starts "Codex Plus: ", which is how the user tells
 * this extension's items from Codex's own.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { vscode } = fake.create();
  fake.install(vscode);
  const { createSeen } = require('../../src/seen');
  const { createPlacer, PLACE_MS } = require('../../src/session-groups');
  const { SessionsProvider } = require('../../src/sessions-view');

  /* ── Mark as Read ── */
  let now = 1000;
  const seen = createSeen(undefined, { now: () => now, setTimer: () => 1, clearTimer: () => {} });
  seen.markUnread(ID(1), false);
  now = 2000;
  seen.markRead(ID(1));
  eq([seen.unread(ID(1), 1500), seen.unread(ID(1), 2500)], [false, true],
    'Mark as Read clears the mark and counts the conversation as looked at now; a later reply is unread again');
  const threads = [{ id: ID(1), title: 'a', kind: 'user', cwd: '/w', section: '', createdMs: 1, updatedMs: 2 },
    { id: ID(2), title: 'b', kind: 'user', cwd: '/w', section: '', createdMs: 1, updatedMs: 3 }];
  const provider = new SessionsProvider(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => threads, sections: () => new Map(), state: () => ({}), thread: () => null },
    stateOf: (id) => ({ state: id === ID(1) ? 'unread' : 'idle' }), settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  provider.refresh();
  const rows = provider.getChildren(provider.getChildren()[0]).map((r) => provider.getTreeItem(r).contextValue);
  const menus = pkg.contributes.menus['view/item/context'];
  const offered = (cv) => menus.filter((m) => {
    const re = /viewItem =~ \/(.*)\/(?:\s|$)/.exec(m.when);
    const eqv = /viewItem == (\S+)/.exec(m.when);
    return re ? new RegExp(re[1]).test(cv) : eqv ? eqv[1] === cv : false;
  }).map((m) => m.command.replace('codexPlus.', ''));
  eq([offered(rows[1]).filter((c) => /^markThread/.test(c)), offered(rows[0]).filter((c) => /^markThread/.test(c))],
    [['markThreadUnread'], ['markThreadRead']], 'a read conversation offers Mark as Unread, an unread one Mark as Read');

  /* ── a group header's menu ── */
  eq(offered('codexPlusGroup-section'),
    ['newThreadInGroup', 'newGroup', 'renameGroup', 'deleteGroup'], 'a group header offers Claude Code\'s four, in its order');
  eq(offered('codexPlusGroup-ungrouped'), ['newGroup'], 'Ungrouped offers only New Group');

  /* ── Start New Session in This Group ── */
  let t = 10000;
  const list = [];
  const moved = [];
  const placer = createPlacer({ threads: () => list, shown: () => [ID(9)], move: async (ids, sec) => { moved.push([ids, sec]); return { outcome: 'done' }; }, now: () => t });
  placer.start('sec-a');
  eq(await placer.check(), null, 'nothing is moved while the new conversation does not exist yet');
  list.push({ id: ID(8), kind: 'user', section: '', createdMs: 10500 }, { id: ID(9), kind: 'user', section: '', createdMs: 10600 },
    { id: ID(7), kind: 'user', section: '', createdMs: 100 });
  const r = await placer.check();
  eq([r.thread, moved, placer.pending()], [ID(9), [[[ID(9)], 'sec-a']], null],
    'the one made since that this window shows is moved into the group, and the wait ends');
  placer.start('sec-a');
  t += PLACE_MS + 1;
  list.push({ id: ID(6), kind: 'user', section: '', createdMs: t });
  eq([await placer.check(), moved.length], [null, 1], 'after half an hour it stops waiting');

  /* ── the words for an empty list, and the prefix ── */
  eq((pkg.contributes.viewsWelcome || []).filter((w) => w.view === 'codexPlus.sessions').map((w) => w.contents), ['No sessions yet'],
    'a list with nothing in it says "No sessions yet", as Claude Code\'s does');
  const titled = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
  const onList = [...new Set(menus.filter((m) => /codexPlus\.sessions/.test(m.when)).map((m) => m.command))];
  eq(onList.filter((c) => !/^Codex Plus: /.test(titled.get(c) || '')), [], 'every item of the list\'s right-click menus starts "Codex Plus: "');
};
