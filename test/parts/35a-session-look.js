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
  const { SessionsModel } = require('../../src/sessions-view');
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'page', 'sessions-page.css'), 'utf8');
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
  const provider = new SessionsModel(vscode, { memory, memento: fake.memento(), reader,
    stateOf: (id) => ({ state: states[Number(id.slice(-12))], failed: id === ID(6) }),
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  const rows = provider.model().groups.flatMap((g) => g.rows);
  const dot = (n) => rows.find((r) => r.id === ID(n)).dot;
  eq([dot(1), dot(3), dot(5), dot(4), dot(2), dot(6)], ['working', 'prompt', 'unread', 'idle', 'workingElsewhere', 'failed'],
    'running, waiting for you, replied and unread, idle, running in another window, and a failed last turn');
  /* What the page draws for each, as the stylesheet says. */
  const rule = (k) => { const m = new RegExp(`\\.cp-dot\\.d-${k}\\b[^{]*\\{([^}]*)\\}`).exec(css) || new RegExp(`\\.d-${k}\\b[^{]*\\{([^}]*)\\}`).exec(css); return m ? m[1].trim() : ''; };
  eq([rule('working'), rule('prompt'), rule('unread'), rule('workingElsewhere')],
    ['background: var(--vscode-charts-green);', 'background: var(--vscode-charts-blue);', 'background: var(--vscode-charts-red);', 'border: 2px solid var(--vscode-charts-green);'],
    'green running, blue waiting for you, red unread, and a ring of the same green for one running in another window, in the theme\'s colours');
  eq([/\.cp-dot\s*\{[^}]*width: 8px; height: 8px; border-radius: 50%/.test(css), /\.d-idle\s*\{[^}]*opacity: \.4/.test(css)], [true, true],
    'an 8 px dot, as Claude Code draws it, and idle a grey one at 40%');
};
