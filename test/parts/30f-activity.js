// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The fields Agent Plus reads besides `state` (its docs/protocol.md, Conversations): `activity`, `unseen`, which does
 * not depend on `activity`, and `lastUserAt`. `state` stays as it was for an older core.
 */
const fake = require('../fake-vscode');

const ID = (n) => `01a2f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const { createCodexSource, conversationOf } = require('../../src/codex-source');
  const now = Date.now();
  const th = { id: ID(1), title: 'Fix the retry delay', cwd: '/w', updatedMs: now - 1000 };
  const none = { unread: new Set(), openHere: new Set(), now };
  const running = { working: true, startedMs: now - 5000, lastActivityMs: now - 1000, lastUserMs: now - 5000 };
  const ended = { working: false, startedMs: now - 60e3, endedMs: now - 30e3, lastEndedMs: now - 30e3, lastActivityMs: now - 30e3,
    lastUserMs: now - 60e3 };
  const pick = (c) => [c.activity, c.unseen, c.state];

  /* ── the four activities ── */
  eq(pick(conversationOf(th, { ...none, state: running })), ['working', false, 'working'], 'a turn running is working');
  eq(pick(conversationOf(th, { ...none, state: ended, left: ['command'] })), ['background', false, 'working'],
    'a turn over with a background command still running is background, while `state` still says working for an older core');
  eq(pick(conversationOf(th, { ...none, state: ended, left: ['subagent', 'detached'] })), ['background', false, 'working'],
    'and so with a sub-agent or a detached command');
  eq(pick(conversationOf(th, { ...none, state: running, waiting: { decide: 1, soon: 0 } })), ['waiting', false, 'prompt'],
    'a turn stopped on an approval or a choice is waiting');
  eq(pick(conversationOf(th, { ...none, state: { ...ended, askedMs: now - 31e3 } })), ['waiting', false, 'prompt'],
    'a turn that ended on a question asked with request_user_input_async is waiting');
  eq(pick(conversationOf(th, { ...none, state: ended, left: ['command'], waiting: { decide: 0, soon: 1 } })), ['waiting', false, 'prompt'],
    'waiting wins over background work');
  eq(pick(conversationOf(th, { ...none, state: ended })), ['stopped', false, 'idle'], 'a turn over with nothing left running is stopped');
  eq(pick(conversationOf(th, { ...none, state: null })), ['stopped', false, 'idle'], 'and so is a conversation whose rollout was not read');
  eq(pick(conversationOf({ ...th, updatedMs: now - 5 * 3600e3 }, { ...none, state: { ...running, lastActivityMs: now - 5 * 3600e3 } })),
    ['stopped', false, 'idle'], 'a turn silent for hours is stopped, not working');

  /* ── an unread reply, whatever the activity ── */
  const unread = { ...none, unread: new Set([th.id]) };
  eq(pick(conversationOf(th, { ...unread, state: ended })), ['stopped', true, 'unread'], 'stopped with a reply not seen');
  eq(pick(conversationOf(th, { ...unread, state: running })), ['working', true, 'working'],
    'a reply not seen is still reported while a later turn runs, which `state` cannot say');
  eq(pick(conversationOf(th, { ...unread, state: ended, left: ['command'] })), ['background', true, 'working'],
    'and while only background work runs');
  eq(pick(conversationOf(th, { ...unread, state: running, waiting: { decide: 1, soon: 0 } })), ['waiting', true, 'prompt'], 'and while it waits for the user');

  /* ── when the user last typed ── */
  eq([conversationOf(th, { ...none, state: ended }).lastUserAt, conversationOf(th, { ...none, state: null }).lastUserAt], [now - 60e3, 0],
    'lastUserAt is the rollout\'s last message the user typed, 0 when that is not known');

  /* ── through the source ── */
  const A = ID(2), B = ID(3), C = ID(4);
  const T = now - 120e3;
  const threads = [A, B, C].map((id, i) => ({ id, title: `Conversation ${i + 1}`, kind: 'user', cwd: '/w', updatedMs: now - 1000, createdMs: T - 60e3 }));
  /* A: its first turn ended at T, and a second one is running. B: its turn ended at T with a background command left.
     C: its turn ended at T, nothing left. */
  const states = {
    [A]: { working: true, turnId: 'a2', startedMs: now - 3000, endedMs: 0, lastEndedMs: T, lastActivityMs: now - 1000, lastUserMs: T - 30e3 },
    [B]: { working: false, turnId: 'b1', startedMs: T - 30e3, endedMs: T, lastEndedMs: T, lastActivityMs: T, lastUserMs: T - 30e3 },
    [C]: { working: false, turnId: 'c1', startedMs: T - 30e3, endedMs: T, lastEndedMs: T, lastActivityMs: T, lastUserMs: T - 30e3 },
  };
  const reader = { threads: () => threads, thread: (id) => threads.find((t) => t.id === id) || null, state: (id) => states[id] || null,
    hasPlan: () => false, sections: () => new Map(), refresh: async () => false, ready: async () => ({ threads, readable: true }),
    request: async () => null };
  const patching = { runningCommands: (id) => (id === B ? [{ thread: B, command: 'sleep 60', startedMs: T }] : []) };
  const { createSeen, SINCE_KEY } = require('../../src/seen');
  const seenState = fake.memento();
  await seenState.update(SINCE_KEY, 1);
  const source = createCodexSource(vscode, { reader, patching, seen: createSeen(seenState) });
  try {
    control.setTabs([control.fileTab('/w/notes.txt')], 0);
    source._tabsChanged();
    const by = async () => new Map((await source.listConversations()).map((c) => [c.sessionId, c]));
    let list = await by();
    eq([A, B, C].map((id) => pick(list.get(id))), [['working', true, 'working'], ['background', true, 'working'], ['stopped', true, 'unread']],
      'a reply that ended while the user was elsewhere is not seen: with another turn running, with only background work left '
      + '(the conversation\'s panel not in front), and stopped');
    eq([A, B, C].map((id) => list.get(id).lastUserAt), [T - 30e3, T - 30e3, T - 30e3], 'each with when the user last typed');
    vscode.window.state = { focused: false };
    control.setTabs([control.codexTab(B)], 0);
    source._tabsChanged();
    list = await by();
    eq(pick(list.get(B)), ['background', true, 'working'], 'its tab in front of a window without the focus does not count as seeing it');
    vscode.window.state = { focused: true };
    control.setTabs([control.codexTab(A)], 0);
    source._tabsChanged();
    await tick();
    list = await by();
    eq(pick(list.get(A)), ['working', false, 'working'], 'brought to the front while a turn runs, the earlier reply counts as seen');
    control.setTabs([control.codexTab(B)], 0);
    source._tabsChanged();
    list = await by();
    eq(pick(list.get(B)), ['background', false, 'working'], 'and so with background work running');
    const sub = source.threadState(C);
    eq([sub.activity, sub.unseen, sub.lastUserAt], ['stopped', false, T - 30e3], 'threadState carries the same fields, for the Agent map');
  } finally {
    delete vscode.window.state;
    source.dispose();
  }

  /* ── approval requests, which leave nothing on disk ── */
  const asked = new Set();
  const onApprovals = new Set();
  const withApprovals = { runningCommands: () => [], approvalsOf: (id) => ({ decide: asked.has(id) ? 1 : 0, soon: 0 }),
    onApprovalsChanged: (fn) => { onApprovals.add(fn); return { dispose: () => onApprovals.delete(fn) }; } };
  const told = createCodexSource(vscode, { reader, patching: withApprovals, seen: createSeen(seenState) });
  try {
    let heard = 0;
    told.onDidChangeConversations(() => { heard++; });
    await tick();
    heard = 0;
    asked.add(A);
    for (const fn of [...onApprovals]) fn();
    eq([heard > 0, (await told.listConversations()).find((c) => c.sessionId === A).activity], [true, 'waiting'],
      'an approval request the patch reports tells the views at once, so the session list draws the red dot with the tab');
  } finally { told.dispose(); }
  eq(onApprovals.size, 0, 'and the source stops listening once disposed');
};
