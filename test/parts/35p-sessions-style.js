// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's look held to Claude Code Plus's, where both extensions have the same thing: the status dots, the
 * hover box, the search box and its highlight, the status filter's menu, the icons, ACCOUNT, the rename button, the
 * section lines, the chat font, the editing outlines and the drag image. Each value is the one Claude Code's own
 * stylesheet or Claude Code Plus's page script uses; the render check's sessions scene checks the same in a browser.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { runSessionsPage } = require('../sessions-page-run');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n, extra = {}) => ({ id: ID(n), title: `Conversation ${n}`, time: `${n}d · 11/0${n % 9}`, dot: 'idle', color: '', open: false,
  sidebar: false, unread: false, grouped: false, group: 'Ungrouped', branch: '', ...extra });

module.exports = async ({ eq, root }) => {
  const css = fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.css'), 'utf8');
  /* The declarations of the first rule whose selector list includes `sel` exactly. */
  const rule = (sel) => {
    const re = /([^{}]+)\{([^}]*)\}/g;
    for (let m; (m = re.exec(css));) {
      const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
      if (sels.includes(sel)) return m[2].replace(/\s+/g, ' ').trim();
    }
    return '';
  };
  const has = (sel, decl) => rule(sel).split(';').map((d) => d.trim()).includes(decl);

  /* ── the dots: Claude Code Plus's hexadecimal colours, failed in the theme's error colour ── */
  eq([has('.cp-dot.d-working', 'background: #22c55e'), has('.cp-dot.d-workingElsewhere', 'border: 2px solid #22c55e'),
    has('.cp-dot.d-prompt', 'background: #3b82f6'), has('.cp-dot.d-promptElsewhere', 'border: 2px solid #3b82f6'),
    has('.cp-dot.d-unread', 'background: #ef4444'), has('.cp-dot.d-failed', 'background: var(--vscode-errorForeground)')],
  [true, true, true, true, true, true],
  'the dots are green #22c55e running, blue #3b82f6 waiting, red #ef4444 unread, as on Claude Code Plus\'s list and this extension\'s tabs, and failed in errorForeground as Claude Code draws it');
  eq([has('.cp-dot.d-none', 'display: none'), has('.cp-dot.d-unknown', 'display: none')], [true, true],
    'a row with no dot takes no room for one, so its title starts where the dot would have been');

  /* ── which rows have a dot: Claude Code draws one only for a conversation that is open, running, waiting or unread ── */
  {
    const { vscode } = fake.create();
    fake.install(vscode);
    const { SessionsModel } = require('../../src/sessions-view');
    const states = { 1: 'idle', 2: 'idle', 3: 'working', 4: 'unread', 5: 'idle' };
    const threads = Object.keys(states).map((n) => ({ id: ID(n), title: `t${n}`, kind: 'user', cwd: '/w', updatedMs: Date.now() - 60e3, createdMs: Date.now() - 120e3 }));
    const reader = { threads: () => threads, sections: () => new Map(), state: (id) => (id === ID(5) ? null : { working: false }), thread: (id) => threads.find((t) => t.id === id) || null };
    const memory = { openThreads: () => [ID(1)], recentlyClosed: () => [], frontAt: () => 0 };
    const model = new SessionsModel(vscode, { memory, memento: fake.memento(), reader,
      stateOf: (id) => ({ state: states[Number(id.slice(-12))], failed: false }),
      settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) }).model();
    const dot = (n) => model.groups.flatMap((g) => g.rows).find((r) => r.id === ID(n)).dot;
    eq([dot(1), dot(2), dot(3), dot(4), dot(5)], ['idle', 'none', 'workingElsewhere', 'unread', 'unknown'],
      'an idle conversation open in this window keeps its grey dot; one that is not open has none, while running, unread and not-yet-read rows keep theirs');
  }
};
