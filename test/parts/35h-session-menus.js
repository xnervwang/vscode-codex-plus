// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The rest of Claude Code's menus on the session list: Mark as Read on an unread conversation in place of Mark as
 * Unread, a group header's four (Start New Session in This Group, New Group, Rename Group, Delete Group), and the
 * empty-list text. Every item's title starts "Codex Plus: ", which is how the user tells
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
  const { SessionsModel } = require('../../src/sessions-view');

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
  const provider = new SessionsModel(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => threads, sections: () => new Map(), state: () => ({}), thread: () => null },
    stateOf: (id) => ({ state: id === ID(1) ? 'unread' : 'idle' }), settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  const rows = provider.model().groups[0].rows;
  /* The when clauses of the list's right-click menu, against what the page puts on a row or a header
     (data-vscode-context), with VS Code's own key for the view. Only `a == 'b'`, `x` and `!x` joined by && are used. */
  const menus = pkg.contributes.menus['webview/context'];
  const holds = (when, ctx) => when.split('&&').map((p) => p.trim()).every((p) => {
    const m = /^([\w.]+) == '([^']*)'$/.exec(p);
    if (m) return String(ctx[m[1]]) === m[2];
    return p.startsWith('!') ? !ctx[p.slice(1)] : !!ctx[p];
  });
  const offered = (ctx) => menus.filter((m) => holds(m.when, { webviewId: 'codexPlus.sessions', ...ctx }))
    .sort((a, b) => a.group.localeCompare(b.group)).map((m) => m.command.replace('codexPlus.', ''));
  const rowCtx = (r) => ({ webviewSection: 'thread', threadId: r.id, codexPlusGrouped: r.grouped, codexPlusUnread: r.unread });
  const unreadRow = rows.find((r) => r.id === ID(1)), readRow = rows.find((r) => r.id === ID(2));
  eq([offered(rowCtx(readRow)).filter((c) => /^markThread/.test(c)), offered(rowCtx(unreadRow)).filter((c) => /^markThread/.test(c))],
    [['markThreadUnread'], ['markThreadRead']], 'a read conversation offers Mark as Unread, an unread one Mark as Read');
  eq(offered(rowCtx(readRow)), ['openThreadInTab', 'openThreadInSidebar', 'moveThreadToSection', 'markThreadUnread', 'renameThread', 'setTitleColor', 'setGoal'],
    'a row offers Resume, Add to Group, Mark as Unread, Rename, Text Color and Set Goal; Remove from Group only in a group');
  eq(pkg.contributes.commands.filter((c) => c.command === 'codexPlus.newGroupFromThreads').length, 0,
    'and no New Group from Conversation, which Claude Code\'s menu lacks: New group above the list makes a group');
  eq([offered({ ...rowCtx(readRow), codexPlusGoal: 'active' }).filter((c) => /Goal$/.test(c)),
    offered({ ...rowCtx(readRow), codexPlusGoal: 'budgetLimited', codexPlusGoalResumable: true }).filter((c) => /Goal$/.test(c))],
  [['setGoal', 'pauseGoal', 'clearGoal'], ['setGoal', 'resumeGoal', 'clearGoal']],
  'a row with a running goal offers Pause and Clear Goal, one with a stopped goal Resume and Clear Goal');
  eq(offered({ ...rowCtx(readRow), codexPlusGrouped: true }).includes('removeFromGroup'), true, 'and a row in a group offers Remove from Group');
  eq(offered({ ...rowCtx(readRow), 'codexPlus.noGroups': true }).filter((c) => /Group|Section/.test(c)), [], 'with no groups in this Codex, none of the group items');

  /* ── Resume in Tab and Resume in Sidebar, only for a conversation this window does not show, as in Claude Code Plus ── */
  const all = [...threads, { id: ID(3), title: 'c', kind: 'user', cwd: '/w', section: '', createdMs: 1, updatedMs: 4 },
    { id: ID(4), title: 'd', kind: 'subagent', parent: ID(1), cwd: '/w', section: '', createdMs: 2, updatedMs: 5 }];
  const shownHere = new SessionsModel(vscode, { memory: { openThreads: () => [ID(1)], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => all, sections: () => new Map(), state: () => ({}), thread: () => null }, sidebarShowing: () => ID(2),
    stateOf: () => ({ state: 'idle' }), settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: false }) });
  const hm = shownHere.model();
  const hereOf = (list) => list.map((r) => `${r.id.slice(-1)}${r.here ? '+' : '-'}`).sort();
  eq([hereOf(hm.open), hereOf(hm.groups.flatMap((g) => g.rows))], [['1+', '2+', '4+'], ['1+', '2+', '3-', '4-']],
    'a row says whether its conversation is open in this window, in a tab or in Codex\'s sidebar; every row of Open sessions does');
  const resumes = (r) => offered({ ...rowCtx(r), codexPlusOpenHere: !!r.here }).filter((c) => /^openThreadIn/.test(c));
  const inGroups = new Map(hm.groups.flatMap((g) => g.rows).map((r) => [r.id, r]));
  eq([resumes(inGroups.get(ID(1))), resumes(inGroups.get(ID(2))), resumes(hm.open.find((r) => r.id === ID(4))), resumes(inGroups.get(ID(3)))],
    [[], [], [], ['openThreadInTab', 'openThreadInSidebar']],
    'so Resume in Tab and Resume in Sidebar are offered for a conversation that is not open here, and for no row of Open sessions');

  /* ── a group header's menu ── */
  eq(offered({ webviewSection: 'group', groupKey: 'section:a', codexPlusMade: true }),
    ['newThreadInGroup', 'newGroup', 'renameGroup', 'deleteGroup'], 'a group header offers Claude Code\'s four, in its order');
  eq(offered({ webviewSection: 'group', groupKey: 'ungrouped', codexPlusMade: false }), ['newGroup'], 'Ungrouped offers only New Group');

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
  const page = require('fs').readFileSync(path.join(root, 'src', 'page', 'sessions-page.js'), 'utf8');
  eq([/'No sessions yet'/.test(page), /'No sessions found'/.test(page)], [true, true],
    'a list with nothing in it says "No sessions yet", and a search that finds nothing "No sessions found", as Claude Code\'s do');
  const titled = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
  const onList = [...new Set(menus.filter((m) => /codexPlus\.sessions/.test(m.when)).map((m) => m.command))];
  eq(onList.filter((c) => !/^Codex Plus: /.test(titled.get(c) || '')), [], 'every item of the list\'s right-click menus starts "Codex Plus: "');
};
