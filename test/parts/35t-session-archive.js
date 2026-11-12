// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Archived sessions in the session list, as in Claude Code's list: Archive in the menu of an ordinary row, and
 * Unarchive, then Delete after a separator, in the menu of an archived one. Archived conversations have a group of
 * their own at the bottom, collapsed until opened, most recently archived first.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');
const { runSessionsPage } = require('../sessions-page-run');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => `01a1abab-0000-7000-8000-${String(n).padStart(12, '0')}`;
const DAY = 864e5;

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  /* ── the manifest ── */
  const titled = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
  eq(['codexPlus.archiveThread', 'codexPlus.unarchiveThread', 'codexPlus.deleteThread'].map((c) => titled.get(c) || null),
    ['Codex Plus: Archive', 'Codex Plus: Unarchive', 'Codex Plus: Delete Conversation...'],
    'Archive and Unarchive are commands, titled as the list\'s other items are');
  const palette = pkg.contributes.menus.commandPalette || [];
  eq(['codexPlus.archiveThread', 'codexPlus.unarchiveThread', 'codexPlus.deleteThread'].map((c) => palette.some((m) => m.command === c && m.when === 'false')),
    [true, true, true], 'none of the three is in the command palette');
  eq((pkg.contributes.menus['webview/context'] || []).filter((m) => /archive|delete/i.test(m.command)), [],
    'nor in a conversation tab\'s own menu');
  const setting = pkg.contributes.configuration.properties['codexPlus.deleteArchivedAfterDays'] || {};
  eq([setting.type, setting.default, setting.minimum], ['integer', 30, 0],
    'how long an archived conversation is kept is a setting, 30 days unless changed');

  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { group, SessionsModel, LIST_MENU } = require(path.join(root, 'src', 'sessions-view.js'));

  /* ── the group ── */
  const t = (n, extra = {}) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', archived: false, section: '', createdMs: 1000,
    updatedMs: 2000 + n, ...extra });
  const threads = [t(1), t(2, { archived: true, archivedMs: 5 * DAY }), t(3, { archived: true, archivedMs: 9 * DAY }),
    t(4, { archived: true, archivedMs: 0 }), t(5, { archived: true, archivedMs: 7 * DAY, cwd: '/elsewhere' }),
    t(6, { archived: true, archivedMs: 8 * DAY, kind: 'subagent', parent: ID(3) }), t(7, { section: 'sec-a' })];
  const cwdFilter = (cwd) => cwd === '/w';
  const keys = (gs) => gs.map((g) => `${g.key}:${g.threads.map((x) => x.title).join('|')}`);
  const gs = group(threads, { sections: new Map([['sec-a', 'Alpha']]), cwdFilter, archivedAt: (id) => (id === ID(4) ? 6 * DAY : 0) });
  eq(keys(gs), ['closed:', 'open:', 'section:sec-a:t7', 'ungrouped:t1', 'archived:t3|t4|t2'],
    'Archived sessions comes after Ungrouped and holds this workspace\'s archived conversations, most recently archived first; one Codex gave '
      + 'no archive time is placed by when this extension first saw it archived; none is in another group, and a sub-agent is left out as elsewhere');
  const last = gs[gs.length - 1];
  eq([last.label, last.expanded], ['Archived sessions', false], 'it is named and collapsed as Claude Code\'s is');
  eq(keys(group(threads, { sections: new Map(), cwdFilter, hideBackground: false })).pop(), 'archived:t3|t6|t2|t4',
    'with the background filter off, an archived sub-agent is drawn under its archived parent, and one with no archive time known comes last');
  eq(keys(group(threads.filter((x) => !x.archived), { sections: new Map(), cwdFilter })).pop(), 'archived:',
    'with nothing archived the group is empty, and an empty group the user did not make is not drawn');

  /* ── the rows ── */
  const mine = [t(10), t(11), t(12, { archived: true, archivedMs: 3 * DAY }), t(13, { archived: true, archivedMs: 2 * DAY })];
  const model = new SessionsModel(vscode, { memory: { openThreads: () => [ID(13)], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => mine, sections: () => new Map(), state: () => ({}), thread: () => null },
    stateOf: (id) => ({ state: id === ID(11) ? 'working' : 'idle', runningHere: id === ID(11) }),
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) }).model();
  const flags = (r) => `${r.id.slice(-2)}:${r.archived ? 'A' : '-'}${r.archivable ? 'a' : '-'}${r.deletable ? 'd' : '-'}`;
  eq([model.groups.map((g) => g.key), model.groups.map((g) => g.rows.map(flags)), model.open.map(flags)],
    [['ungrouped', 'archived'], [['10:-a-', '11:---'], ['12:A-d', '13:A--']], ['13:A--']],
    'an ordinary row may be archived unless it is running, and only an archived one deleted, unless it is open here');
  eq(model.groups[1].rows.map((r) => r.group), ['Archived sessions', 'Archived sessions'], 'the hover names the group as Claude Code Plus does');

  /* ── the menu table ── */
  const byCmd = new Map(LIST_MENU.map((m) => [m.command, m]));
  eq(['archiveThread', 'unarchiveThread', 'deleteThread'].map((c) => { const m = byCmd.get(`codexPlus.${c}`) || {}; return [m.group, m.when, m.rows, m.plural]; }),
    [['8_archive@1', "webviewSection == 'thread' && !codexPlusArchived", 'archivable', 'Codex Plus: Archive {n} Conversations'],
      ['8_archive@2', "webviewSection == 'thread' && codexPlusArchived", 'archived', 'Codex Plus: Unarchive {n} Conversations'],
      ['9_delete@1', "webviewSection == 'thread' && codexPlusArchived", 'deletable', 'Codex Plus: Delete {n} Conversations...']],
    'Archive is offered on a row that is not archived, Unarchive and Delete on one that is, each counting the rows chosen it applies to');

  /* ── the page ── */
  const p = runSessionsPage(root);
  const prow = (n, extra = {}) => ({ id: ID(n), title: `Conversation ${n}`, time: '1d', dot: 'none', color: '', open: false, sidebar: false,
    unread: false, grouped: false, group: 'Ungrouped', branch: '', goal: '', goalText: '', here: false, archived: false, archivable: true,
    deletable: false, ...extra });
  const arow = (n, extra = {}) => prow(n, { group: 'Archived sessions', archived: true, archivable: false, deletable: true, ...extra });
  p.toPage({ type: 'model', model: { account: null, closed: [], front: '', noGroups: false, menu: LIST_MENU, colors: [],
    open: [arow(9, { here: true, open: true, deletable: false })],
    groups: [{ key: 'ungrouped', label: 'Ungrouped', made: false, rows: [prow(1), prow(2), prow(3, { dot: 'working', archivable: false })] },
      { key: 'archived', label: 'Archived sessions', made: false, rows: [arow(4), arow(5), arow(9, { here: true, open: true, deletable: false })] }] } });
  const rowEl = (key, n) => p.$(`.cp-group[data-key="${key}"] .cp-row[data-id="${ID(n)}"]`);
  const groupEl = (key) => p.$(`.cp-group[data-key="${key}"]`);
  eq([!!groupEl('archived'), !!groupEl('archived') && groupEl('archived').classList.contains('cp-open'), groupEl('ungrouped').classList.contains('cp-open')],
    [true, false, true], 'the page draws Archived sessions collapsed until it is opened, and the other groups open');
  const drawn = (target) => {
    target.bubble('contextmenu', { clientX: 20, clientY: 40, button: 2 });
    const box = p.$$('.cp-ctx').find((b) => !b.classList.contains('cp-ctx-sub'));
    const out = box ? box.children.map((c) => (c.classList.contains('cp-ctx-sep') ? '-' : c.childNodes[0].textContent)) : [];
    p.page.bubble('mousedown', { button: 0 });
    p.page.bubble('click');
    return out;
  };
  const choose = (...ns) => { p.page.bubble('keydown', { key: 'Escape' }); for (const [key, n] of ns) rowEl(key, n).bubble('click', { ctrlKey: true }); };
  choose();
  const plain = drawn(rowEl('ungrouped', 1));
  eq([plain.slice(-3), plain.filter((x) => /Unarchive|Delete/.test(x))], [['Codex Plus: Text Color', '-', 'Codex Plus: Archive'], []],
    'an ordinary row\'s menu ends with Archive after a separator, as Claude Code\'s does, and has no Unarchive and no Delete');
  eq(drawn(rowEl('archived', 4)), ['Codex Plus: Resume in Tab', 'Codex Plus: Resume in Sidebar', '-', 'Codex Plus: Text Color', '-',
    'Codex Plus: Unarchive', '-', 'Codex Plus: Delete Conversation...'],
  'an archived row offers Resume, Text Color, Unarchive, and Delete after a separator, as Claude Code Plus\'s Archived sessions menu does');
  eq(drawn(p.$(`.cp-section[data-key="open"] .cp-row[data-id="${ID(9)}"]`)), ['Codex Plus: Text Color', '-', 'Codex Plus: Unarchive'],
    'an archived conversation open here offers Unarchive wherever it is listed, and no Delete');
  choose(['archived', 4], ['archived', 5]);
  const two = drawn(rowEl('archived', 4)).filter((x) => /archive|Delete/i.test(x));
  choose(['archived', 4], ['archived', 9]);
  const withOpen = drawn(rowEl('archived', 4)).filter((x) => /archive|Delete/i.test(x));
  eq([two, withOpen], [['Codex Plus: Unarchive 2 Conversations', 'Codex Plus: Delete 2 Conversations...'],
    ['Codex Plus: Unarchive 2 Conversations', 'Codex Plus: Delete Conversation...']],
  'with several chosen, Unarchive and Delete count them; Delete leaves out one open here');
  choose(['ungrouped', 1], ['ungrouped', 2]);
  const twoPlain = drawn(rowEl('ungrouped', 1)).filter((x) => /archive/i.test(x));
  choose(['ungrouped', 1], ['ungrouped', 3]);
  const withRunning = drawn(rowEl('ungrouped', 1)).filter((x) => /archive/i.test(x));
  choose();
  const running = drawn(rowEl('ungrouped', 3)).filter((x) => /archive/i.test(x));
  eq([twoPlain, withRunning, running], [['Codex Plus: Archive 2 Conversations'], ['Codex Plus: Archive'], []],
    'Archive counts the rows chosen that are not running, and is not offered on a running one alone');
  const acts = (r) => r.querySelector('.cp-actions');
  eq([rowEl('archived', 4).draggable, acts(rowEl('archived', 4)).classList.contains('cp-hidden'),
    rowEl('ungrouped', 1).draggable, acts(rowEl('ungrouped', 1)).classList.contains('cp-hidden')], [false, true, true, false],
  'an archived row has no Rename button and cannot be dragged onto a group, as its menu has neither Rename nor Add to Group');

  /* ── the commands ── */
  const home = tmp('home');
  const now = Date.now();
  const spawn = (parent, nickname) => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: nickname } } });
  fixture.codexHome(home, [
    { id: ID(21), title: 'Idle', cwd: home, turns: [{}] },
    { id: ID(22), title: 'Running', cwd: home, startMs: now - 120e3, turns: [{ running: true }] },
    { id: ID(23), title: 'Open idle', cwd: home, turns: [{}] },
    { id: ID(24), title: 'Put away', cwd: home, archived: true, turns: [{}] },
    { id: ID(25), title: 'Put away too', cwd: home, archived: true, turns: [{}] },
    { id: ID(26), title: 'Boss', cwd: home, turns: [{}] },
    { id: ID(27), title: 'Worker', cwd: home, threadSource: 'subagent', source: spawn(ID(26), 'Worker'), startMs: now - 120e3, turns: [{ running: true }] },
  ]);
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: (s) => { control.state.source = s; return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  const requests = [];
  let handler = null, answer = (r) => ({ id: r.id, result: {} });
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { const r = { name, id, method, params }; requests.push(r); setTimeout(() => handler && handler.onResult(answer(r)), 1); },
  };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} });
  control.setTabs([control.codexTab(ID(23))], 0);
  control.fireTabs();
  await tick(100);
  const row = (n) => ({ webviewSection: 'thread', threadId: ID(n), webview: 'codexPlus.sessions' });
  const said = () => control.state.said.map((s) => s.message);
  const send = async (cmd, n, selected) => {
    requests.length = 0;
    control.state.said.length = 0;
    const fn = control.state.handlers[`codexPlus.${cmd}`];
    if (fn) await fn(row(n), selected ? selected.map(ID) : undefined);
    await tick();
    return requests.map((r) => [r.method, r.params && r.params.threadId]);
  };
  try {
    eq(['archiveThread', 'unarchiveThread'].map((c) => typeof control.state.handlers[`codexPlus.${c}`]), ['function', 'function'], 'both commands are registered');
    eq(await send('archiveThread', 21), [['thread/archive', ID(21)]], 'Archive sends thread/archive for the conversation, on Codex\'s connection');
    eq([await send('archiveThread', 22), said()], [[], ['Not archived: "Running" is running, and archiving it would stop its turn.']],
      'one running is left alone, and the user is told why: Codex stops a running turn to archive its conversation');
    eq(await send('archiveThread', 23), [['thread/archive', ID(23)]], 'one open in a tab is archived, as Claude Code archives an open session');
    eq([await send('archiveThread', 21, [21, 22]), said()],
      [[['thread/archive', ID(21)]], ['Not archived: "Running" is running, and archiving it would stop its turn.']],
      'of several chosen, those that are running are left out');
    eq([await send('archiveThread', 26), said()], [[], ['Not archived: "Boss" (its sub-agent "Worker") is running, and archiving it would stop its turn.']],
      'and one whose sub-agent is running, since Codex archives a conversation\'s sub-agents with it');
    eq(await send('archiveThread', 24), [], 'one already archived is not sent again');
    eq(await send('unarchiveThread', 24, [24, 25]), [['thread/unarchive', ID(24)], ['thread/unarchive', ID(25)]],
      'Unarchive sends thread/unarchive for each conversation chosen');
    eq(await send('unarchiveThread', 21), [], 'and nothing for one that is not archived');
    answer = (r) => ({ id: r.id, error: { code: -32600, message: `no archived rollout found for thread id ${r.params.threadId}` } });
    eq([await send('unarchiveThread', 25), said()], [[['thread/unarchive', ID(25)]], []],
      'one Codex no longer has archived, unarchived from another window say, counts as done');
    answer = (r) => ({ id: r.id, error: { code: -32600, message: 'busy' } });
    eq([await send('archiveThread', 21), said(), control.state.log.some((l) => l.includes(`"Idle" (${ID(21)}): busy`))],
      [[['thread/archive', ID(21)]], ['1 conversation could not be archived; the output "Codex Plus" lists them.'], true],
      'one Codex refuses is reported, pointing at the output, which says why');
    answer = (r) => ({ id: r.id, result: {} });
    control.answer('from disk?', 'Delete');
    eq([await send('deleteThread', 21), said()], [[], []], 'Delete leaves a conversation that is not archived alone, and asks nothing');
    eq(await send('deleteThread', 25), [['thread/delete', ID(25)]], 'and deletes an archived one once it is confirmed');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
