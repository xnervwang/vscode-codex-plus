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
    eq(model.font, { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif", size: 13 },
      'the model carries the chat font as Claude Code reads it: chat.fontFamily, or its own system stack for "default", and chat.fontSize, 13 by default');
  }

  /* ── the page ── */
  const p = runSessionsPage(root);
  const model = {
    account: { account: [{ label: 'Signed in with', value: 'Amazon Bedrock' }], windows: [], tokens: [] },
    closed: [], open: [row(1, { open: true, here: true, dot: 'working' })],
    groups: [{ key: 'ungrouped', label: 'Ungrouped', made: false,
      rows: [row(1, { open: true, here: true, dot: 'working' }), row(2, { dot: 'prompt' }), row(3, { dot: 'none' })] }],
    front: '', noGroups: false, menu: [], colors: [], font: { family: 'Fira Sans, sans-serif', size: 15 },
  };
  p.toPage({ type: 'model', model });

  /* The chat font, written on the list's root as the two variables Claude Code's page has. */
  const rootEl = p.$('.cp-root') || p.page;
  eq([rootEl.style.getPropertyValue('--vscode-chat-font-family'), rootEl.style.getPropertyValue('--vscode-chat-font-size')], ['Fira Sans, sans-serif', '15px'],
    'the page puts the chat font the host sent into --vscode-chat-font-family and --vscode-chat-font-size');
  eq([has('.cp-root', 'font-family: var(--vscode-chat-font-family, var(--vscode-font-family))'),
    has('.cp-root', 'font-size: var(--vscode-chat-font-size, var(--vscode-font-size, 13px))')], [true, true],
  'and the list is drawn in it, falling back to the interface font');

  /* The search box: above the filter buttons, the magnifier hidden while it is open, Claude Code's placeholder. */
  const filterRow = p.$('.cp-filter-row');
  eq([filterRow.childNodes[0].className.split(' ')[0], p.$('.cp-search input').placeholder], ['cp-search', 'Search sessions…'],
    'the search box is the filter row\'s first part, so it opens above the buttons, and says "Search sessions…"');
  p.$('[data-tool="search"]').bubble('click');
  eq([p.$('[data-tool="search"]').classList.contains('cp-hidden'), p.$('.cp-search').classList.contains('cp-hidden')], [true, false],
    'opening it hides the magnifier that opened it, as Claude Code does');
  eq([has('.cp-search input', 'border: 0'), has('.cp-search input', 'border-radius: 4px'), has('.cp-search input', 'margin: 4px'),
    has('.cp-search input', 'padding: 8px 12px 8px 32px'), has('.cp-search.cp-clearable input', 'padding-right: 28px'),
    has('.cp-search input', 'background: var(--vscode-input-background)'), has('.cp-search input::placeholder', 'opacity: .5')],
  [true, true, true, true, true, true, true],
  'the box is Claude Code\'s: no border, 4 px corners and margin, 8 px padding with room for the magnifier and the clear button, a placeholder at half strength');
  eq(has('.cp-mark', 'background: color-mix(in srgb, #d97757 20%, transparent)'), true, 'the matched text is marked in Claude\'s orange at 20%, as Claude Code marks it');

  /* The status filter's menu: Claude Code's menu, the count written after the label. */
  p.$('[data-tool="search"]').bubble('click');
  p.$('[data-tool="filter"]').bubble('click');
  const items = p.$$('.cp-menu-item');
  eq(items.map((i) => i.textContent), ['Needs input · 1', 'Working · 1', 'Completed · 1', 'Open · 1', 'Closed · 2'],
    'each choice reads as Claude Code writes it, "Needs input · 1", with no count column');
  eq(items.every((i) => !!i.querySelector('.cp-check')), true, 'each carries the 16 px place Claude Code keeps for its check');
  eq([rule('.cp-menu') === rule('.cp-ctx'), rule('.cp-menu-item') === rule('.cp-ctx-item'), rule('.cp-menu-sep') === rule('.cp-ctx-sep')], [true, true, true],
    'the menu, its items and its separator share the right-click menus\' rules, which copy Claude Code\'s menu');
  eq([has('.cp-menu-title', 'opacity: .5'), has('.cp-menu-title', 'padding: 4px 12px'), has('.cp-menu-title', 'font-size: .9em'),
    has('.cp-check', 'width: 16px'), has('.cp-check', 'margin-right: 6px')], [true, true, true, true, true],
  'its headings are Claude Code\'s section headers, at half strength, 4 by 12 px, 0.9em, and the check takes 16 px and 6 px after it');
  p.$('[data-tool="filter"]').bubble('click');

  /* The funnel and the bolt. */
  const cls = (sel) => (p.$(sel) || { getAttribute: () => '' }).getAttribute('class') || '';
  eq([/\bcp-solid\b/.test(cls('[data-tool="filter"] svg')), /\bcp-solid\b/.test(cls('[data-tool="active"] svg')),
    has('svg.cp-icon.cp-solid', 'fill: currentColor'), has('svg.cp-icon.cp-solid', 'stroke: none')], [true, true, true, true],
  'the funnel and the bolt are solid shapes, as Claude Code\'s are');
  const titles = [...p.$$('.cp-new'), p.$('[data-tool="active"]')].map((b) => b.title);
  eq(titles, ['Start a conversation in a new editor tab', 'Start a conversation in the sidebar', 'Show sessions that need input, are working, or are unread'],
    'New in tab, New in sidebar and Active say what Claude Code Plus\'s and Claude Code\'s say');
  eq([p.$('.cp-row [data-act="rename"]').title, has('.cp-act svg.cp-icon', 'width: 20px'), has('.cp-act svg.cp-icon', 'height: 20px')],
    ['Rename session', true, true], 'the rename button on a row is Claude Code\'s: a 20 px icon, "Rename session"');

  /* ACCOUNT and its rows. */
  eq([has('.cp-account-label', 'opacity: .7'), has('.cp-account-label', 'font-size: calc(var(--vscode-chat-font-size, 13px) - 1px)'),
    has('.cp-kv', 'padding: 4px 0'), has('.cp-account', 'gap: 4px'), has('.cp-kv > span:first-child', 'opacity: .7'),
    has('.cp-kv > span:first-child', 'color: var(--vscode-foreground)')], [true, true, true, true, true, true],
  'ACCOUNT is the foreground at 70% and one pixel under the chat font, and each row 4 px above and below, 4 px apart, its name at 70%');

  /* Lines, chevrons, outlines, the high usage bar. */
  eq([/var\(--vscode-sideBarActivityBarTop-border, var\(--vscode-sideBarSectionHeader-border/.test(rule('.cp-section')),
    /var\(--vscode-sideBarActivityBarTop-border, var\(--vscode-sideBarSectionHeader-border/.test(rule('.cp-new-row'))], [true, true],
  'the section lines try Claude Code\'s sideBarActivityBarTop.border first');

  /* The hover box: Claude Code Plus's look, over the row. */
  eq([has('.cp-hover', 'padding: 8px'), has('.cp-hover', 'border-radius: 8px'), has('.cp-hover', 'font-size: .9em'),
    has('.cp-hover', 'background: var(--vscode-menu-background, var(--vscode-editorWidget-background))'),
    has('.cp-hover', 'border: 1px solid var(--vscode-inlineChatInput-border, var(--vscode-input-border, var(--vscode-widget-border, #7f7f7f66)))'),
    has('.cp-hover', 'color: var(--vscode-foreground)'), has('.cp-hover', 'max-width: 260px'), has('.cp-hover', 'white-space: pre-line'),
    has('.cp-hover', 'line-height: 1.35')], [true, true, true, true, true, true, true, true, true],
  'the hover box is Claude Code Plus\'s: the menu background, the input border, 8 px corners and padding, 0.9em, at most 260 px, wrapping');

};
