// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Goals: while a conversation with a goal is idle, Codex keeps starting turns toward it until the goal is done, blocked
 * or out of budget. The session list pauses, resumes and clears one with thread/goal/set and thread/goal/clear
 * (origin user), and each row shows the goal's state, read from Codex's goals database.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const fixture = require('../fixture');
const { createDom } = require('../fake-dom');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  /* ── what the extension declares ── */
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cmds = ['pauseGoal', 'resumeGoal', 'clearGoal'].map((c) => `codexPlus.${c}`);
  eq(cmds.filter((c) => !pkg.contributes.commands.some((x) => x.command === c)), [], 'Pause, Resume and Clear Goal are commands');
  const inList = (c) => (require('../../src/sessions-view').LIST_MENU || []).find((m) => m.command === c);
  eq(cmds.map((c) => !!inList(c) && /webviewSection == 'thread'/.test(inList(c).when)), [true, true, true],
    'all three are in a session row\'s right-click menu');
  eq([pkg.contributes.commands.some((x) => x.command === 'codexPlus.setGoal'), !!inList('codexPlus.setGoal')], [false, false],
    'there is no Set Goal, in the command palette or the menu');
  eq([/codexPlusGoal == 'active'/.test(inList('codexPlus.pauseGoal').when), /codexPlusGoalResumable/.test(inList('codexPlus.resumeGoal').when),
    /codexPlusGoal$/.test(inList('codexPlus.clearGoal').when)], [true, true, true],
  'Pause only on a row whose goal is running, Resume on one Codex or the user stopped, Clear only on a row that has one');
  eq(cmds.filter((c) => (pkg.contributes.menus.commandPalette || []).some((m) => m.command === c && m.when === 'false')), [],
    'and in the command palette, for the conversation in front');
  eq(Object.keys(pkg.contributes.configuration.properties).filter((k) => /goal/i.test(k)), [], 'nor a setting for the budget it started from');

  /* ── a conversation's goal, out of Codex's goals database ── */
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const home = tmp('home');
  const made = fixture.codexHome(home, [{ title: 'First', cwd: home, turns: [{}] }, { title: 'Second', cwd: home, turns: [{}] },
    { title: 'Third', cwd: home, turns: [{}] }]);
  const { DatabaseSync } = require('node:sqlite');
  const g = new DatabaseSync(path.join(home, 'goals_1.sqlite'));
  g.exec(`create table thread_goals (thread_id text primary key not null, goal_id text not null, objective text not null,
    status text not null, token_budget integer, tokens_used integer not null default 0, time_used_seconds integer not null default 0,
    created_at_ms integer not null, updated_at_ms integer not null)`);
  const put = g.prepare('insert into thread_goals values (?,?,?,?,?,?,?,?,?)');
  put.run(made[0].id, 'g1', 'Finish the report', 'active', 1000000, 2500, 30, 1, 2);
  put.run(made[1].id, 'g2', 'Ship it', 'budget_limited', 5000, 5000, 60, 1, 2);
  g.close();
  const files = require(path.join(root, 'src', 'codex-files.js'));
  eq([...files.goals(home)].map(([id, v]) => [id === made[0].id ? 0 : 1, v.status, v.objective, v.tokenBudget, v.tokensUsed]).sort(),
    [[0, 'active', 'Finish the report', 1000000, 2500], [1, 'budgetLimited', 'Ship it', 5000, 5000]],
    'goals are read from goals_1.sqlite, with the status named as the app-server names it');
  eq(files.goals(tmp('no-goals')).size, 0, 'a Codex home without a goals database has no goals');

  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
    globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  const view = control.showWebviewView('codexPlus.sessions');
  await view.fromPage({ kind: 'ready' });
  await tick(100);
  const model = () => [...view.posted].reverse().find((m) => m.type === 'model').model;
  const rowOf = (id) => model().groups.flatMap((x) => x.rows).find((r) => r.id === id) || {};
  eq([rowOf(made[0].id).goal, rowOf(made[1].id).goal, rowOf(made[2].id).goal], ['active', 'budgetLimited', ''],
    'each row carries its conversation\'s goal state, and none where it has no goal');
  eq(/Finish the report/.test(rowOf(made[0].id).goalText) && /2,500 of 1,000,000 tokens/.test(rowOf(made[0].id).goalText), true,
    'and what the goal is, with its tokens used of its budget, for the hover');

  /* ── the commands, on Codex's own connection ── */
  const requests = [];
  let handler = null;
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { requests.push({ method, params }); setTimeout(() => handler && handler.onResult({ id, result: { goal: {} } }), 1); },
  };
  globalThis.__codexExtrasMessage({}, { kind: 'none' }, { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} });
  const run = async (cmd, ...args) => { requests.length = 0; await control.state.handlers[`codexPlus.${cmd}`](...args); await tick();
    return requests.map((r) => [r.method, r.params]); };
  const row = (t) => ({ webview: 'codexPlus.sessions', webviewSection: 'thread', threadId: t.id });
  try {
    eq(Object.keys(control.state.handlers).filter((c) => /goal/i.test(c)).sort(), [...cmds].sort(),
      'the extension registers Pause, Resume and Clear Goal, and no command that sets a goal');
    eq(await run('pauseGoal', row(made[0])), [['thread/goal/set', { threadId: made[0].id, status: 'paused', origin: 'user' }]],
      'Pause Goal pauses it');
    eq(await run('resumeGoal', row(made[1])), [['thread/goal/set', { threadId: made[1].id, status: 'active', origin: 'user' }]],
      'Resume Goal sets it going again');
    eq(await run('clearGoal', row(made[1])), [['thread/goal/clear', { threadId: made[1].id, origin: 'user' }]], 'Clear Goal clears it');
    control.setTabs([control.codexTab(made[1].id)], 0);
    control.fireTabs();
    await tick(50);
    eq(await run('pauseGoal'), [['thread/goal/set', { threadId: made[1].id, status: 'paused', origin: 'user' }]],
      'from the command palette, the conversation in front');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }

  /* ── the row on the page ── */
  const dom = createDom();
  const page = dom.el('div', { attrs: { id: 'root' } });
  dom.setBody(dom.el('body', { kids: [page] }));
  const listeners = {};
  const sandbox = Object.assign({}, dom.sandbox, { window: { innerWidth: 400, innerHeight: 800, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } }, Map, Set, Proxy, Promise,
  acquireVsCodeApi: () => ({ postMessage() {}, getState: () => null, setState() {} }) });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.js'), 'utf8'), sandbox);
  const r = (id, goal) => ({ id, title: id, time: '1d', dot: 'idle', color: '', open: false, sidebar: false, unread: false, grouped: false,
    group: 'Ungrouped', branch: '', goal, goalText: goal ? `Goal: x (${goal})` : '' });
  for (const fn of listeners.message) fn({ data: { type: 'model', model: { account: null, closed: [], open: [], front: '', noGroups: false,
    menu: require('../../src/sessions-view').LIST_MENU,
    groups: [{ key: 'ungrouped', label: 'Ungrouped', made: false, rows: [r('01a1f0f0-0000-7000-8000-000000000001', 'active'),
      r('01a1f0f0-0000-7000-8000-000000000002', 'paused'), r('01a1f0f0-0000-7000-8000-000000000003', '')] }] } } });
  const rows = page.querySelectorAll('.cp-row');
  const badge = (e) => { const b = e.querySelector('.cp-goal'); return b && !b.classList.contains('cp-hidden') ? b.textContent : ''; };
  eq(rows.map(badge), ['goal', 'goal paused', ''], 'a row shows its goal\'s state before the time');
  const goalItems = (e) => {
    e.bubble('contextmenu', { clientX: 10, clientY: 10, button: 2 });
    const box = page.querySelector('.cp-ctx');
    const out = box ? box.querySelectorAll('.cp-ctx-item').map((b) => b.childNodes[0].textContent).filter((t) => /Goal/.test(t)) : [];
    page.bubble('mousedown', { button: 0 });
    page.bubble('click');
    return out;
  };
  eq(rows.map(goalItems), [['Codex Plus: Pause Goal', 'Codex Plus: Clear Goal'], ['Codex Plus: Resume Goal', 'Codex Plus: Clear Goal'], []],
    'and hands it to the right-click menu, which offers what fits it, and nothing on a row with no goal');
};
