// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Where the page script's own elements sit against Codex's, as test/render/run.js measured them in Codex's real page:
 *
 *   the row below the message box   the two buttons and the figures strip on one line, ROW_GAP below the box's frame,
 *                                   glyphs at the size of Codex's toolbar icons, no background of their own, and the
 *                                   room under the box that line needs
 *   the rail's column               the conversation kept clear of it while the rail is drawn, and an opaque hover
 *   one time per reply              Codex's own sent time hidden under a reply this script stamped
 *   the tool call running           left to Codex while its own row for that call is in view
 *   a message without an anchor     one steered into a running turn, taken as the user's
 *   a time after its day's name     "Sunday 9:02 AM", as Codex writes an earlier day's, read with the page's own day
 *
 * Each is checked in a stand-in page (test/fake-dom.js); how they look in the real one is the render check's.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

function pageUnder(root, dom, win = {}) {
  const posted = [];
  const listeners = {};
  Object.assign(win, { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  return { posted, send(m) { listeners.message({ data: m }); },
    view(over = {}) { this.send({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true, ...over }); } };
}

/* A conversation of `users` messages of the user's, each a turn with its reply, then optionally a steered one. */
function conversation(dom, { steered = false, toolRow = null } = {}) {
  const { el } = dom;
  const reply = (i) => el('div', { attrs: { 'data-response-annotation-target': `item-${i}` }, rect: { top: 100 * i + 60, height: 40 },
    kids: [el('h4', { attrs: { 'data-conversation-role': 'assistant' }, texts: ['Codex said'] }), el('p', { texts: [`Reply ${i}`] }),
      el('div', { kids: [el('span', { attrs: { 'data-assistant-message-sent-time': 'true' }, kids: [el('span', { texts: ['9:0' + i + ' AM'] })] })] })] });
  const user = (i, anchored) => el('div', { attrs: anchored ? { 'data-local-conversation-user-anchor': 'true', 'data-content-search-unit-key': `t:${i}` }
    : { 'data-content-search-unit-key': `t:${i}` }, rect: { top: 100 * i, height: 50 },
  kids: [el('div', { attrs: { 'data-user-message-bubble': 'true' }, rect: { top: 100 * i, height: 40, left: 700, width: 300 },
    kids: [el('p', { texts: [`Question number ${i}`] })] })] });
  const turnOf = (i, extra = []) => el('div', { attrs: { 'data-turn-key': `k${i}` }, kids: [el('div', { attrs: { 'data-content-search-turn-key': `turn-${i}` },
    kids: [user(i, true), ...extra, el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [reply(i)] })] })] });
  const extra = [];
  if (steered) extra.push(user(9, false));
  if (toolRow) extra.push(el('div', { attrs: { 'data-local-conversation-item-target-ids': toolRow.id }, rect: toolRow.rect, texts: ['Running npm run watch'] }));
  const turns = [turnOf(1), turnOf(2, extra)];
  const scroller = el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600, left: 0, width: 1100 }, kids: turns });
  const composer = el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 602, left: 8, width: 1084, height: 138 } });
  dom.setBody(el('body', { kids: [el('div', { kids: [scroller, composer] })] }));
  return { scroller, composer };
}

const sheetText = (dom) => {
  const s = dom.document.root.querySelectorAll('[data-codex-extras="style"]')[0];
  if (s) return s.textContent;
  const head = dom.document.head;
  const found = head && head.children ? head.children.find((k) => k.getAttribute && k.getAttribute('data-codex-extras') === 'style') : null;
  return found ? found.textContent : '';
};

