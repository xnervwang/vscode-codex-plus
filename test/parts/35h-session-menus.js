// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The rest of Claude Code's menus on the session list: Mark as Read on an unread conversation in place of Mark as
 * Unread, a group header's four (Start New Session in This Group, New Group, Rename Group, Delete Group), and the
 * empty-list text. Every item's title starts "Codex Plus: ", which is how the user tells
 * this extension's items from Codex's own.
 *
 * The page draws these menus from a table the host sends with the model (LIST_MENU in src/sessions-view.js), each item
 * with a VS Code when clause. This part checks the table against the native menu it replaced, and the page's menus
 * against the table.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { runSessionsPage } = require('../sessions-page-run');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { vscode } = fake.create();
  fake.install(vscode);
  const { createSeen } = require('../../src/seen');
  const { createPlacer, PLACE_MS } = require('../../src/session-groups');
  const { SessionsModel, LIST_MENU } = require('../../src/sessions-view');
  const table = Array.isArray(LIST_MENU) ? LIST_MENU : [];

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

  /* ── the table, against the native menu it replaced ── */
  eq(table.map((m) => [m.command.replace('codexPlus.', ''), m.group, m.when]), [
    ['openThreadInTab', '1_open@1', "webviewSection == 'thread' && !codexPlusOpenHere"],
    ['openThreadInSidebar', '1_open@2', "webviewSection == 'thread' && !codexPlusOpenHere"],
    ['moveThreadToSection', '2_group@2', "webviewSection == 'thread' && !codexPlus.noGroups"],
    ['removeFromGroup', '2_group@3', "webviewSection == 'thread' && codexPlusGrouped"],
    ['markThreadUnread', '3_read@1', "webviewSection == 'thread' && !codexPlusUnread"],
    ['markThreadRead', '3_read@1', "webviewSection == 'thread' && codexPlusUnread"],
    ['renameThread', '4_edit@1', "webviewSection == 'thread'"],
    ['setTitleColor', '5_look@1', "webviewSection == 'thread'"],
    ['pauseGoal', '6_goal@2', "webviewSection == 'thread' && codexPlusGoal == 'active'"],
    ['resumeGoal', '6_goal@3', "webviewSection == 'thread' && codexPlusGoalResumable"],
    ['clearGoal', '6_goal@4', "webviewSection == 'thread' && codexPlusGoal"],
    ['deleteThread', '9_delete@1', "webviewSection == 'thread'"],
    ['newThreadInGroup', '1_new@1', "webviewSection == 'group' && codexPlusMade && !codexPlus.noGroups"],
    ['newGroup', '1_new@2', "webviewSection == 'group' && !codexPlus.noGroups"],
    ['renameGroup', '2_group@1', "webviewSection == 'group' && codexPlusMade && !codexPlus.noGroups"],
    ['deleteGroup', '9_delete@1', "webviewSection == 'group' && codexPlusMade && !codexPlus.noGroups"],
  ], 'the list\'s menus have sixteen items, in the groups and with the when clauses its native menu had, and Delete after them on a row');
  const bySection = (sec) => table.filter((m) => m.when.startsWith(`webviewSection == '${sec}'`));
  const vscodeOrder = (list) => [...list].sort((a, b) => a.group.localeCompare(b.group)).map((m) => m.command);
  eq(table.map((m) => m.command), [...vscodeOrder(bySection('thread')), ...vscodeOrder(bySection('group'))],
    'listed in the order VS Code drew them: by group, then by the number after @');
  const native = pkg.contributes.menus['webview/context'] || [];
  eq([native.filter((m) => /codexPlus\.sessions/.test(m.when)).length, native.map((m) => [m.command, m.when, m.group])],
    [0, [['codexPlus.markThreadUnread', "webviewId == 'chatgpt.conversationEditor'", 'codexPlus@1'],
      ['codexPlus.renameThread', "webviewId == 'chatgpt.conversationEditor'", 'codexPlus@2'],
      ['codexPlus.moveThreadToSection', "webviewId == 'chatgpt.conversationEditor'", 'codexPlus@3']]],
    'VS Code is given none of them, and a conversation tab keeps its three in VS Code\'s own menu');
  const titled = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
  const SUBMENUS = { 'codexPlus.setTitleColor': 'color', 'codexPlus.moveThreadToSection': 'group' };
  eq(table.map((m) => [m.command, m.title, m.submenu || '']),
    table.map((m) => [m.command, SUBMENUS[m.command] ? (titled.get(m.command) || '').replace(/\.\.\.$/, '') : titled.get(m.command), SUBMENUS[m.command] || '']),
    'each item is titled as its command is, and Text Color and Add to Group, which open a submenu, lose their "..."');
  eq(table.filter((m) => m.rows || m.plural).map((m) => [m.command, m.rows, m.plural]),
    [['codexPlus.deleteThread', 'deletable', 'Codex Plus: Delete {n} Conversations...']],
    'Delete alone counts the rows chosen that may go, and is titled for several as Claude Code Plus\'s is');
  eq([table.length, table.filter((m) => !/^Codex Plus: /.test(m.title)).map((m) => m.title)], [16, []],
    'every item of the list\'s right-click menus starts "Codex Plus: "');

  /* The when clauses, against what the page knows of a row or a header. Only `a == 'b'`, `x` and `!x` joined by && are
     used. */
  const holds = (when, ctx) => when.split('&&').map((p) => p.trim()).every((p) => {
    const m = /^([\w.]+) == '([^']*)'$/.exec(p);
    if (m) return String(ctx[m[1]]) === m[2];
    return p.startsWith('!') ? !ctx[p.slice(1)] : !!ctx[p];
  });
  const offered = (ctx) => table.filter((m) => holds(m.when, ctx)).map((m) => m.command.replace('codexPlus.', ''));
  const rowCtx = (r) => ({ webviewSection: 'thread', threadId: r.id, codexPlusGrouped: r.grouped, codexPlusUnread: r.unread });
  const unreadRow = rows.find((r) => r.id === ID(1)), readRow = rows.find((r) => r.id === ID(2));
  eq([offered(rowCtx(readRow)).filter((c) => /^markThread/.test(c)), offered(rowCtx(unreadRow)).filter((c) => /^markThread/.test(c))],
    [['markThreadUnread'], ['markThreadRead']], 'a read conversation offers Mark as Unread, an unread one Mark as Read');
  eq(offered(rowCtx(readRow)), ['openThreadInTab', 'openThreadInSidebar', 'moveThreadToSection', 'markThreadUnread', 'renameThread', 'setTitleColor', 'deleteThread'],
    'a row offers Resume, Add to Group, Mark as Unread, Rename, Text Color and Delete; Remove from Group only in a group');
  eq(pkg.contributes.commands.filter((c) => c.command === 'codexPlus.newGroupFromThreads').length, 0,
    'and no New Group from Conversation, which Claude Code\'s menu lacks: New group above the list makes a group');
  eq([offered({ ...rowCtx(readRow), codexPlusGoal: 'active' }).filter((c) => /Goal$/.test(c)),
    offered({ ...rowCtx(readRow), codexPlusGoal: 'budgetLimited', codexPlusGoalResumable: true }).filter((c) => /Goal$/.test(c))],
  [['pauseGoal', 'clearGoal'], ['resumeGoal', 'clearGoal']],
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
  eq([hm.menu === LIST_MENU && table.length > 0, (hm.colors || []).map((c) => c.name)], [true, ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']],
    'the model hands the page this table, and the colours of Text Color in Claude Code Plus\'s order');

  /* ── a group header's menu ── */
  eq(offered({ webviewSection: 'group', groupKey: 'section:a', codexPlusMade: true }),
    ['newThreadInGroup', 'newGroup', 'renameGroup', 'deleteGroup'], 'a group header offers Claude Code\'s four, in its order');
  eq(offered({ webviewSection: 'group', groupKey: 'ungrouped', codexPlusMade: false }), ['newGroup'], 'Ungrouped offers only New Group');

  /* ── the page's menus, against the table ── */
  const p = runSessionsPage(root);
  const prow = (n, extra = {}) => ({ id: ID(n), title: `Conversation ${n}`, time: '1d', dot: 'idle', color: '', open: false, sidebar: false,
    unread: false, grouped: false, group: 'Ungrouped', branch: '', goal: '', goalText: '', here: false, deletable: !extra.here, ...extra });
  const pageModel = (noGroups) => ({ account: null, closed: [], front: '', noGroups, menu: table, colors: hm.colors,
    open: [prow(6, { here: true, open: true })],
    groups: [{ key: 'section:pin', label: 'Pinned', made: false, rows: [prow(7, { grouped: true, group: 'Pinned' })] },
      { key: 'section:a', label: 'Alpha', made: true, rows: [prow(3, { grouped: true, group: 'Alpha' })] },
      { key: 'section:b', label: 'Beta', made: true, rows: [] },
      { key: 'ungrouped', label: 'Ungrouped', made: false, rows: [prow(1), prow(2, { unread: true }), prow(4, { goal: 'active' }),
        prow(5, { goal: 'budgetLimited' }), prow(6, { here: true, open: true })] }] });
  /* What a right-click on `target` draws: each item's title, and '-' for a separator. A click elsewhere closes it. */
  const drawn = (target) => {
    target.bubble('contextmenu', { clientX: 20, clientY: 40, button: 2 });
    const box = p.$$('.cp-ctx').find((b) => !b.classList.contains('cp-ctx-sub'));
    const out = box ? box.children.map((c) => (c.classList.contains('cp-ctx-sep') ? '-' : c.childNodes[0].textContent)) : [];
    p.page.bubble('mousedown', { button: 0 });
    p.page.bubble('click');
    return out;
  };
  /* What the table gives for `ctx`: the titles of the items that hold, with a separator wherever the group changes. */
  const expected = (ctx) => {
    const out = [];
    let last = '';
    for (const m of table) {
      if (!holds(m.when, ctx) || (m.rows === 'deletable' && !ctx.deletable)) continue;
      const g = m.group.split('@')[0];
      if (out.length && g !== last) out.push('-');
      out.push(m.title);
      last = g;
    }
    return out;
  };
  for (const noGroups of [false, true]) {
    const m = pageModel(noGroups);
    p.toPage({ type: 'model', model: m });
    const thread = (r) => ({ webviewSection: 'thread', codexPlusGrouped: !!r.grouped, codexPlusUnread: !!r.unread, codexPlusGoal: r.goal || '',
      codexPlusGoalResumable: ['paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(r.goal), codexPlusOpenHere: !!r.here, 'codexPlus.noGroups': noGroups, deletable: !!r.deletable });
    const cases = [];
    for (const g of m.groups) {
      cases.push([`${g.key} header`, p.$(`.cp-group[data-key="${g.key}"] .cp-group-head`),
        { webviewSection: 'group', groupKey: g.key, codexPlusMade: g.made, 'codexPlus.noGroups': noGroups }]);
      for (const r of g.rows) cases.push([`${g.key} row ${r.id.slice(-1)}`, p.$(`.cp-group[data-key="${g.key}"] .cp-row[data-id="${r.id}"]`), thread(r)]);
    }
    cases.push(['Open sessions row 6', p.$(`.cp-section[data-key="open"] .cp-row[data-id="${ID(6)}"]`), thread(m.open[0])]);
    const got = cases.map(([name, target, ctx]) => [name, drawn(target), expected(ctx)]);
    eq(got.filter(([, d, e]) => JSON.stringify(d) !== JSON.stringify(e)), [],
      `${noGroups ? 'with no groups in this Codex, ' : ''}each row and group header gets from the page the items the table gives for it, in its order and with its separators`);
    eq(got.filter(([, d]) => d.length).length, noGroups ? 8 : 12, `${noGroups ? 'with no groups, ' : ''}and every row, and every header that has any item, did get a menu`);
  }

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

  /* ── the words for an empty list ── */
  const page = fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.js'), 'utf8');
  eq([/'No sessions yet'/.test(page), /'No sessions found'/.test(page)], [true, true],
    'a list with nothing in it says "No sessions yet", and a search that finds nothing "No sessions found", as Claude Code\'s do');
};
