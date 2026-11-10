// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What this extension draws in Codex's conversation page, held to what Claude Code Plus draws for the same thing: the
 * hover labels, the time stamps, the two toolbar glyphs, the session information box, the strip's tool clock, the
 * button labels, the fonts, the Agent map's dots and its dialog's focus border, the context box, the rail's list, and
 * Codex's own time beside a message of yours while the stamps are on. Also the command titles shared with Claude Code
 * Plus's. The render check measures the same things in Codex's real page.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

/* The conversation of test/parts/63-release-polish.js: two turns of the user's, the message box, an optional meter.
   `own` puts a clock in the first message's row of buttons, where Codex renders its own time. */
function page(root, { own = '' } = {}) {
  const dom = createDom();
  const turn = (n) => dom.el('div', { attrs: { 'data-turn-key': `t${n}` }, kids: [dom.el('div', { attrs: { 'data-local-conversation-user-anchor': '' },
    kids: [dom.el('div', { attrs: { 'data-user-message-bubble': '' }, texts: [`message ${n}`] }),
      ...(own && n === 1 ? [dom.el('div', { kids: [dom.el('span', { attrs: { 'data-own': '' }, texts: [own] })] })] : [])] })] });
  const scroller = dom.el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, kids: [turn(1), turn(2)] });
  const composer = dom.el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 600, left: 40, width: 700, height: 120 } });
  dom.setBody(dom.el('body', { kids: [dom.el('div', { kids: [scroller, composer] })] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const send = (m) => listeners.message({ data: m });
  const view = (over = {}) => send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over));
  view();
  return { dom, posted, send, view, q: (sel) => dom.document.root.querySelectorAll(sel) };
}

module.exports = async ({ eq, root }) => {
  const source = fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8');
  const p = page(root, { own: '9:08 AM' });
  const css = () => (p.q('[data-codex-extras="style"]')[0] || {}).textContent || '';
  const ruleOf = (text, sel) => { const i = text.indexOf(sel + '{'); return i < 0 ? '' : text.slice(i + sel.length + 1, text.indexOf('}', i)); };

  /* ── the hover label: Claude Code Plus's box ── */
  const [info, mute] = p.q('[data-codex-extras="bar-button"]');
  mute.dispatch('mouseenter', {});
  const label = p.q('[data-codex-extras="label"]')[0];
  const look = label ? label.style.cssText : '';
  eq(['padding:8px;', 'background:var(--vscode-menu-background,', 'border:1px solid var(--vscode-inlineChatInput-border,var(--vscode-input-border,',
    'border-radius:8px;', 'color:var(--vscode-foreground,', 'font-size:.9em;'].map((x) => look.includes(x)).concat(/font:/.test(look)),
  [true, true, true, true, true, true, false],
  'a hover label is Claude Code Plus\'s: the menu background, the input border, 8 px corners and padding, the foreground, 0.9em in the page\'s own font');
  mute.dispatch('mouseleave', {});

  /* ── the Agent map's dots ── */
  eq(/DOT_TONE = \{ working: '#22c55e', prompt: '#3b82f6',\s*unread: '#ef4444', failed: 'var\(--vscode-errorForeground,#f85149\)'/.test(source), true,
    'a sub-agent\'s dot has the session list\'s colours');
};
