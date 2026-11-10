// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The rail on the right edge and the list it opens, which should behave like Claude Code Plus's. Every rail button and
 * every list row has a hover box drawn by the script, because a native title is not reliably shown in Codex's page. A
 * row's box shows its time and first 220 characters, to the left of the list. The list is 280 wide with 44 characters
 * per row, and clicking a row keeps the view on that message for about a second while Codex's turns are still moving.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

function pageUnder(root, dom) {
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage() {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerWidth: 1100, innerHeight: 760 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  return { send(m) { listeners.message({ data: m }); } };
}

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const { el } = dom;
  const LONG = 'Look at how the cache key is built for the inventory sync, and say whether the warehouse id is part of it, '
    + 'because two warehouses that share a product code are getting each other\'s stock levels after a restart of the service, '
    + 'which started after the last release.';
  const msg = (text, top) => el('div', { attrs: { 'data-local-conversation-user-anchor': '', 'data-content-search-unit-key': 'u' }, rect: { top, height: 60, left: 600, width: 400 },
    kids: [el('div', { attrs: { 'data-user-message-bubble': '' }, kids: [el('p', { texts: [text] })] }), el('div', { kids: [el('span', { texts: ['10:35 PM'] })] })] });
  const first = msg(LONG, 100), second = msg('and the tests?', 400);
  const turn = (key, user) => el('div', { attrs: { 'data-turn-key': key }, kids: [el('div', { attrs: { 'data-content-search-turn-key': key }, kids: [user] })] });
  const scroller = el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 700 }, kids: [turn('k1', first), turn('k2', second)] });
  dom.setBody(el('body', { kids: [scroller] }));
  const page = pageUnder(root, dom);
  page.send({ type: 'codex-extras-view', timestamps: true, navigation: true, userEdge: true });
  const q = (sel) => dom.document.root.querySelectorAll(sel);

  /* ── no native titles; this script's own boxes instead ── */
  const rail = q('[data-codex-extras="nav-button"]');
  const rows = q('[data-codex-extras="nav-row"]');
  eq([rail.length, rail.filter((b) => b.getAttribute('title') !== null).length, rows.filter((r) => r.getAttribute('title') !== null).length], [5, 0, 0],
    'neither the five buttons of the rail nor a row of the list carries a native title');
  rail[2].dispatch('mouseenter', {});
  const label = q('[data-codex-extras="label"]')[0];
  eq(label && label.textContent, 'Your messages in this conversation - click one to jump to it', 'resting on the handle shows its explanation in a box of this script\'s own');
  rail[2].dispatch('mouseleave', {});
  eq(q('[data-codex-extras="label"]').length, 0, 'which goes when the pointer leaves');
  rail[0].dispatch('mouseenter', {});
  eq((q('[data-codex-extras="label"]')[0] || {}).textContent, 'Top of the conversation', 'and so does every other button of the rail');
  rail[0].dispatch('mouseleave', {});

  const panel = q('[data-codex-extras="nav-list"]')[0];
  panel.rect = { top: 8, left: 1100 - 28 - 280, width: 280, height: 200 };
  rows[0].rect = { top: 40, left: panel.rect.left, width: 280, height: 20 };
  rows[0].dispatch('mouseenter', {});
  const tip = q('[data-codex-extras="nav-tip"]')[0];
  eq([!!tip, tip && tip.textContent.split('\n')[0], tip && tip.textContent.split('\n')[1], tip && tip.textContent.split('\n')[1].length],
    [true, '22:35', LONG.slice(0, 220), 220], 'resting on a row shows its time and its first 220 characters at once');
  eq([tip && tip.style.right, tip && tip.style.top], [`${28 + 280 + 8}px`, '34px'], 'beside the list, on its left, level with the row');
  rows[0].dispatch('mouseleave', {});
  eq(q('[data-codex-extras="nav-tip"]').length, 0, 'and it is taken out of the page when the pointer leaves the row');
  eq([/width:min\(280px/.test((q('[data-codex-extras="style"]')[0] || dom.document.head.children.find((k) => k.getAttribute('data-codex-extras') === 'style')).textContent),
    rows[0].textContent.split('  ').pop()], [true, LONG.slice(0, 44)], 'the list is 280 wide, and a row shows 44 characters');

  /* ── the landing is held while Codex's turns still move ── */
  dom.runTimers();
  const before = first.scrolledIntoView;
  rows[0].dispatch('click', { stopPropagation() {} });
  eq(first.scrolledIntoView, before + 1, 'a click scrolls to the message');
  first.rect = { ...first.rect, top: 260 };
  dom.runTimers();
  eq(first.scrolledIntoView, before + 2, 'pushed away while its turns are still measured, it is put back');
  first.rect = { ...first.rect, top: 100 };
  dom.runTimers(); dom.runTimers(); dom.runTimers();
  const settled = first.scrolledIntoView;
  first.rect = { ...first.rect, top: 300 };
  dom.runTimers();
  eq(first.scrolledIntoView, settled, 'once it has stayed where it was put, it is left alone');
  rows[0].dispatch('click', { stopPropagation() {} });
  const clicked = first.scrolledIntoView;
  scroller.dispatch('wheel', {});
  first.rect = { ...first.rect, top: 500 };
  dom.runTimers();
  eq(first.scrolledIntoView, clicked, 'and a turn of the wheel is the user scrolling, which ends the hold at once');
};
