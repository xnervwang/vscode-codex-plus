// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The status dot on a row of the Codex session list follows the conversation's activity alone. Being open here or in
 * another window, or a failed last turn, does not change it.
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
  const convs = { 1: { activity: 'working' }, 2: { activity: 'working', state: 'working' }, 3: { activity: 'waiting', state: 'prompt' },
    4: { activity: 'stopped', state: 'idle' }, 5: { activity: 'stopped', state: 'unread', unseen: true }, 6: { activity: 'stopped', state: 'idle', failed: true },
    7: { activity: 'background', state: 'working', left: ['command'] } };
  const threads = Object.keys(convs).map((n) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', updatedMs: Date.now() - 60e3, createdMs: Date.now() - 120e3 }));
  const reader = { threads: () => threads, sections: () => new Map(), state: () => ({ working: false }), thread: (id) => threads.find((t) => t.id === id) || null };
  const memory = { openThreads: () => [ID(1), ID(3), ID(4)], recentlyClosed: () => [], frontAt: () => 0 };
  const provider = new SessionsModel(vscode, { memory, memento: fake.memento(), reader,
    stateOf: (id) => convs[Number(id.slice(-12))],
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  const rows = provider.model().groups.flatMap((g) => g.rows);
  const dot = (n) => rows.find((r) => r.id === ID(n)).dot;
  eq([dot(1), dot(2), dot(3), dot(7), dot(4), dot(5), dot(6)], ['working', 'working', 'waiting', 'background', 'none', 'none', 'none'],
    'running here or in another window, waiting for you, only background work left, and none for one stopped, open here or not, '
    + 'with a reply not seen (its envelope says so) or after a failed turn');
  /* What the page draws for each, as the stylesheet says. */
  const rule = (k) => { const m = new RegExp(`\\.cp-dot\\.d-${k}\\b[^{]*\\{([^}]*)\\}`).exec(css); return m ? m[1].trim() : ''; };
  eq([rule('working'), rule('background'), rule('waiting')], ['background: #22c55e;', 'border: 2px solid #22c55e;', 'background: #ef4444;'],
    'green running, a ring of the same green for background work, red waiting for you, in Claude Code Plus\'s colours');
  eq([/\.cp-dot\s*\{[^}]*width: 8px; height: 8px; border-radius: 50%/.test(css), /\.cp-dot\.d-none, \.cp-dot\.d-unknown \{ display: none; \}/.test(css)], [true, true],
    'an 8 px dot, as Claude Code draws it, and nothing at all for none');
};
