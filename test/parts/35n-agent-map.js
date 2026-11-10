// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Agent map lists a Codex conversation's wake-up, goal and sub-agents in a dialog modelled on Claude Code's Agent
 * map. This part covers the host: building the model from the snapshot, reading wake-ups along with the plan files,
 * removing a wake-up, and deciding when to send a page the map. The page is covered by
 * test/parts/61c-agent-map-page.js and by the agentmap scene in test/render/run.js.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, tmp, root }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { mapOf, NO_MAP, ACTIONS } = require('../../src/agent-map');
  const wakeup = require('../../src/wakeup');

  /* ── the model, from the snapshot ── */
  const A = ID(1), B = ID(2);
  const threads = [
    { id: A, title: 'Main', kind: 'user', parent: '', createdMs: 1, updatedMs: 50 },
    { id: ID(3), title: 'Look for the retry delay', kind: 'subagent', parent: A, nickname: 'scout', createdMs: 20, updatedMs: 40 },
    { id: ID(4), title: 'Fix the test', kind: 'subagent', parent: A, nickname: '', createdMs: 10, updatedMs: 30 },
    { id: ID(5), title: 'Gone', kind: 'subagent', parent: A, archived: true, createdMs: 5, updatedMs: 5 },
    { id: B, title: 'Other', kind: 'user', parent: '', createdMs: 2, updatedMs: 60 },
  ];
  const wakes = new Map([[A, { thread: A, everyMinutes: 10, prompt: 'Keep going.', setMs: 1000, expiresMs: 9e12, firedMs: 61000, paused: false }]]);
  const goals = new Map([[A, { status: 'paused', objective: 'Ship it', tokensUsed: 1200, tokenBudget: 50000 }]]);
  const reader = { threads: () => threads, wakeup: (id) => wakes.get(id) || null, goal: (id) => goals.get(id) || null };
  const states = { [ID(3)]: { state: 'working', lastActiveAt: 45 } };
  const m = mapOf(A, { reader, stateOf: (id) => states[id] || null });
  eq([m.type, m.shown, m.wakeups, m.goal], ['codex-extras-agent-map', true,
    [{ everyMinutes: 10, prompt: 'Keep going.', expiresMs: 9e12, paused: false, nextMs: 661000 }],
    { status: 'paused', objective: 'Ship it', tokensUsed: 1200, tokenBudget: 50000 }],
  'a conversation\'s map has its wake-up, due one interval after it last fired, and its goal with the tokens it used of its budget');
  eq(m.agents.map((a) => [a.id, a.name, a.dot, a.updatedMs]), [[ID(4), 'Fix the test', 'unknown', 30], [ID(3), 'scout', 'working', 45]],
    'and its sub-agents oldest first, each by its nickname or else its title, with the session list\'s dot (none while its rollout is unread); '
    + 'an archived one is left out');
  eq([mapOf(B, { reader }).shown, mapOf(B, { reader }).agents, mapOf('', { reader })], [false, [], NO_MAP],
    'a conversation with none of the three has nothing to show, so its page draws no button');
  wakes.set(B, { thread: B, everyMinutes: 5, prompt: 'p', setMs: 1000, expiresMs: 9e12, firedMs: 0, paused: true });
  eq([mapOf(B, { reader }).shown, mapOf(B, { reader }).wakeups[0].nextMs, mapOf(B, { reader }).wakeups[0].paused], [true, 0, true],
    'a wake-up alone is enough for the button; one paused after a stopped turn has no next time');
  goals.set(B, { status: 'complete', objective: 'Done', tokensUsed: 9, tokenBudget: 0 });
  wakes.delete(B);
  eq([mapOf(B, { reader }).shown, mapOf(B, { reader }).goal.tokenBudget], [true, 0], 'so is a goal that is not cleared, a finished one too');
  eq(ACTIONS, ['removeWakeup', 'pauseGoal', 'resumeGoal', 'clearGoal', 'setGoal', 'openAgent'], 'the dialog\'s buttons ask for one of six things');

  /* ── the wake-ups the worker reads, and Remove ── */
  const dir = tmp('plans');
  const now = Date.UTC(2026, 10, 10, 9, 0, 0);
  const wrote = (thread, every, at, extra = {}) => fs.writeFileSync(path.join(dir, `${thread}.wakeup`),
    JSON.stringify({ thread, everyMinutes: every, prompt: 'Go on.', setAt: at / 1000, expiresAt: at / 1000 + 7 * 86400, ...extra }));
  wrote(A, 5, now);
  fs.writeFileSync(path.join(dir, `${A}.woke`), JSON.stringify({ firedAt: now + 300e3 }));
  wrote(B, 5, now - 8 * 86400e3);
  eq(wakeup.planned(dir, now + 400e3).map((w) => [w.thread, w.everyMinutes, w.firedMs, w.paused]), [[A, 5, now + 300e3, false]],
    'the worker lists the wake-ups not expired, each with when its timer last queued it');
  const queue = [{ id: 'q1', clientUserMessageId: `${wakeup.ID_PREFIX}1` }, { id: 'q2', clientUserMessageId: 'typed-by-the-user' }];
  const asked = [];
  const ask = async (method, params) => {
    asked.push([method, params]);
    return method === 'thread/queue/list' ? { outcome: 'done', result: { data: queue } } : { outcome: 'done', result: {} };
  };
  const w = wakeup.createWakeups({ dir: () => dir, ask, now: () => now });
  eq(await w.remove(A), true, 'Remove takes a wake-up away');
  eq([fs.existsSync(path.join(dir, `${A}.wakeup`)), fs.existsSync(path.join(dir, `${A}.woke`)),
    asked.filter(([meth]) => meth === 'thread/queue/delete').map(([, p]) => p)], [false, false, [{ threadId: A, queuedSubmissionId: 'q1' }]],
  'its files, and what its timer queued that Codex has not sent yet, and nothing the user queued');

  /* ── the worker: wake-ups in the snapshot, and a sub-agent's state when it is asked for ── */
  const home = tmp('home');
  const P = ID(11), S = ID(12);
  fixture.codexHome(home, [{ id: P, title: 'Parent', cwd: home, turns: [{}] },
    { id: S, title: 'Child', cwd: home, threadSource: 'subagent', turns: [{}],
      source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: P, agent_nickname: 'scout' } } }) }]);
  const install = require('../../src/plugin-install');
  fs.mkdirSync(install.planDir(home), { recursive: true });
  fs.writeFileSync(path.join(install.planDir(home), `${P}.wakeup`), JSON.stringify({ thread: P, everyMinutes: 15, prompt: 'Next row.',
    setAt: Date.now() / 1000, expiresAt: Date.now() / 1000 + 86400 }));
  const { ops } = require('../../src/codex-worker');
  const plain = ops.snapshot({ home }), asking = ops.snapshot({ home, extra: [S] });
  eq(plain.wakeups.map((x) => [x.thread, x.everyMinutes, x.prompt]), [[P, 15, 'Next row.']],
    'a snapshot carries the wake-ups, read with the plan files when the stamp has moved');
  eq([(plain.threads.find((t) => t.id === S) || {}).parent, !!plain.states[P], !!plain.states[S], !!asking.states[S]], [P, true, false, true],
    'a sub-agent\'s state is read only when asked for, which the extension does for the sub-agents of the conversations open in a window');

  /* ── the poll asks for the sub-agents of what this window shows: its tabs, and the conversation in Codex's sidebar ── */
  {
    const { createCodexSource } = require('../../src/codex-source');
    const asked = [];
    const stub = { threads: () => threads, thread: (id) => threads.find((t) => t.id === id) || null, state: (id) => (id === ID(3) ? { model: 'm' } : null),
      sections: () => new Map(), hasPlan: () => false, refresh: ({ extra }) => { asked.push(extra); return Promise.resolve(false); }, ready: async () => null };
    const source = createCodexSource(vscode, { reader: stub, patching: { sidebarShowing: () => A, panelThreads: () => [] } });
    await source._poll();
    eq([(asked[0] || []).includes(ID(3)), (asked[0] || []).includes(ID(4)), !!source.threadState(ID(3)), source.threadState(ID(4))], [true, true, true, null],
      'the sub-agents of the conversation in Codex\'s sidebar are read on the next poll, and a sub-agent has a state once its rollout is read');
    source.dispose();
  }

  /* ── what a page is sent, and what its buttons do ── */
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  const posted = [];
  const provider = { postMessageToWebview: (wv, msg) => posted.push(msg) };
  let disposePanel = () => {};
  const panel = { webview: {}, active: true, reveal() {}, onDidDispose(fn) { disposePanel = fn; }, iconPath: null };
  patching.installHooks();
  globalThis.__codexExtrasPanel(panel, A, provider);
  let model = mapOf(A, { reader });
  const acted = [];
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: false, figures: false }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs')) },
    agentMap: (thread) => (thread === A ? model : null), agentMapAct: (thread, action, id) => { acted.push([thread, action, id]); } });
  const maps = () => posted.filter((x) => x.type === 'codex-extras-agent-map');
  await patching.refreshPanels();
  await patching.refreshPanels();
  eq([maps().length, maps()[0].goal.status], [1, 'paused'], 'a page is sent its conversation\'s map, and not again while nothing in it changed');
  goals.set(A, { status: 'active', objective: 'Ship it', tokensUsed: 1300, tokenBudget: 50000 });
  model = mapOf(A, { reader });
  await patching.refreshPanels();
  eq([maps().length, maps()[1].goal.status], [2, 'active'], 'a change is sent on the redraw that follows it');
  globalThis.__codexExtrasMessage(panel.webview, { type: 'codex-extras', kind: 'tz', timeZone: 'UTC' }, provider);
  eq(maps().length, 3, 'and a page that has just loaded, which says so with its time zone, is sent it again');
  for (const action of ['pauseGoal', 'removeWakeup', 'openAgent', 'deleteEverything']) {
    globalThis.__codexExtrasMessage(panel.webview, { type: 'codex-extras', kind: 'agentMap', action, id: action === 'openAgent' ? ID(3) : '' }, provider);
  }
  await new Promise((r) => setTimeout(r, 10));
  eq(acted, [[A, 'pauseGoal', ''], [A, 'removeWakeup', ''], [A, 'openAgent', ID(3)]],
    'a button of the dialog is done for the conversation the page shows, and a word not on the list is ignored');
  /* The panel registry is the module's own; later parts start from a module with none of this part's panels. */
  disposePanel();
  delete require.cache[require.resolve('../../src/patching')];
};
