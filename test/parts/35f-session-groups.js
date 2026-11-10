// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Session list groups (Codex sections): New Group, New Group from Conversation, Rename Group,
 * Delete Group, Add to Group and Remove from Group, each sent to Codex's app-server with the method and parameters an
 * offline app-server of Codex 26.1021.22027 accepted (threadSection/create, /update, /delete, /list and
 * thread/section/move). Codex keeps no order for its sections, so the list's order is this extension's own; Codex's
 * built-in Pinned section is never offered as a group to add to.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { createGroups, ordered, PINNED_SECTION, ORDER_KEY } = require('../../src/session-groups');

  /* ── the order, and whether this Codex has groups at all ── */
  const secs = new Map([[PINNED_SECTION, 'Pinned'], ['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]);
  eq(ordered(secs, ['c', 'gone', 'a']).map(([id]) => id), ['c', 'a', PINNED_SECTION, 'b'],
    'the stored order first, skipping a group that no longer exists, then the rest in Codex\'s order');
  const mem = fake.memento({ [ORDER_KEY]: ['c', 'a'] });
  const g = createGroups({ ask: async () => ({ outcome: 'done', result: { section: { id: 'd' } } }), sections: () => secs, memento: mem });
  eq([g.list().map(([id]) => id), g.choices().map(([id]) => id)], [[PINNED_SECTION, 'c', 'a', 'b'], ['c', 'a', 'b']],
    'Codex\'s built-in Pinned section is drawn first and is never one to add a conversation to');
  await g.create('  Delta   group ');
  eq(mem.get(ORDER_KEY), ['c', 'a', 'd'], 'a group made here goes last, as in Claude Code\'s list');
  const unknown = createGroups({ ask: async () => ({ outcome: 'failed', reason: 'Invalid request: unknown variant `threadSection/list`' }),
    sections: () => new Map(), memento: fake.memento() });
  eq([await unknown.probe(), unknown.supported()], [false, false], 'an app-server that does not know threadSection/list has no groups');
  let asked = null;
  const later = createGroups({ ask: async (m, p, o) => { asked = o; return { outcome: 'unavailable' }; }, sections: () => new Map(), memento: fake.memento() });
  eq([await later.probe({ fallback: false }), asked], [null, { fallback: false }],
    'asked on Codex\'s own connection before there is one, it stays unknown, so nothing is started to find out');

  /* ── the commands, through the extension ── */
  const home = tmp('home');
  const made = fixture.codexHome(home, [{ title: 'In a group', cwd: home, section: 'sec-1', turns: [{}] }, { title: 'Loose', cwd: home, turns: [{}] }]);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.prepare('insert into thread_sections values (?,?,?)').run(PINNED_SECTION, 'Pinned', null);
  db.close();
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: () => ({ accepted: true, code: '', reason: '', registration: { dispose() {} } }) } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const globalState = fake.memento({ 'codexPlus.patchRemoved': true });
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState, globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  const requests = [];
  let handler = null, made2 = 0;
  const answer = (r) => {
    if (r.method === 'threadSection/list') return { id: r.id, result: { data: [], nextCursor: null } };
    if (r.method === 'threadSection/create') return { id: r.id, result: { section: { id: `sec-new-${++made2}`, name: r.params.name, appearance: null } } };
    return { id: r.id, result: {} };
  };
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { const r = { name, id, method, params }; requests.push(r); setTimeout(() => handler && handler.onResult(answer(r)), 1); },
  };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} });
  const row = (t) => ({ kind: 'thread', thread: { id: t.id }, group: 'ungrouped' });
  const header = (id) => ({ kind: 'group', group: { key: `section:${id}`, label: 'x' } });
  const run = async (cmd, ...args) => {
    requests.length = 0;
    await control.state.handlers[`codexPlus.${cmd}`](...args);
    await tick();
    return requests.filter((r) => r.method !== 'threadSection/list').map((r) => [r.method, r.params]);
  };
  try {
    control.state.inputAnswer = (o) => (o.value === 'New group' ? 'Reading list' : undefined);
    eq(await run('newGroup'), [['threadSection/create', { name: 'Reading list' }]], 'New Group asks for a name, starting from "New group", and makes it');
    eq(globalState.get(ORDER_KEY), ['sec-new-1'], 'and remembers where it goes');
    control.state.inputAnswer = 'From two';
    eq(await run('newGroupFromThreads', row(made[1]), [row(made[1]), row(made[0])]),
      [['threadSection/create', { name: 'From two' }], ['thread/section/move', { threadId: made[1].id, sectionId: 'sec-new-2' }],
        ['thread/section/move', { threadId: made[0].id, sectionId: 'sec-new-2' }]],
      'New Group from Conversation makes a group and moves every selected conversation into it');
    control.state.inputAnswer = (o) => (o.value === 'Pinned' ? 'Renamed' : undefined);
    eq(await run('renameGroup', header('sec-1')), [['threadSection/update', { sectionId: 'sec-1', name: 'Renamed' }]],
      'Rename Group starts from the group\'s name and renames it');
    eq(await run('deleteGroup', header('sec-1')), [['threadSection/delete', { sectionId: 'sec-1' }]],
      'Delete Group deletes it; Codex puts its conversations back among the ungrouped');
    eq(await run('deleteGroup', { kind: 'group', group: { key: 'ungrouped' } }), [], 'and a group that is not one of Codex\'s sections is left alone');

    control.state.picks.length = 0;
    control.state.pickAnswer = (items) => items.find((i) => i.sectionId === 'sec-1');
    eq(await run('moveThreadToSection', row(made[1])), [['thread/section/move', { threadId: made[1].id, sectionId: 'sec-1' }]],
      'Add to Group moves the conversation into the group picked');
    eq(control.state.picks[0].some((i) => i.sectionId === PINNED_SECTION || i.sectionId === null), false,
      'and offers neither Codex\'s built-in Pinned section nor "no group"');
    control.state.picks.length = 0;
    control.state.said.length = 0;
    await run('moveThreadToSection', row(made[0]));
    eq([control.state.picks.length, control.state.said.some((s) => /no other group/.test(s.message))], [0, true],
      'nor the group the conversation is already in, so with that the only one it says there is no other');
    eq(await run('removeFromGroup', row(made[0]), [row(made[0]), row(made[1])]), [['thread/section/move', { threadId: made[0].id, sectionId: null }]],
      'Remove from Group takes out the selected conversations that are in a group, and leaves the others');
    control.state.inputAnswer = 'Third';
    eq(await run('newGroupFromThreads', row(made[1]), [row(made[0])]).then((r) => r.filter(([m]) => m === 'thread/section/move').map(([, p]) => p.threadId)),
      [made[1].id], 'a right-click on a row outside the selection acts on that row alone, as in a file explorer');

    const page = control.showWebviewView('codexPlus.sessions');
    await page.fromPage({ kind: 'ready' });
    const m = page.posted.filter((x) => x.type === 'model').pop().model;
    const sec = m.groups.find((x) => x.key === 'section:sec-1');
    eq([sec.label, sec.made, sec.rows.map((r) => r.grouped)], ['Pinned', true, [true]],
      'a section and a row in it carry what their right-click menus are chosen by: a group the user made, and a row in a group');
    requests.length = 0;
    await page.fromPage({ kind: 'move', ids: [made[1].id], key: 'section:sec-1' });
    await page.fromPage({ kind: 'move', ids: [made[0].id], key: 'ungrouped' });
    await page.fromPage({ kind: 'move', ids: [made[0].id], key: 'section:sec-1' });
    await tick();
    eq(requests.filter((r) => r.method === 'thread/section/move').map((r) => r.params),
      [{ threadId: made[1].id, sectionId: 'sec-1' }, { threadId: made[0].id, sectionId: null }],
      'rows dropped on a group are moved into it, on Ungrouped out of any group, and a drop on the group a row is already in does nothing');
    requests.length = 0;
    await page.fromPage({ kind: 'renameGroup', key: 'section:sec-1', name: ' Reading ' });
    await page.fromPage({ kind: 'rename', id: made[1].id, title: 'New  title' });
    await tick();
    eq(requests.map((r) => [r.method, r.params]).filter(([meth]) => meth !== 'threadSection/list'),
      [['threadSection/update', { sectionId: 'sec-1', name: 'Reading' }], ['thread/name/set', { threadId: made[1].id, name: 'New title' }]],
      'a group\'s name and a title edited where they are drawn are sent as Rename Group and Rename send them');
    page.posted.length = 0;
    requests.length = 0;
    await page.fromPage({ kind: 'newGroup' });
    await tick();
    eq([requests.filter((r) => r.method === 'threadSection/create').map((r) => r.params.name), page.posted.filter((x) => x.type === 'startRenameGroup').map((x) => x.key)],
      [['New group'], [`section:sec-new-${made2}`]], 'New group in the list makes "New group" and has the page edit its name where it is drawn, as Claude Code\'s does');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }

  /* ── the manifest ── */
  const cmd = (id) => pkg.contributes.commands.find((c) => c.command === `codexPlus.${id}`);
  eq(['newGroup', 'newGroupFromThreads', 'renameGroup', 'deleteGroup', 'moveThreadToSection', 'removeFromGroup'].map((id) => (cmd(id) || {}).title),
    ['Codex Plus: New Group...', 'Codex Plus: New Group from Conversation...', 'Codex Plus: Rename Group...', 'Codex Plus: Delete Group',
      'Codex Plus: Add to Group...', 'Codex Plus: Remove from Group'], 'each group command is named as Claude Code names it, after "Codex Plus: "');
  const menus = Object.values(pkg.contributes.menus).flat().filter((m) => ['codexPlus.newGroup', 'codexPlus.newGroupFromThreads',
    'codexPlus.renameGroup', 'codexPlus.deleteGroup', 'codexPlus.moveThreadToSection'].includes(m.command) && m.when !== 'false');
  eq(menus.filter((m) => !/!codexPlus\.noGroups/.test(m.when) && !/webviewId == 'chatgpt\.conversationEditor'/.test(m.when)).map((m) => m.command), [],
    'none of them is offered once this Codex is known to have no groups');
};
