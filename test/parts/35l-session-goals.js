// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Goals: while a conversation with a goal is idle, Codex keeps starting turns toward it until the goal is done, blocked
 * or out of budget. Pause, Resume and Clear Goal, from the command palette for the conversation in front and from Agent
 * Plus's session list, send thread/goal/set and thread/goal/clear (origin user), and the list's rows show the goal's
 * state, read from Codex's goals database (src/session-list-source.js).
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  /* ── what the extension declares ── */
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cmds = ['pauseGoal', 'resumeGoal', 'clearGoal'].map((c) => `codexPlus.${c}`);
  eq(cmds.filter((c) => !pkg.contributes.commands.some((x) => x.command === c)), [], 'Pause, Resume and Clear Goal are commands');
  eq(pkg.contributes.commands.some((x) => x.command === 'codexPlus.setGoal'), false, 'there is no Set Goal');
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
  const row = (t) => t.id;
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

};
