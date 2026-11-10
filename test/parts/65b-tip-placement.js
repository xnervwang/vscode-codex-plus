// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A label is centred on its control and drawn above it, or below it when there is no room above, so it never covers the
 * control the pointer is on. A row's preview in a page too narrow to put it beside the list goes just below the row, or
 * just above it when it would run off the bottom of the page.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const W = 1100, H = 760, BOX_W = 120, BOX_H = 30;

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const { el } = dom;
  /* Every element the script makes measures BOX_W by BOX_H, so a box it draws has a size to place. */
  const make = dom.document.createElement;
  dom.document.createElement = function (tag) { const e = make.call(this, tag); e.rect = { top: 0, left: 0, width: BOX_W, height: BOX_H }; return e; };
  const msg = (text, top) => el('div', { attrs: { 'data-local-conversation-user-anchor': '', 'data-content-search-unit-key': 'u' }, rect: { top, height: 60, left: 600, width: 400 },
    kids: [el('div', { attrs: { 'data-user-message-bubble': '' }, kids: [el('p', { texts: [text] })] }), el('div', { kids: [el('span', { texts: ['10:35 PM'] })] })] });
  const turn = (key, user) => el('div', { attrs: { 'data-turn-key': key }, kids: [el('div', { attrs: { 'data-content-search-turn-key': key }, kids: [user] })] });
  const scroller = el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 700 },
    kids: [turn('k1', msg('first question', 100)), turn('k2', msg('second question', 400))] });
  dom.setBody(el('body', { kids: [scroller] }));
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage() {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerWidth: W, innerHeight: H };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  listeners.message({ data: { type: 'codex-extras-view', timestamps: true, navigation: true, userEdge: true } });
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  const px = (v) => (v === undefined ? null : parseFloat(v));
  const overlaps = (box, r) => {
    const top = px(box.style.top), left = px(box.style.left);
    return top < r.top + r.height && top + BOX_H > r.top && left < r.left + r.width && left + BOX_W > r.left;
  };

  /* ── a label ── */
  const rail = q('[data-codex-extras="nav-button"]');
  const label = (button, rect) => {
    button.rect = rect;
    button.dispatch('mouseenter', {});
    const box = q('[data-codex-extras="label"]')[0];
    button.dispatch('mouseleave', {});
    return box;
  };
  const mid = { top: 300, left: 500, width: 28, height: 24 };
  const a = label(rail[1], mid);
  eq([px(a.style.left), px(a.style.top)], [mid.left + mid.width / 2 - BOX_W / 2, mid.top - BOX_H - 8],
    'a label is centred on its control and drawn just above it');
  const nearTop = { top: 4, left: W - 28, width: 28, height: 24 };
  const b = label(rail[0], nearTop);
  eq([px(b.style.top), px(b.style.left), overlaps(b, nearTop)], [nearTop.top + nearTop.height + 8, W - BOX_W - 8, false],
    'with no room above, it goes below the control, kept inside the page, and does not cover it');

  /* ── a row's preview in a narrow page ── */
  const panel = q('[data-codex-extras="nav-list"]')[0];
  panel.rect = { top: 8, left: 60, width: 280, height: 740 };
  const rows = q('[data-codex-extras="nav-row"]');
  const tip = (row, rect) => {
    row.rect = rect;
    row.dispatch('mouseenter', {});
    const box = q('[data-codex-extras="nav-tip"]')[0];
    row.dispatch('mouseleave', {});
    return box;
  };
  const upper = { top: 100, left: 60, width: 280, height: 20 };
  eq(px(tip(rows[0], upper).style.top), upper.top + upper.height + 2, 'with no room beside the list, a row\'s preview goes over it, just below the row');
  const low = { top: H - 40, left: 60, width: 280, height: 20 };
  const c = tip(rows[1], low);
  eq([px(c.style.top), px(c.style.top) + BOX_H <= H], [low.top - BOX_H - 2, true],
    'and just above it when below would run off the bottom of the page');
};
