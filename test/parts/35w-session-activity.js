// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A session list row shows the conversation's activity as its dot and an unread reply as an envelope between the title
 * and the time. The envelope is its own element, so cutting a long title never hides it, and a light theme gets its
 * text form (src/envelope.js, from Agent Plus).
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { runSessionsPage } = require('../sessions-page-run');

const ID = (n) => `01a2f2f2-0000-7000-8000-${String(n).padStart(12, '0')}`;
const COLOUR = '✉️', TEXT = '✉︎';

module.exports = async ({ eq, root }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const { SessionsModel } = require('../../src/sessions-view');

  /* ── the host's model ── */
  const convs = {
    1: { activity: 'working', unseen: false, state: 'working', working: true },
    2: { activity: 'background', unseen: true, state: 'working', working: false, left: ['command'] },
    3: { activity: 'waiting', unseen: false, state: 'prompt', working: true, decide: 1 },
    4: { activity: 'stopped', unseen: true, state: 'unread', working: false },
    5: { activity: 'stopped', unseen: false, state: 'idle', working: false },
    6: { activity: 'working', unseen: true, state: 'working', working: true },
  };
  const threads = Object.keys(convs).map((n) => ({ id: ID(n), title: n === '4' ? 'Plan ✉️ the release' : `Conversation ${n}`, kind: 'user',
    cwd: '/w', updatedMs: Date.now() - 60e3, createdMs: Date.now() - 120e3 }));
  threads.push({ id: ID(7), title: 'Not read yet', kind: 'user', cwd: '/w', updatedMs: Date.now() - 60e3, createdMs: Date.now() - 120e3 });
  const reader = { threads: () => threads, sections: () => new Map(), state: (id) => (id === ID(7) ? null : { working: false }),
    thread: (id) => threads.find((t) => t.id === id) || null };
  const memory = { openThreads: () => [ID(5)], recentlyClosed: () => [], frontAt: () => 0 };
  const model = new SessionsModel(vscode, { memory, memento: fake.memento(), reader, stateOf: (id) => convs[Number(id.slice(-12))] || null,
    settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: true }) });
  const rows = () => {
    const m = model.model();
    return new Map(m.groups.flatMap((g) => g.rows).map((r) => [Number(r.id.slice(-12)), r]));
  };
  let r = rows();
  eq([1, 2, 3, 4, 5, 6, 7].map((n) => r.get(n).dot), ['working', 'background', 'waiting', 'none', 'none', 'working', 'unknown'],
    'a green dot working, a ring with only background work left, a red dot waiting, none stopped even when open here, '
    + 'none for a rollout not read');
  eq([1, 2, 3, 4, 5, 6, 7].map((n) => r.get(n).unread), [false, true, false, true, false, true, false],
    'a row says whether its conversation has a reply not seen, also while it works, which is also what offers Mark as Read');
  eq(r.get(4).title, 'Plan the release', 'a title is drawn without an envelope someone typed into the name');
  eq([r.get(1).archivable, r.get(2).archivable, r.get(3).archivable, r.get(4).archivable], [false, true, false, true],
    'a conversation working or waiting cannot be archived, one with only background work left or stopped can, as before');
  eq(model.model().envelope, COLOUR, 'the envelope is the colour one in a dark theme');
  vscode.window.activeColorTheme = { kind: 1 };
  model.refresh();
  eq(model.model().envelope, TEXT, 'and its text form in a light theme, where a colour emoji font draws it white');
  vscode.window.activeColorTheme = { kind: 2 };
  model.refresh();
  eq(model.model().envelope, COLOUR, 'and the colour one again once the theme is dark');

  /* ── the page ── */
  const css = fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.css'), 'utf8');
  const rule = (sel) => {
    const re = /([^{}]+)\{([^}]*)\}/g;
    for (let m; (m = re.exec(css));) {
      const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
      if (sels.includes(sel)) return m[2].replace(/\s+/g, ' ').trim();
    }
    return '';
  };
  eq([rule('.cp-dot.d-working'), rule('.cp-dot.d-background'), rule('.cp-dot.d-waiting')],
    ['background: #22c55e;', 'border: 2px solid #22c55e;', 'background: #ef4444;'],
    'green #22c55e working, a ring of the same green for background work, red #ef4444 waiting, in Claude Code Plus\'s colours');
  eq([/#3b82f6/i.test(css), /d-(prompt|unread|idle|failed|workingElsewhere)\b/.test(css)], [false, false], 'and no blue dot or other state is drawn any more');
  eq([/flex-shrink: 0/.test(rule('.cp-unseen')), /overflow: hidden|text-overflow/.test(rule('.cp-unseen')), /text-overflow: ellipsis/.test(rule('.cp-title'))],
    [true, false, true], 'the title is the part cut short with an ellipsis, and the envelope never shrinks or is cut');

  const p = runSessionsPage(root);
  const row = (n, extra = {}) => ({ id: ID(n), title: `Conversation ${n}`, time: `${n}d · 11/0${n}`, dot: 'none', color: '', open: false,
    sidebar: false, unread: false, grouped: false, group: 'Ungrouped', branch: '', ...extra });
  const long = 'A very long title that the sidebar cannot show whole, about the retry delay of the inventory sync and its cap';
  const page = { account: null, closed: [], open: [], front: '', noGroups: false, envelope: COLOUR,
    groups: [{ key: 'ungrouped', label: 'Ungrouped', made: false, rows: [row(1, { dot: 'working', unread: true, title: long }),
      row(2, { dot: 'background' }), row(3, { dot: 'waiting' }), row(4)] }] };
  p.toPage({ type: 'model', model: page });
  const el = (n) => p.$(`.cp-row[data-id="${ID(n)}"]`);
  const envOf = (n) => el(n).querySelector('.cp-unseen');
  const kids = (n) => el(n).children.map((k) => k.className.split(' ')[0]);
  eq(kids(1), ['cp-dot', 'cp-title', 'cp-unseen', 'cp-goal', 'cp-meta'],
    'the envelope comes after the title, which takes the room left, so it stands just before the time, which stays flush right');
  eq([envOf(1).textContent, envOf(1).classList.contains('cp-hidden'), el(1).querySelector('.cp-title').textContent, !!el(1).querySelector('.cp-title .cp-unseen')],
    [COLOUR, false, long, false], 'a row with a reply not seen shows the envelope outside its title, whose text carries none');
  eq([envOf(2).classList.contains('cp-hidden'), el(2).querySelector('.cp-dot').className, el(3).querySelector('.cp-dot').className],
    [true, 'cp-dot d-background', 'cp-dot d-waiting'], 'one without has none, and each dot is drawn by its activity');
  p.toPage({ type: 'model', model: { ...page, envelope: TEXT } });
  eq(envOf(1).textContent, TEXT, 'a model with the light theme\'s envelope redraws it');
  const renamedPage = JSON.parse(JSON.stringify(page));
  renamedPage.groups[0].rows[1].title = 'Renamed elsewhere';
  p.toPage({ type: 'model', model: renamedPage });
  eq(el(2).querySelector('.cp-title').textContent, 'Renamed elsewhere', 'a title renamed elsewhere, as from its tab, is redrawn in its row');

  /* Renaming in the list: the edit box holds the bare title, and the row keeps one envelope at the end. */
  p.posted.length = 0;
  p.toPage({ type: 'startRename', id: ID(1) });
  const title = el(1).querySelector('.cp-title');
  eq([title.isContentEditable, title.textContent], [true, long], 'the box starts from the title alone');
  title.textContent = `Fix ${COLOUR} the cap ${COLOUR}`;
  title.bubble('keydown', { key: 'Enter' });
  eq([p.posted.filter((m) => m.kind === 'rename').map((m) => m.title), title.textContent, el(1).querySelectorAll('.cp-unseen').length],
    [['Fix the cap'], 'Fix the cap', 1], 'envelopes typed into the new name are not sent or drawn in the title; the row keeps its one envelope');
};
