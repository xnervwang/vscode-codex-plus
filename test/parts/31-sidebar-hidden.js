// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's sidebar hidden while the user stays on the same tab. The conversation the sidebar last followed is in front
 * only while one of its views is visible (src/patching.js sidebarShowing); a reply that ends after the sidebar was put
 * away has not been looked at, and the work plan view is not to be held on that conversation either.
 *
 * The patch stands in with the two answers the real one gives: sidebarThread(), the conversation the sidebar last went
 * to, which is never cleared, and sidebarShowing(), that conversation while a sidebar view is visible and '' otherwise.
 * The reader stands in with one conversation whose last turn ends when the test says.
 */
const fake = require('../fake-vscode');

const A = '01a1d0d0-0000-7000-8000-0000000000d1';
const OTHER = '01a1d0d0-0000-7000-8000-0000000000d2';

module.exports = async ({ eq }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const { createCodexSource } = require('../../src/codex-source');
  const { createSeen, SINCE_KEY } = require('../../src/seen');

  let sidebar = '', visible = false;
  const patching = { sidebarThread: () => sidebar, sidebarShowing: () => (visible ? sidebar : ''), canDeliver: () => false };
  let endedMs = Date.now() - 60000;
  const rows = [{ id: A, kind: 'user', title: 'In the sidebar', cwd: '/w', updatedMs: Date.now() },
    { id: OTHER, kind: 'user', title: 'In a tab', cwd: '/w', updatedMs: Date.now() }];
  const reader = { threads: () => rows, thread: (id) => rows.find((r) => r.id === id) || null, present: () => true,
    state: (id) => (id === A ? { working: false, endedMs, lastActivityMs: endedMs } : { working: false, endedMs: 1, lastActivityMs: 1 }),
    unread: () => new Map(), hasPlan: () => false, sections: () => new Map(), refresh: async () => false,
    ready: async () => ({ threads: rows, readable: true }) };
  const memo = fake.memento();
  await memo.update(SINCE_KEY, 1);
  control.setTabs([control.codexTab(OTHER)], 0);
  const source = createCodexSource(vscode, { reader, patching, seen: createSeen(memo) });
  const stateOf = async () => (await source.listConversations()).find((c) => c.sessionId === A).state;
  try {
    /* The sidebar is shown and goes to the conversation: it is in front, so what it has is read. */
    sidebar = A; visible = true;
    source._focus(A);
    eq([await stateOf(), source.isFocused(A)], ['idle', true], 'with the sidebar showing it, the sidebar\'s conversation is in front and read');

    /* The sidebar is put away; the tab in front stays the same. */
    visible = false;
    await new Promise((r) => setTimeout(r, 30));
    endedMs = Date.now() - 10;
    eq([await stateOf(), source.isFocused(A)], ['unread', false],
      'once the sidebar is hidden, a reply that ends there stays unread and the conversation no longer counts as in front');

    visible = true;
    eq([await stateOf(), source.isFocused(A)], ['idle', true], 'and shown again, it is in front and read');
  } finally { source.dispose(); }
};