module.exports = async ({ eq, root }) => {
  /* ── the row below the message box ── */
  {
    const dom = createDom();
    conversation(dom);
    const p = pageUnder(root, dom);
    p.view();
    p.send({ type: 'codex-extras-figures', text: '1 command running', tool: '', toolSince: 0, toolCall: '' });
    const q = (sel) => dom.document.root.querySelectorAll(sel);
    const bar = q('[data-codex-extras="bar"]')[0], strip = q('[data-codex-extras="figures"]')[0];
    eq([bar && bar.style.top, strip && strip.style.top, strip && strip.style.right], ['742px', '742px', '8px'],
      'the buttons and the strip are on one line, 2 px below the frame, the strip ending under the box\'s right edge');
    eq(q('[data-codex-extras="bar-button"]').map((b) => { const s = b.querySelectorAll('svg')[0]; return [s.getAttribute('width'), s.getAttribute('height'), b.style.height]; }),
      [['16', '16', '16px'], ['16', '16', '16px']],
      'the two glyphs are drawn icons at the size of Codex\'s own toolbar icons, as tall as the line');
    eq([/background/.test(strip.style.cssText), /opacity/.test(strip.style.cssText)], [false, false],
      'the strip has no background or opacity of its own, so nothing of it shows but its words');
    const css = sheetText(dom);
    eq(css.includes('[data-codex-composer-root]{margin-bottom:4px !important;}'), true,
      'and the box is given the 4 px more at its foot that a line of that height and its gap need');
  }

  /* ── the rail's column and its hover ── */
  {
    const dom = createDom();
    conversation(dom);
    const p = pageUnder(root, dom);
    p.view();
    const css = sheetText(dom);
    eq(css.includes('[data-app-action-timeline-scroll]{border-inline-end:28px solid transparent !important;}'), true,
      'while the rail is drawn the conversation keeps clear of its column, with a transparent border that leaves Codex\'s padding alone');
    eq(/\.codex-extras-rail-btn:hover\{background-image:linear-gradient\(/.test(css) && !/\.codex-extras-rail-btn:hover\{background:/.test(css), true,
      'and a hovered rail button is tinted over its own colour, so it stays opaque');
    p.view({ navigation: false });
    eq(sheetText(dom).includes('border-inline-end'), false, 'with the list turned off the conversation has its column back');
  }

  /* ── one time per reply ── */
  {
    const dom = createDom();
    conversation(dom);
    const p = pageUnder(root, dom);
    p.view();
    const stamps = () => dom.document.root.querySelectorAll('.codex-extras-stamp-assistant');
    eq([stamps().map((s) => s.getAttribute('data-codex-extras-timed')), dom.document.root.querySelectorAll('.codex-extras-timed').length], [['', ''], 0],
      'a reply\'s stamp that shows a time says so on itself, and nothing is added to Codex\'s own element');
    eq(sheetText(dom).includes('[data-response-annotation-target]:has(> [data-codex-extras-timed]) [data-assistant-message-sent-time]{display:none !important;}'), true,
      'and Codex\'s own sent time in a reply holding such a stamp is hidden, so the reply shows one time');
    p.view({ timestamps: false });
    eq([stamps().length, sheetText(dom).includes('data-codex-extras-timed')], [0, false], 'with the times turned off Codex\'s own time comes back');
  }

  /* ── a message steered into a running turn ── */
  {
    const dom = createDom();
    conversation(dom, { steered: true });
    const p = pageUnder(root, dom);
    p.view();
    p.send({ type: 'codex-extras-selfcheck', id: 's1' });
    const r = p.posted.filter((m) => m.kind === 'selfcheck').pop().report;
    eq([r.codex.userAnchors, r.codex.userWithoutAnchor, r.codex.entries.user, r.navigation.rows], [2, 1, 3, 3],
      'a search unit holding a user bubble and no anchor is taken as the user\'s, listed and counted as one without an anchor');
    const steered = dom.document.root.querySelectorAll('[data-content-search-unit-key="t:9"]')[0];
    const bubble = steered.querySelectorAll('[data-user-message-bubble]')[0];
    eq(bubble.classList.contains('codex-extras-user-edge'), true, 'and its bubble gets the bar down its edge like the others');
  }

  /* ── a time written after its day's name, as Codex writes one from an earlier day ── */
  for (const withDay of [true, false]) {
    const dom = createDom();
    const { el } = dom;
    const head = withDay ? [el('div', { kids: [el('time', { attrs: { datetime: '2026-11-08T17:02:11.000Z' }, texts: ['Yesterday 9:02 AM'] })] })] : [];
    const user = el('div', { attrs: { 'data-local-conversation-user-anchor': 'true', 'data-content-search-unit-key': 't:1' },
      kids: [el('div', { attrs: { 'data-user-message-bubble': 'true' }, kids: [el('p', { texts: ['Look at the cache key'] })] }),
        el('div', { kids: [el('span', { kids: [el('span', { texts: ['Sunday 9:02 AM'] })] })] })] });
    const reply = el('div', { attrs: { 'data-response-annotation-target': 'item-2' },
      kids: [el('h4', { attrs: { 'data-conversation-role': 'assistant' }, texts: ['Codex said'] }), el('p', { texts: ['It is read once.'] }),
        el('div', { kids: [el('span', { attrs: { 'data-assistant-message-sent-time': 'true' }, kids: [el('span', { texts: ['Sunday 9:04 AM'] })] })] })] });
    const turn = el('div', { attrs: { 'data-turn-key': 'k1' }, kids: [...head, el('div', { attrs: { 'data-content-search-turn-key': 'turn-1' },
      kids: [user, el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [reply] })] })] });
    dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [turn] })] }));
    const p = pageUnder(root, dom);
    p.view();
    const stamp = (host) => { const s = host.children.find((k) => k.getAttribute('data-codex-extras') === 'stamp'); return s ? s.textContent : null; };
    if (withDay) {
      /* The divider's day is not today, so both stamps start with it (the form is checked in 60-page-features). */
      const day = new Date('2026-11-08T17:02:11.000Z'), now = new Date();
      const md = `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`;
      const pre = day.toDateString() === now.toDateString() ? '' : `${day.getFullYear() === now.getFullYear() ? md : `${day.getFullYear()}/${md}`} `;
      eq([stamp(user), stamp(reply)], [`${pre}09:02`, `${pre}09:04`],
        'under a day the page states, a time written after its day\'s name is read as that day\'s clock, on both sides');
    } else {
      eq([stamp(user), stamp(reply)], [null, null], 'with no day on the page the same time is left off rather than put on today');
    }
  }

  /* ── the tool call running, left to Codex while its row is in view ── */
  for (const [where, rect, says] of [['in view', { top: 300, height: 20 }, false], ['scrolled out of view', { top: -400, height: 20 }, true]]) {
    const dom = createDom();
    conversation(dom, { toolRow: { id: 'call_watch_1', rect } });
    const p = pageUnder(root, dom);
    p.view();
    p.send({ type: 'codex-extras-figures', text: '1 command running', tool: 'exec_command', toolSince: Date.now() - 5000, toolCall: 'call_watch_1' });
    const strip = dom.document.root.querySelectorAll('[data-codex-extras="figures"]')[0];
    eq(/running for/.test(strip.textContent), says, says
      ? 'with Codex\'s row for that call scrolled out of view the strip says it'
      : 'with Codex\'s own row for the running call in view the strip leaves it out and keeps the count of commands');
    if (!says) eq(/1 command running/.test(strip.textContent), true, 'the commands still running are still counted there');
  }
};
