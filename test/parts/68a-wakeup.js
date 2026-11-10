// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Wake-ups: set_wakeup writes <thread>.wakeup in the plugin's data folder, and each window's timer (src/wakeup.js)
 * queues the prompt for that conversation when it is due; Codex sends it once the conversation is idle. Only
 * conversations loaded in this window's app-server are woken, through hostRequest and never through a separate
 * app-server: a message queued for a conversation nobody has open would be sent whenever it is next opened.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const A = '01a1b8e8-f7e2-7251-95a9-a95b65992841';
const B = '01a1b8e8-f7e2-7251-95a9-a95b65992842';

function python() {
  for (const exe of ['python3', 'python']) {
    const r = cp.spawnSync(exe, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 7))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return exe;
  }
  return null;
}

module.exports = async ({ eq, note, tmp, root }) => {
  const wakeup = require(path.join(root, 'src', 'wakeup.js'));
  const dir = tmp('wake-data');
  let now = Date.UTC(2026, 10, 10, 9, 0, 0);
  const asked = [];
  const answers = { loaded: [A], queue: { [A]: [], [B]: [] }, available: true };
  const ask = async (method, params) => {
    asked.push([method, params]);
    if (!answers.available) return { outcome: 'unavailable', reason: 'not handed over' };
    if (method === 'thread/loaded/list') return { outcome: 'done', result: { data: answers.loaded } };
    if (method === 'thread/queue/list') return { outcome: 'done', result: { data: answers.queue[params.threadId] || [] } };
    if (method === 'thread/queue/add') {
      const item = { id: `q${asked.length}`, clientUserMessageId: params.clientUserMessageId, input: params.input };
      (answers.queue[params.threadId] = answers.queue[params.threadId] || []).push(item);
      return { outcome: 'done', result: { queuedSubmission: item } };
    }
    if (method === 'thread/queue/delete') {
      answers.queue[params.threadId] = (answers.queue[params.threadId] || []).filter((q) => q.id !== params.queuedSubmissionId);
      return { outcome: 'done', result: { deleted: true } };
    }
    return { outcome: 'failed', reason: 'unknown' };
  };
  const w = wakeup.createWakeups({ dir: () => dir, ask, now: () => now });
  const set = (thread, every, prompt, at = now) => fs.writeFileSync(path.join(dir, `${thread}.wakeup`),
    JSON.stringify({ thread, everyMinutes: every, prompt, setAt: at / 1000, expiresAt: at / 1000 + 7 * 86400 }));
  const methods = () => asked.map((a) => a[0]);
  const adds = () => asked.filter((a) => a[0] === 'thread/queue/add');

  await w.tick();
  eq(asked, [], 'with no wake-up set, a tick asks the app-server nothing');

  set(A, 5, 'Keep going with the open rows.');
  set(B, 5, 'Something for another window.');
  await w.tick();
  eq(methods(), ['thread/loaded/list'], 'before its first interval, nothing is queued');
  now += 5 * 60e3;
  asked.length = 0;
  await w.tick();
  eq(methods(), ['thread/loaded/list', 'thread/queue/list', 'thread/queue/add'],
    'once due, the conversation this window has loaded is checked for a wake-up still queued, then given one');
  const text = adds()[0][1].input[0].text;
  eq([adds()[0][1].threadId, text.startsWith(wakeup.PREFIX), text.endsWith('Keep going with the open rows.')], [A, true, true],
    'to that conversation, with the line saying it comes from the timer and not from the user');
  eq(/^codex-plus-wakeup-/.test(adds()[0][1].clientUserMessageId), true, 'marked as this extension\'s by its client message id');
  eq(asked.some((a) => a[1] && a[1].threadId === B), false, 'a conversation not loaded in this window is left to its own window');

  asked.length = 0;
  now += 60e3;
  await w.tick();
  eq(adds().length, 0, 'not again before the next interval');
  now += 5 * 60e3;
  asked.length = 0;
  await w.tick();
  eq(adds().length, 0, 'nor while its last wake-up is still in the queue, not yet sent');
  answers.queue[A] = [{ id: 'mine', clientUserMessageId: 'from-the-user', input: [] }];
  asked.length = 0;
  await w.tick();
  eq(adds().length, 1, 'a message the user queued is not one of its own, so it queues its next one');

  /* Stopped by the user: paused until they speak, and its queued message taken back. */
  answers.queue[A] = [{ id: 'q-own', clientUserMessageId: 'codex-plus-wakeup-1', input: [] }];
  await w.heard('turn/completed', { threadId: A, turn: { id: 't', status: 'interrupted' } });
  eq(answers.queue[A].map((q) => q.id), [], 'when the user stops a turn, its queued wake-up is taken out of the queue');
  now += 10 * 60e3;
  asked.length = 0;
  await w.tick();
  eq(adds().length, 0, 'and it stays quiet after that');
  await w.heard('turn/started', { threadId: A, turn: { id: 't2' } });
  now += 5 * 60e3;
  asked.length = 0;
  await w.tick();
  eq(adds().length, 1, 'until a turn starts again');

  /* Gone after seven days. */
  set(A, 5, 'old', now - 8 * 86400e3);
  asked.length = 0;
  await w.tick();
  eq([adds().length, fs.existsSync(path.join(dir, `${A}.wakeup`))], [0, false], 'a wake-up past its seven days is removed, not sent');

  /* Never through a short-lived app-server. */
  set(A, 5, 'again', now - 10 * 60e3);
  answers.available = false;
  asked.length = 0;
  await w.tick();
  eq(methods(), ['thread/loaded/list'], 'before Codex hands over its connection, nothing more is asked');

  /* Two windows due at the same moment queue one. */
  answers.available = true;
  answers.queue[A] = [];
  const w2 = wakeup.createWakeups({ dir: () => dir, ask, now: () => now });
  now += 5 * 60e3;
  asked.length = 0;
  await Promise.all([w.tick(), w2.tick()]);
  eq(adds().length, 1, 'two windows that find it due at once queue it once');

  eq(wakeup.listed(dir, now).map((x) => [x.thread, x.everyMinutes]), [[A, 5], [B, 5]], 'the wake-ups set are listed for Show Status');

  /* A conversation that is gone takes its wake-up with it, as it takes its plan. */
  const { sweepOrphans, SETTLED_MS } = require(path.join(root, 'src', 'workplan.js'));
  const aged = (Date.now() - SETTLED_MS - 60e3) / 1000;
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), aged, aged);
  sweepOrphans({ dir, live: new Set([A]), home: tmp('wake-sweep-home') });
  eq(fs.readdirSync(dir).filter((f) => !f.includes('.lock')).sort(), [`${A}.wakeup`, `${A}.woke`],
    'the sweep removes the wake-up of a conversation that is gone and keeps the live one\'s');

  /* In the extension: what the app-server tells Codex reaches the wake-ups. */
  {
    const { vscode, control } = fake.create();
    fake.install(vscode);
    for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
    const home = tmp('wake-ext-home');
    fixture.codexHome(home, [{ title: 'One', cwd: home, turns: [{}] }]);
    process.env.CODEX_HOME = home;
    control.state.config = { reopenDroppedTabs: false };
    const ext = require(path.join(root, 'extension.js'));
    const install = require(path.join(root, 'src', 'plugin-install.js'));
    const subs = [];
    await ext.activate({ subscriptions: subs, workspaceState: fake.memento(), globalState: fake.memento({ 'codexPlus.patchRemoved': true }),
      globalStorageUri: vscode.Uri.file(tmp('gs')), extensionPath: root });
    try {
      const plans = install.planDir(home);
      fs.mkdirSync(plans, { recursive: true });
      fs.writeFileSync(path.join(plans, `${A}.wakeup`), JSON.stringify({ thread: A, everyMinutes: 5, prompt: 'p', setAt: Date.now() / 1000,
        expiresAt: Date.now() / 1000 + 86400 }));
      globalThis.__codexExtrasAppServer('notification', { method: 'turn/completed', params: { threadId: A, turn: { status: 'interrupted' } } });
      await new Promise((r) => setTimeout(r, 50));
      const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(plans, `${A}.woke`), 'utf8')); } catch (_) { return {}; } })();
      eq(!!st.pausedAt, true, 'a turn the user stops, heard through the patch, pauses its conversation\'s wake-up');
    } finally {
      for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
      ext.deactivate();
    }
  }

  /* The MCP tools that set and clear one. */
  const py = python();
  if (!py) { note('no Python 3.7+ here: the wake-up tools were not run'); return; }
  const home = tmp('wake-home');
  const data = path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras');
  const call = (args, name) => {
    const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }];
    const r = cp.spawnSync(py, [path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks', 'plan-mcp.py')],
      { input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CODEX_HOME: home } });
    const replies = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { tools: replies[1].result.tools, result: replies[2].result };
  };
  const first = call({ thread: A, prompt: 'Wake-up for the open rows of the work plan.' }, 'set_wakeup');
  const tool = (n) => first.tools.find((t) => t.name === n) || {};
  eq([!!tool('set_wakeup').name, !!tool('clear_wakeup').name], [true, true], 'the work plan\'s MCP server offers set_wakeup and clear_wakeup');
  eq(/7 days/.test(tool('set_wakeup').description) && /clear_wakeup/.test(tool('set_wakeup').description), true,
    'set_wakeup says it expires after 7 days and that clear_wakeup removes it');
  eq(first.result.isError, false, 'set_wakeup sets one');
  const saved = JSON.parse(fs.readFileSync(path.join(data, `${A}.wakeup`), 'utf8'));
  eq([saved.thread, saved.everyMinutes, saved.prompt, Math.round(saved.expiresAt - saved.setAt)],
    [A, 5, 'Wake-up for the open rows of the work plan.', 7 * 86400], 'every 5 minutes unless told otherwise, for 7 days');
  eq(call({ thread: A, prompt: 'x', every_minutes: 30 }, 'set_wakeup').result.isError, false, 'setting it again replaces it');
  eq(JSON.parse(fs.readFileSync(path.join(data, `${A}.wakeup`), 'utf8')).everyMinutes, 30, 'with the new interval');
  for (const bad of [{ thread: '../x', prompt: 'p' }, { thread: A, prompt: '' }, { thread: A, prompt: 'p', every_minutes: 0 },
    { thread: A, prompt: 'p', every_minutes: 99999 }, { thread: A, prompt: 'p', every_minutes: 'often' }]) {
    eq(call(bad, 'set_wakeup').result.isError, true, `set_wakeup refuses ${JSON.stringify(bad)}`);
  }
  eq(call({ thread: A }, 'clear_wakeup').result.isError, false, 'clear_wakeup removes it');
  eq(fs.existsSync(path.join(data, `${A}.wakeup`)), false, 'and the file is gone');
  eq(/no wake-up/i.test(call({ thread: A }, 'clear_wakeup').result.content[0].text), true, 'clearing one that is not set says so');
};
