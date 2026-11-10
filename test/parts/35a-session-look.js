// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The status dot on a row of the Codex session list, which should match Claude Code's list: green running, blue
 * waiting for you, red replied and unread, grey idle, red for a failed last turn, and a ring in the same colour for a
 * conversation running in another window.
 */
const fake = require('../fake-vscode');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const { SessionsProvider } = require('../../src/sessions-view');
  const { conversationOf } = require('../../src/codex-source');

  /* ── a failed last turn is carried with the conversation ── */
  const base = { unread: new Set(), openHere: new Set() };
  const th = { id: ID(1), title: 't', updatedMs: Date.now() };
  eq([conversationOf(th, { ...base, state: { working: false, error: 'stream disconnected', lastActivityMs: Date.now() } }).failed,
    conversationOf(th, { ...base, state: { working: false, error: '', lastActivityMs: Date.now() } }).failed],
  [true, false], 'a conversation whose last turn ended in an error is marked failed, and one that did not is not');

  /* ── the dot ── */
  const states = { 1: 'working', 2: 'working', 3: 'prompt', 4: 'idle', 5: 'unread', 6: 'idle' };
  const threads = Object.keys(states).map((n) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', updatedMs: Date.now() - 60e3, createdMs: Date.now() - 120e3 }));
  const reader = { threads: () => threads, sections: () => new Map(), state: () => ({ working: false }), thread: (id) => threads.find((t) => t.id === id) || null };
  const memory = { openThreads: () => [ID(1), ID(3)], recentlyClosed: () => [], frontAt: () => 0 };
  const provider = new SessionsProvider(vscode, { memory, memento: fake.memento(), reader,
    stateOf: (id) => ({ state: states[Number(id.slice(-12))], failed: id === ID(6) }),
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  provider.refresh();
  const rows = provider.getChildren().flatMap((g) => provider.getChildren(g)).filter((r) => r.kind === 'thread' && r.group !== 'open');
  const look = (n) => { const it = provider.getTreeItem(rows.find((r) => r.thread.id === ID(n))); return [it.iconPath.id, it.iconPath.color.id]; };
  eq([look(1), look(3), look(5), look(4)],
    [['circle-filled', 'charts.green'], ['circle-filled', 'charts.blue'], ['circle-filled', 'charts.red'], ['circle-filled', 'disabledForeground']],
    'running green, waiting for you blue, replied and unread red, and idle a grey dot rather than a ring');
  eq(look(2), ['circle-outline', 'charts.green'], 'running with no tab of it in this window, that is in another window, is a ring of the same green');
  const failed = provider.getTreeItem(rows.find((r) => r.thread.id === ID(6)));
  eq([failed.iconPath.id, failed.iconPath.color.id, failed.tooltip.value.includes('last turn failed')], ['circle-filled', 'charts.red', true],
    'a conversation whose last turn failed is red, and says so on hover');

};
