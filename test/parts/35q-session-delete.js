// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Delete in the menu of a row in Archived sessions. Only an archived conversation is deleted, as in Claude Code Plus;
 * test/parts/35t-session-archive.js checks that a conversation that is not archived is left alone.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => `01a1dddd-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, tmp, root }) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  /* ── the manifest ── */
  const command = pkg.contributes.commands.find((c) => c.command === 'codexPlus.deleteThread');
  eq(command ? command.title : null, 'Codex Plus: Delete Conversation...', 'Delete is a command titled as the list\'s other items are');
  const menus = pkg.contributes.menus;
  eq([(menus.commandPalette || []).some((m) => m.command === 'codexPlus.deleteThread' && m.when === 'false'),
    (menus['webview/context'] || []).some((m) => m.command === 'codexPlus.deleteThread')], [true, false],
  'it is hidden from the command palette, as the list\'s other row commands are, and a conversation tab\'s own menu does not have it');

  const { vscode, control } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];

  /* ── which rows the page may offer it for ── */
  const { SessionsModel } = require(path.join(root, 'src', 'sessions-view.js'));
  const threads = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', section: '', archived: true,
    createdMs: 1, updatedMs: n }));
  const looks = { [ID(3)]: 'working', [ID(4)]: 'prompt', [ID(5)]: 'idle', [ID(6)]: 'unread' };
  const model = new SessionsModel(vscode, { memory: { openThreads: () => [ID(1)], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
    reader: { threads: () => threads, sections: () => new Map(), state: (id) => (id === ID(7) ? null : {}), thread: () => null },
    sidebarShowing: () => ID(2), stateOf: (id) => ({ state: looks[id] || 'idle', runningHere: id === ID(3) }),
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) }).model();
  const deletable = (list) => list.map((r) => `${r.id.slice(-1)}${r.deletable ? '+' : '-'}`).sort();
  eq([deletable(model.open), deletable(model.groups.flatMap((g) => g.rows))],
    [['1-', '2-'], ['1-', '2-', '3-', '4-', '5+', '6+', '7+', '8+']],
    'a row is offered for deletion unless it is open here, in a tab or in Codex\'s sidebar, in Open sessions, running or waiting for the user; '
      + 'one whose rollout was not read is offered, and the host reads it before asking');

  /* ── the side files of a conversation, and the record of tabs closed ── */
  const workplan = require(path.join(root, 'src', 'workplan.js'));
  const sideDir = tmp('side');
  for (const name of [`${ID(1)}.json`, `${ID(1)}.wakeup`, `${ID(1)}.woke`, `${ID(1)}.tz`, `${ID(2)}.json`, 'notes.txt']) fs.writeFileSync(path.join(sideDir, name), 'x');
  fs.mkdirSync(path.join(sideDir, `${ID(1)}.json.lock`));
  fs.mkdirSync(path.join(sideDir, `${ID(1)}.wakeup.lock`));
  fs.mkdirSync(path.join(sideDir, 'closed'));
  for (const name of [`${ID(1)}.json`, `${ID(2)}.json`]) fs.writeFileSync(path.join(sideDir, 'closed', name), 'x');
  const failedSide = typeof workplan.removeSideFiles === 'function' ? workplan.removeSideFiles(sideDir, [ID(1), 'not-an-id', '../x']) : null;
  eq([failedSide, fs.readdirSync(sideDir).sort(), fs.readdirSync(path.join(sideDir, 'closed'))], [[], [`${ID(2)}.json`, 'closed', 'notes.txt'], [`${ID(2)}.json`]],
    'removeSideFiles deletes a conversation\'s plan, its closed rows, wake-up and other side files and its two lock folders, and nothing named otherwise');
  const { TabMemory, CLOSED_KEY } = require(path.join(root, 'src', 'tab-memory.js'));
  const ws = fake.memento({ [CLOSED_KEY]: [{ thread: ID(1), title: 'a', at: 2 }, { thread: ID(2), title: 'b', at: 1 }] });
  const memory = new TabMemory(vscode, ws);
  if (typeof memory.forget === 'function') await memory.forget([ID(1)]);
  eq(memory.recentlyClosed().map((c) => c.thread), [ID(2)], 'forget takes a conversation out of Recently closed');
  memory.dispose();

  /* ── the extension ── */
  const home = tmp('home');
  const now = Date.now();
  const spawn = (parent, nickname) => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: nickname } } });
  /* All archived, as Delete is offered only in Archived sessions; Codex archives a conversation's sub-agents with it. */
  fixture.codexHome(home, [
    { id: ID(1), title: 'First', cwd: home, turns: [{}] },
    { id: ID(2), title: 'Second', cwd: home, turns: [{}] },
    { id: ID(3), title: 'Open here', cwd: home, turns: [{}] },
    { id: ID(4), title: 'Running', cwd: home, startMs: now - 120e3, turns: [{ running: true }] },
    { id: ID(5), title: 'Parent', cwd: home, turns: [{}] },
    { id: ID(6), title: 'Scout', cwd: home, threadSource: 'subagent', source: spawn(ID(5), 'Scout'), turns: [{}] },
    { id: ID(7), title: 'Holder', cwd: home, turns: [{}] },
    { id: ID(8), title: 'Lookout', cwd: home, threadSource: 'subagent', source: spawn(ID(7), 'Lookout'), turns: [{}] },
    { id: ID(9), title: 'Late', cwd: home, turns: [{}] },
    { id: ID(10), title: 'Refused', cwd: home, turns: [{}] },
    { id: ID(11), title: 'Gone already', cwd: home, turns: [{}] },
  ].map((t) => ({ ...t, archived: true })));
  const planDir = path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras');
  fs.mkdirSync(planDir, { recursive: true });
  for (const n of [1, 2, 6, 10, 11]) fs.writeFileSync(path.join(planDir, `${ID(n)}.json`), JSON.stringify({ nodes: [] }));
  fs.writeFileSync(path.join(planDir, `${ID(1)}.wakeup`), JSON.stringify({ everyMinutes: 30, prompt: 'go on', setAt: 1, expiresAt: 2 }));
  process.env.CODEX_HOME = home;
  control.state.config = { reopenDroppedTabs: false };
  control.state.extensions.set('xnervwang.agent-plus', { isActive: true, exports: { agentPlus: { protocol: 1, accepts: [1], features: [],
    registerSource: (s) => { control.state.source = s; return { accepted: true, code: '', reason: '', registration: { dispose() {} } }; } } } });
  const ext = require(path.join(root, 'extension.js'));
  const subs = [];
  const colors = { [ID(1)]: 'red', [ID(2)]: 'green', [ID(6)]: 'blue', [ID(10)]: 'pink' };
  const globalState = fake.memento({ 'codexPlus.patchRemoved': true, 'codexPlus.titleColors': colors });
  const workspaceState = fake.memento({ 'codexPlus.recentlyClosed': [{ thread: ID(1), title: 'First', at: 2 }, { thread: ID(2), title: 'Second', at: 1 }] });
  await ext.activate({ subscriptions: subs, workspaceState, globalState, globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
  await tick(300);

  const requests = [];
  let handler = null, answer = (r) => ({ id: r.id, result: {} });
  const conn = {
    registerProvider(name, h) { handler = Object.assign({ name }, h); return { dispose() { handler = null; } }; },
    sendRequest(name, id, method, params) { const r = { name, id, method, params }; requests.push(r); setTimeout(() => handler && handler.onResult(answer(r)), 1); },
  };
  const provider = { codexMcpConnection: conn, postMessageToWebview() {}, sendMessageToPanel() {} };
  const row = (n) => ({ webviewSection: 'thread', threadId: ID(n), webview: 'codexPlus.sessions' });
  const said = () => control.state.said.map((s) => s.message);
  const dialogs = () => control.state.said.filter((s) => /from disk\?$/.test(s.message));
  const detail = (s) => String((s && s.options && s.options.detail) || '').split('\n');
  const run = async (n, selected, pick) => {
    requests.length = 0;
    control.state.said.length = 0;
    control.state.answers.length = 0;
    if (pick !== undefined) control.answer('from disk?', pick);
    const fn = control.state.handlers['codexPlus.deleteThread'];
    if (fn) await fn(row(n), selected ? selected.map(ID) : undefined);
    await tick();
    return requests.filter((r) => r.method === 'thread/delete').map((r) => r.params.threadId);
  };
  const plans = () => fs.readdirSync(planDir).sort();
  const colorsNow = () => Object.keys(globalState.get('codexPlus.titleColors') || {}).sort();
  try {
    eq(typeof control.state.handlers['codexPlus.deleteThread'], 'function', 'the command is registered');

    /* ── before the patch has handed over Codex's connection ── */
    control.state.extensions.set('openai.chatgpt', { isActive: true, packageJSON: { version: '26.1106.51428' }, extensionPath: tmp('no-codex') });
    eq([await run(1, null, 'Delete'), dialogs().length, said().some((m) => /could not tell which conversations are open, so none was deleted/.test(m))],
      [[], 0, true],
      'while Codex runs here but its pages have not connected, which conversations they show is not known, so nothing is asked or deleted');
    control.state.extensions.delete('openai.chatgpt');
    const before = plans();
    const fallback = await run(1, null, 'Delete');
    eq([fallback, dialogs().length, said().some((m) => /1 conversation could not be deleted; the output "Codex Plus" lists them/.test(m)),
      control.state.log.some((l) => /the codex program of the Codex extension was not found/.test(l)), plans()],
    [[], 1, true, true, before],
    'with Codex not started in this window no page of it is open; the request then goes to a short-lived app-server, as Rename\'s does, '
      + 'and here there is no codex program, so the user is told and nothing of Codex Plus\'s is removed');

    globalThis.__codexExtrasMessage({}, { kind: 'none' }, provider);

    /* ── cancelled ── */
    eq(await run(1, null, undefined), [], 'a confirmation closed with Esc, its close button or Cancel sends nothing');
    const asked = dialogs()[0];
    eq([asked && asked.message, asked && asked.buttons, asked && asked.options && asked.options.modal],
      ['Delete "First" from disk?', ['Delete'], true],
      'the confirmation is VS Code\'s modal warning, titled as Claude Code Plus\'s, with Delete its only button of its own');
    eq([detail(asked)[0].replace(/\(\d+(\.\d+)? (B|KB)\)/, '(n)'), detail(asked).slice(-2)],
      ['"First": the rollout, the work plan, the wake-up (n)', ['', 'This cannot be undone.']],
      'its detail says what goes of each conversation and how much, and ends as Claude Code Plus\'s does');
    eq(detail(asked).some((l) => /rollout file, its row in Codex's state database, its title and its goal/.test(l)), true,
      'and what Codex removes, as an offline app-server was seen to');
    eq([plans().includes(`${ID(1)}.json`), colorsNow().includes(ID(1))], [true, true], 'and nothing of Codex Plus\'s is removed');

    /* ── one conversation ── */
    eq(await run(1, null, 'Delete'), [ID(1)], 'confirmed, thread/delete is sent for that conversation on Codex\'s connection');
    await tick(100);
    eq([plans().filter((n) => n.startsWith(ID(1))), colorsNow(), workspaceState.get('codexPlus.recentlyClosed').map((c) => c.thread)],
      [[], [ID(10), ID(2), ID(6)].sort(), [ID(2)]],
      'its plan, wake-up and title colour go with it, and so does its row in Recently closed');
    eq(control.state.log.some((l) => l.includes(`Deleted "First" (${ID(1)})`)), true, 'and the output "Codex Plus" has a line for it');

    /* ── the selection, with some that cannot go ── */
    control.setTabs([control.codexTab(ID(3)), control.codexTab(ID(8))], 0);
    control.fireTabs();
    await tick(100);
    eq(await run(2, [2, 3, 4], 'Delete'), [ID(2)], 'Delete acts on every row chosen, and sends only those that may go');
    eq(dialogs().map((d) => [d.message, detail(d).filter((l) => /^Left alone/.test(l))]),
      [['Delete "Second" from disk?', ['Left alone, open or running: "Open here", "Running"']]],
      'the confirmation names those it leaves alone: open in this window, or running');
    eq([await run(3, [3, 4], 'Delete'), dialogs().length, said()], [[], 0, ['Not deleted: "Open here", "Running" are open or running.']],
      'with nothing chosen that may go, it only says so');

    /* ── sub-agents ── */
    eq(await run(5, null, 'Delete'), [ID(5)], 'a conversation with a sub-agent is deleted with one request, since Codex deletes its sub-agents with it');
    eq(detail(dialogs()[0])[0].replace(/\(\d+(\.\d+)? (B|KB)\)/, '(n)'), '"Parent": the rollout and 1 sub-agent conversation (n)',
      'and the confirmation says the sub-agent goes too');
    await tick(100);
    eq([plans().includes(`${ID(6)}.json`), colorsNow().includes(ID(6))], [false, false], 'its sub-agent\'s plan and colour go with it');
    eq([await run(7, null, 'Delete'), said()], [[], ['Not deleted: "Holder" (its sub-agent "Lookout") is open or running.']],
      'one whose sub-agent is open is left alone, since deleting it would delete the sub-agent');

    /* ── opened while the question was up ── */
    control.state.answers.length = 0;
    requests.length = 0;
    control.state.said.length = 0;
    control.answer('from disk?', () => { control.setTabs([control.codexTab(ID(3)), control.codexTab(ID(8)), control.codexTab(ID(9))], 0); return 'Delete'; });
    await control.state.handlers['codexPlus.deleteThread'](row(9));
    await tick();
    eq([requests.filter((r) => r.method === 'thread/delete').length, said().filter((m) => /meanwhile/.test(m))],
      [0, ['Not deleted: "Late" was opened or started meanwhile.']],
      'after Delete is pressed, open and running are looked at again, and one opened meanwhile is left alone');
    control.setTabs([control.codexTab(ID(3)), control.codexTab(ID(8))], 0);

    /* ── Codex refusing ── */
    answer = (r) => ({ id: r.id, error: { code: -32600, message: r.params.threadId === ID(11) ? `no rollout found for thread id ${ID(11)}` : 'busy' } });
    eq(await run(10, [10, 11], 'Delete'), [ID(10), ID(11)], 'two chosen are two requests');
    answer = (r) => ({ id: r.id, result: {} });
    await tick(100);
    eq([dialogs().map((d) => d.message), said().filter((m) => /could not be deleted/.test(m))],
      [['Delete 2 conversations from disk?'], ['1 conversation could not be deleted; the output "Codex Plus" lists them.']],
      'the confirmation counts them, and one Codex refused is reported, pointing at the output');
    eq([control.state.log.some((l) => l.includes(`"Refused" (${ID(10)}): busy`)), plans().includes(`${ID(10)}.json`), colorsNow().includes(ID(10))],
      [true, true, true], 'the output says why, and what Codex Plus keeps for it stays');
    eq(plans().includes(`${ID(11)}.json`), false, 'one Codex no longer has is gone already, and its plan goes as for one deleted');

    eq([await run(0, null, 'Delete'), dialogs().length, said()], [[], 0, ['Nothing of that conversation is left on disk.']],
      'one that is not on disk at all is not asked about');
    requests.length = 0;
    control.state.said.length = 0;
    await control.state.handlers['codexPlus.deleteThread']({ webviewSection: 'thread', webview: 'codexPlus.sessions' });
    await control.state.handlers['codexPlus.deleteThread']();
    eq([requests.length, control.state.said.length], [0, 0], 'and with no row named, from a key binding say, nothing is asked or deleted');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    ext.deactivate();
  }
};
