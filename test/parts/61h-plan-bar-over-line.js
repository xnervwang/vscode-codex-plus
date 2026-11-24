// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The plan bar over a message box this script's own controls make taller. When Codex's toolbar row has no room for
 * them they go to a line of their own inside the box, and the box grows by that line; the plan bar placed in the same
 * pass has to sit above the box as it is with the line in it. Codex makes room run out on its own, as when a turn starts
 * and it draws its message box in one row, so this happens with no resize of the window. The stand-in box grows by
 * 28 px, a Codex button's height, while the line is in it, as Codex's footer grid (no gap between its rows) does; the
 * stand-in DOM has no ResizeObserver, so only the pass itself can move the bar.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const FLEX = { display: 'flex' }, CONTENTS = { display: 'contents' };
const BASE = { top: 602, left: 8, width: 1084, height: 142 };
const LINE_H = 28;
const SUMMARY = { total: 3, done: 1, counts: { discussing: 0, todo: 1, doing: 1, waiting: 0, parked: 0, done: 1 },
  current: { number: '2', title: 'Wire the flag', state: 'doing', dim: false }, allDone: false, questions: 0,
  open: [{ number: '2', title: 'Wire the flag', state: 'doing', depth: 1 }, { number: '3', title: 'Docs', state: 'todo', depth: 1 }] };

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const { el } = dom;
  const add = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'add-context' }, class: 'aspect-square',
    rect: { top: 708, left: 16, width: 28, height: 28 } });
  const perm = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'permissions' }, class: 'px-2',
    rect: { top: 708, left: 49, width: 119, height: 28 } });
  const left = el('div', { computed: FLEX, rect: { top: 708, left: 16, width: 152, height: 28 }, kids: [el('span', { computed: CONTENTS, kids: [add] }), perm] });
  const trigger = el('button', { attrs: { type: 'button', 'data-composer-navigation-target': 'reasoning' }, rect: { top: 708, left: 799, width: 121, height: 28 },
    texts: ['5.5 Medium'] });
  const slot = el('span', { rect: { top: 708, left: 799, width: 121, height: 28 }, kids: [el('span', { computed: CONTENTS, kids: [trigger] })] });
  const right = el('div', { computed: FLEX, rect: { top: 708, left: 799, width: 249, height: 28 }, kids: [slot] });
  const grid = el('div', { attrs: { 'data-composer-footer-responsive': '' }, computed: { display: 'grid' }, kids: [el('div', { kids: [left] }), el('div', { kids: [right] })] });
  const box = el('div', { attrs: { 'data-codex-composer-root': '' }, kids: [grid] });
  const grown = () => (box.querySelectorAll('[data-codex-extras="line"]').length ? LINE_H : 0);
  Object.defineProperty(box, 'rect', { configurable: true, set() {},
    get: () => ({ top: BASE.top - grown(), left: BASE.left, width: BASE.width, height: BASE.height + grown() }) });
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-request-input-activity-root': '' }, kids: [box] })] }));
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage() {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const send = (m) => listeners.message({ data: m });
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  const pass = () => { dom.fire([{ type: 'childList', target: grid }]); dom.runTimers(); };
  const roomTo = (x) => { for (const e of [trigger, slot, right]) e.rect = Object.assign({}, e.rect, { left: x }); };
  const where = () => {
    const b = q('[data-codex-extras="plan-bar"]')[0];
    return { line: !!q('[data-codex-extras="line"]')[0], barTop: b ? b.style.top : null, boxTop: box.getBoundingClientRect().top };
  };

  send({ type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false });
  send({ type: 'codex-extras-plan-bar', on: true, summary: SUMMARY });
  pass();
  eq(where(), { line: false, barTop: `${BASE.top - 32}px`, boxTop: BASE.top },
    'with room in Codex\'s toolbar row, the controls are in it and the plan bar sits 32 px above the box');

  roomTo(172);
  pass();
  eq(where(), { line: true, barTop: `${BASE.top - LINE_H - 32}px`, boxTop: BASE.top - LINE_H },
    'when Codex leaves the row no room, the controls go to their own line in the box, which grows, and the plan bar placed in that same pass is above the grown box');

  roomTo(799);
  pass();
  eq(where(), { line: false, barTop: `${BASE.top - 32}px`, boxTop: BASE.top },
    'and with room again, back in the row, the box shrinks and the bar is back above it');
};
