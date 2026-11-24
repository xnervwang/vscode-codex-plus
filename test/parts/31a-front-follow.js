// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which conversation is in front while Codex's sidebar and a Codex tab are both open. The session list draws
 * source.front() as its current conversation, and Agent Plus's work plan view follows the conversation its focus
 * tracker settles on; the two must be the same one. As in Claude Code Plus, where both follow Claude Code's own
 * activeSessionId, the conversation of whichever of its panels became active last: whichever came to the front last,
 * the active tab or Codex's sidebar, and the sidebar hidden hands the front back to the tab.
 *
 * Agent Plus's side is its own Focus class, from its checkout (AGENT_WORK_PLAN_DIR, or vscode-agent-plus beside this
 * repository), driven as its src/views.js drives it: a tab change offers it the active tab, and a focus report offers
 * the active tab again and then, a moment later, the reported conversation if the source still says it is in front.
 * The patch stands in as in 31-sidebar-hidden.js, with the conversation the sidebar last went to and whether a sidebar
 * view is visible.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const A = '01a1d0e0-0000-7000-8000-0000000000e1';
const T1 = '01a1d0e0-0000-7000-8000-0000000000e2';
const T2 = '01a1d0e0-0000-7000-8000-0000000000e3';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, note, root }) => {
  const core = process.env.AGENT_WORK_PLAN_DIR || path.join(root, '..', 'vscode-agent-plus');
  if (!fs.existsSync(path.join(core, 'src', 'sources.js'))) { note(`no Agent Plus checkout at ${core}: its focus tracker was not run`); return; }
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const { Focus } = require(path.join(core, 'src', 'sources.js'));
  const { createCodexSource } = require('../../src/codex-source');
  const { createSeen } = require('../../src/seen');

  let sidebar = '', visible = false;
  const sidebarChanged = new fake.EventEmitter();
  const patching = { sidebarThread: () => sidebar, sidebarShowing: () => (visible ? sidebar : ''), canDeliver: () => false,
    onSidebarChanged: (fn) => sidebarChanged.event(fn) };
  const rows = [A, T1, T2].map((id, i) => ({ id, kind: 'user', title: `c${i}`, cwd: '/w', updatedMs: Date.now() }));
  const reader = { threads: () => rows, thread: (id) => rows.find((r) => r.id === id) || null, present: () => true,
    state: () => ({ working: false, endedMs: 1, lastActivityMs: 1 }), unread: () => new Map(), hasPlan: () => false,
    sections: () => new Map(), refresh: async () => false, ready: async () => ({ threads: rows, readable: true }) };
  const notes = control.fileTab('/w/notes.txt');
  const tabsOf = [control.codexTab(T1), control.codexTab(T2), notes];
  control.setTabs(tabsOf, 0);
  const source = createCodexSource(vscode, { reader, patching, seen: createSeen(fake.memento()) });

  /* Agent Plus's wiring of its focus tracker (its src/views.js: claimTab, and the onDidFocus listener of attach). */
  const focus = new Focus();
  const entries = [{ id: 'codex', source }];
  const activeTab = () => { const g = vscode.window.tabGroups.activeTabGroup; return g ? g.activeTab : undefined; };
  const claimTab = (again) => focus.claim(activeTab(), entries, again);
  const subs = [vscode.window.tabGroups.onDidChangeTabs(() => claimTab(false)),
    source.onDidFocus((e) => {
      claimTab(true);
      const mine = focus.mark();
      setTimeout(() => {
        if (focus.newerThan(mine)) return;
        if (e.sessionId && source.isFocused(e.sessionId) !== true) return;
        focus.report('codex', e.sessionId || '');
      }, 0);
    })];
  const both = async () => { await tick(); return { list: source.front(), workPlan: focus.sessionId }; };
  const to = async (i) => { control.setTabs(tabsOf, i); control.fireTabs(); return both(); };
  /* What the patch does when Codex's sidebar starts following a conversation (src/patching.js, the broadcast). */
  const follow = async (id) => { sidebar = id; visible = true; source._focus(id); sidebarChanged.fire(); return both(); };
  const show = async (on) => { visible = on; sidebarChanged.fire(); return both(); };
  try {
    eq(await to(0), { list: T1, workPlan: T1 }, 'with a Codex tab in front and no sidebar, both follow that tab\'s conversation');
    eq(await follow(A), { list: A, workPlan: A },
      'Codex\'s sidebar opened on another conversation with that tab still in front: the list\'s current row and the work plan view both follow the sidebar, which came to the front last');
    eq(await to(1), { list: T2, workPlan: T2 }, 'a click on another Codex tab: both follow that tab');
    eq(await to(0), { list: T1, workPlan: T1 }, 'and back on the first tab: both follow it');
    eq(await show(false), { list: T1, workPlan: T1 }, 'the sidebar hidden after a tab came forward changes neither');
    eq(await show(true), { list: A, workPlan: A }, 'the sidebar shown again with its conversation comes to the front for both');
    eq(await show(false), { list: T1, workPlan: T1 },
      'and hidden again while it was in front, both go back to the tab in front, the work plan view as well as the list');
    eq(await show(true), { list: A, workPlan: A }, 'shown once more, both follow it again');
    eq(await to(2), { list: A, workPlan: A }, 'with a text file brought to the front and the sidebar still showing, both keep the sidebar\'s conversation');
  } finally {
    for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } }
    source.dispose();
  }
};
