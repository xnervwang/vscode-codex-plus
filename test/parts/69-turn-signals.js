// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Turn starts and ends reported by the app-server, before the rollout shows them: the Conversations state, the tab's
 * dot and the finished-turn chime follow turn/started and turn/completed at once instead of waiting for the next read
 * of the rollout. The stand-in reader here never changes its answer, so any change comes from the notification alone.
 */
const fake = require('../fake-vscode');

const THREAD = '019a1b8f-2fd2-7e60-9ffc-16e5cb642e31';
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  const { createCodexSource, conversationOf } = require('../../src/codex-source');

  /* ── the rule itself ── */
  const thread = { id: THREAD, title: 't', updatedMs: Date.now() - 60e3 };
  const was = Date.now() - 30e3;
  const base = { unread: new Set(), openHere: new Set() };
  eq(conversationOf(thread, { ...base, state: { working: false, endedMs: was - 5e3, lastActivityMs: was - 5e3 }, heard: { running: true, startedMs: was, endedMs: 0 } }).state,
    'working', 'a turn the app-server said started counts as running before its rollout says so');
  eq(conversationOf(thread, { ...base, state: { working: true, startedMs: was, lastActivityMs: was }, heard: { running: false, startedMs: 0, endedMs: was + 1000 } }).working,
    false, 'and one it said ended stops counting, whatever the rollout read before that still says');
  eq(conversationOf(thread, { ...base, state: { working: true, startedMs: was + 2000, lastActivityMs: was + 2000 }, heard: { running: false, startedMs: 0, endedMs: was + 1000 } }).working,
    true, 'but a turn the rollout shows starting after that end is a new one, and runs');

  /* ── the source and the patch together, with a rollout that never moves ── */
  const state = { working: false, endedMs: was - 5e3, lastActivityMs: was - 5e3, startedMs: was - 9e3 };
  const snap = { threads: [{ id: THREAD, title: 'A conversation', kind: 'user', updatedMs: was - 5e3, cwd: '/w' }], readable: true };
  let reads = 0;
  const reader = { busy: null, refresh: async () => { reads++; return false; }, ready: async () => snap, state: (id) => (id === THREAD ? state : null),
    thread: (id) => snap.threads.find((t) => t.id === id) || null, threads: () => snap.threads, hasPlan: () => false };
  const source = createCodexSource(vscode, { reader, patching });
  const sent = [];
  const settings = () => ({ patchCodex: 'off', enabled: true, chime: true, figures: false, contextMeter: false, timestamps: false,
    conversationNavigation: false, userMessageEdge: false, lowContextOutline: false });
  const context = { subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() };
  try {
    patching.activate(context, { vscode, log: () => {}, settings, source, context });
    const provider = { postMessageToWebview: (w, m) => sent.push(m), sendMessageToPanel() {} };
    const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
    globalThis.__codexExtrasPanel(panel, THREAD, provider);
    await patching.refreshPanels();
    const stateNow = async () => (await source.listConversations()).find((c) => c.sessionId === THREAD).state;
    eq(await stateNow(), 'idle', 'to begin with the conversation is idle');

    let changes = 0;
    const sub = source.onDidChangeConversations(() => { changes++; });
    const readsBefore = reads;
    globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: THREAD, turn: { id: 't1' } } });
    await tick();
    eq([await stateNow(), changes > 0, reads > readsBefore], ['working', true, true],
      'turn/started makes it working at once: the views are told, and the rollout is read for what else moved');
    const chimesBefore = sent.filter((m) => m.type === 'codex-extras-chime').length;
    globalThis.__codexExtrasAppServer('notification', { method: 'turn/completed', params: { threadId: THREAD, turn: { id: 't1' } } });
    await tick(40);
    const chimes = sent.filter((m) => m.type === 'codex-extras-chime').slice(chimesBefore);
    eq([await stateNow(), chimes.map((m) => m.kind)], ['unread', ['done']],
      'turn/completed ends it at once: replied and not read, with the finished-turn chime, still with no new line in the rollout');
    sub.dispose();
  } finally {
    source.dispose();
    for (const d of context.subscriptions) { try { d.dispose(); } catch (_) { /* gone */ } }
    patching._approvals.clear();
  }
};
