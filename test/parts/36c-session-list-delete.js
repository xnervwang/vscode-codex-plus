// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Deleting for Agent Plus's session list (runSessionAction 'delete'). Agent Plus asks the user and lets only archived
 * conversations through; this side looks again when asked and never deletes one open or running here, open in another
 * VS Code window, or whose sub-agent is, since Codex deletes a conversation's sub-agents with it. What Codex Plus kept
 * for a deleted conversation goes too: its plan and side files, its title colour, its row in what this window closed.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => `01a1dddd-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];

  /* ── the side files of a conversation, and the record of tabs closed ── */
  const workplan = require(path.join(root, 'src', 'workplan.js'));
  const sideDir = tmp('side');
  for (const name of [`${ID(1)}.json`, `${ID(1)}.wakeup`, `${ID(1)}.woke`, `${ID(1)}.tz`, `${ID(2)}.json`, 'notes.txt']) fs.writeFileSync(path.join(sideDir, name), 'x');
  fs.mkdirSync(path.join(sideDir, `${ID(1)}.json.lock`));
  fs.mkdirSync(path.join(sideDir, `${ID(1)}.wakeup.lock`));
  fs.mkdirSync(path.join(sideDir, 'closed'));
  for (const name of [`${ID(1)}.json`, `${ID(2)}.json`]) fs.writeFileSync(path.join(sideDir, 'closed', name), 'x');
  eq([workplan.removeSideFiles(sideDir, [ID(1), 'not-an-id', '../x']), fs.readdirSync(sideDir).sort(), fs.readdirSync(path.join(sideDir, 'closed'))],
    [[], [`${ID(2)}.json`, 'closed', 'notes.txt'], [`${ID(2)}.json`]],
    'removeSideFiles deletes a conversation\'s plan, its closed rows, wake-up and other side files and its two lock folders, and nothing named otherwise');
  const { TabMemory, CLOSED_KEY } = require(path.join(root, 'src', 'tab-memory.js'));
  const memory = new TabMemory(vscode, fake.memento({ [CLOSED_KEY]: [{ thread: ID(1), title: 'a', at: 2 }, { thread: ID(2), title: 'b', at: 1 }] }));
  await memory.forget([ID(1)]);
  eq(memory.recentlyClosed().map((c) => c.thread), [ID(2)], 'forget takes a conversation out of what this window closed');
  memory.dispose();

  /* ── the extension ── */
  const home = tmp('home');
  const now = Date.now();
  const spawn = (parent, nickname) => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: nickname } } });
  fixture.codexHome(home, [
    { id: ID(1), title: 'First', cwd: home, turns: [{}] },
    { id: ID(3), title: 'Open here', cwd: home, turns: [{}] },
    { id: ID(4), title: 'Running', cwd: home, startMs: now - 120e3, turns: [{ running: true }] },
    { id: ID(5), title: 'Parent', cwd: home, turns: [{}] },
    { id: ID(6), title: 'Scout', cwd: home, threadSource: 'subagent', source: spawn(ID(5), 'Scout'), turns: [{}] },
    { id: ID(7), title: 'Holder', cwd: home, turns: [{}] },
    { id: ID(8), title: 'Lookout', cwd: home, threadSource: 'subagent', source: spawn(ID(7), 'Lookout'), turns: [{}] },
    { id: ID(10), title: 'Refused', cwd: home, turns: [{}] },
    { id: ID(11), title: 'Gone already', cwd: home, turns: [{}] },
    { id: ID(12), title: 'Elsewhere', cwd: home, turns: [{}] },
    { id: ID(13), title: 'Watcher', cwd: home, turns: [{}] },
    { id: ID(14), title: 'Sentry', cwd: home, threadSource: 'subagent', source: spawn(ID(13), 'Sentry'), turns: [{}] },
  ]);
  const planDir = path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras');
  fs.mkdirSync(planDir, { recursive: true });
  for (const n of [1, 6, 10, 11]) fs.writeFileSync(path.join(planDir, `${ID(n)}.json`), JSON.stringify({ nodes: [] }));
  fs.writeFileSync(path.join(planDir, `${ID(1)}.wakeup`), JSON.stringify({ everyMinutes: 30, prompt: 'go on', setAt: 1, expiresAt: 2 }));
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: ['sessionList'],
    sessionListManages: () => true,
    registerSource: (s) => { control.state.source = s; return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  vscode.workspace.name = 'Window A';
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.join(home, 'a')), name: 'a', index: 0 }];
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const globalState = fake.memento({ 'codexPlus.patchRemoved': true, 'codexPlus.titleColors': { [ID(1)]: 'red', [ID(6)]: 'blue', [ID(10)]: 'pink' } });
  const workspaceState = fake.memento({ 'codexPlus.recentlyClosed': [{ thread: ID(1), title: 'First', at: 2 }] });
  await ext.activate({ subscriptions: subs, workspaceState, globalState, globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);
  const requests = [];
  let handler = null, answer = (r) => ({ id: r.id, result: {} });
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { const r = { name, id, method, params }; requests.push(r); setTimeout(() => handler && handler.onResult(answer(r)), 1); },
  };
  const provider = { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} };
  const src = control.state.source;
  const del = async (...ns) => {
    requests.length = 0;
    const r = await src.runSessionAction('delete', ns.map(ID), {});
    await tick();
    return [requests.filter((x) => x.method === 'thread/delete').map((x) => x.params.threadId), r.results.map((x) => (x.outcome === 'done' ? 'done' : x.reason))];
  };
  const plans = () => fs.readdirSync(planDir).sort();
  const colorsNow = () => Object.keys(globalState.get('codexPlus.titleColors') || {}).sort();
  try {
    /* ── before the patch has handed over Codex's connection ── */
    control.state.extensions.set('openai.chatgpt', { isActive: true, packageJSON: { version: '26.1106.51428' }, extensionPath: tmp('no-codex') });
    eq(await del(1), [[], ['this window could not tell which conversations are open']],
      'while Codex runs here but its pages have not connected, which conversations they show is not known, so nothing is deleted');
    control.state.extensions.delete('openai.chatgpt');
    const before = plans();
    const fallback = await del(1);
    eq([fallback[0], fallback[1][0] !== 'done', plans()], [[], true, before],
      'with Codex not started here the request goes to a short-lived app-server, and with no codex program it fails and nothing of Codex Plus\'s is removed');
    globalThis.__codexExtrasMessage({}, { kind: 'none' }, provider);

    /* ── one conversation ── */
    eq(await del(1), [[ID(1)], ['done']], 'thread/delete is sent for the conversation on Codex\'s connection');
    await tick(100);
    eq([plans().filter((n) => n.startsWith(ID(1))), colorsNow().includes(ID(1)), (workspaceState.get('codexPlus.recentlyClosed') || []).map((c) => c.thread)],
      [[], false, []], 'its plan, wake-up and title colour go with it, and so does its row in what this window closed');
    eq(control.state.log.some((l) => l.includes(`Deleted "First" (${ID(1)})`)), true, 'and the output "Codex Plus" has a line for it');

    /* ── open here, running, and sub-agents ── */
    control.setTabs([control.codexTab(ID(3)), control.codexTab(ID(8))], 0);
    control.fireTabs();
    await tick(100);
    eq(await del(3, 4), [[], ['it is open or running', 'it is open or running']], 'one open in this window or running is left alone');
    eq(await del(5), [[ID(5)], ['done']], 'a conversation with a sub-agent goes with one request, since Codex deletes its sub-agents with it');
    await tick(100);
    eq([plans().includes(`${ID(6)}.json`), colorsNow().includes(ID(6))], [false, false], 'and its sub-agent\'s plan and colour go with it');
    eq(await del(7), [[], ['its sub-agent "Lookout" is open or running']], 'one whose sub-agent is open is left alone');

    /* ── open in another window ── */
    const windowsDir = path.join(planDir, 'windows');
    const other = process.ppid;
    const entry = (pid, sessions, extra = {}) => {
      fs.mkdirSync(windowsDir, { recursive: true });
      fs.writeFileSync(path.join(windowsDir, `${pid}.json`), JSON.stringify({ pid, at: Date.now(), name: 'Window B', folders: ['/b'], sessions, ...extra }));
    };
    entry(other, [ID(12), ID(14)]);
    eq(await del(12, 13), [[], ['it is open in the VS Code window "Window B"', 'its sub-agent "Sentry" is open in the VS Code window "Window B"']],
      'one open in another window is left alone, and so is one whose sub-agent is, each saying which window');
    entry(other, [ID(12)], { at: Date.now() - 5 * 60e3 });
    eq((await del(12))[1], ['done'], 'an entry not written for minutes is of a window that is gone');
    fs.rmSync(path.join(windowsDir, `${other}.json`), { force: true });
    const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
    entry(dead, [ID(13)]);
    eq((await del(13))[1], ['done'], 'and so is an entry whose window process has ended');
    fs.rmSync(path.join(windowsDir, `${dead}.json`), { force: true });

    /* ── Codex refusing ── */
    answer = (r) => ({ id: r.id, error: { code: -32600, message: r.params.threadId === ID(11) ? `no rollout found for thread id ${ID(11)}` : 'busy' } });
    const refused = await del(10, 11);
    answer = (r) => ({ id: r.id, result: {} });
    await tick(100);
    eq([refused, plans().includes(`${ID(10)}.json`), colorsNow().includes(ID(10)), plans().includes(`${ID(11)}.json`)], [[[ID(10), ID(11)], ['busy', 'done']], true, true, false],
      'Codex\'s refusal is passed on and what Codex Plus keeps for it stays; one Codex no longer has counts as gone, and its plan goes');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
  eq(fs.existsSync(path.join(planDir, 'windows', `${process.pid}.json`)), false, 'once the extension stops, its window entry is taken away');
};
