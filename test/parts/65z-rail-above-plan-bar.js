// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks placeRail in src/page/codex-extras-page.js. The rail is centred in the page, but when that would put its lower
 * buttons under the plan bar, as on Windows while Codex shows its setup notice over the message box, it ends 4 px above
 * the bar instead.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const SUMMARY = { total: 2, done: 0, counts: { discussing: 0, todo: 1, doing: 1, waiting: 0, parked: 0, done: 0 },
  current: { number: '1', title: 'Wire the flag', state: 'doing', dim: false }, allDone: false, questions: 0,
  open: [{ number: '1', title: 'Wire the flag', state: 'doing', depth: 1 }, { number: '2', title: 'Docs', state: 'todo', depth: 1 }] };

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const { el } = dom;
  const turn = (i) => el('div', { attrs: { 'data-turn-key': `k${i}` }, kids: [el('div', { attrs: { 'data-content-search-turn-key': `turn-${i}` }, kids: [
    el('div', { attrs: { 'data-local-conversation-user-anchor': 'true', 'data-content-search-unit-key': `t:${i}` }, rect: { top: 100 * i, height: 50 },
      kids: [el('div', { attrs: { 'data-user-message-bubble': 'true' }, rect: { top: 100 * i, height: 40, left: 700, width: 300 }, kids: [el('p', { texts: [`Question ${i}`] })] })] }),
    el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [el('div', { attrs: { 'data-response-annotation-target': `item-${i}` },
      rect: { top: 100 * i + 60, height: 40 }, kids: [el('p', { texts: [`Reply ${i}`] })] })] })] })] });
  const scroller = el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 296, left: 0, width: 1100 }, kids: [turn(1), turn(2)] });
  const composer = el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 300, left: 8, width: 1084, height: 170 } });
  dom.setBody(el('body', { kids: [el('div', { kids: [scroller, composer] })] }));
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage() {} }), location: { pathname: '/index.html', hash: '' }, innerHeight: 480, innerWidth: 1100,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const send = (m) => listeners.message.forEach((fn) => fn({ data: m }));
  const resized = () => (listeners.resize || []).forEach((fn) => fn());
  const bar = (summary) => send({ type: 'codex-extras-plan-bar', on: !!summary, summary: summary || null });

  send({ type: 'codex-extras-view', timestamps: false, navigation: true, userColor: '', userEdge: false });
  const rail = dom.document.root.querySelectorAll('.codex-extras-rail')[0];
  eq(!!rail, true, 'the rail is drawn for a conversation with messages of the user\'s');
  if (!rail) return;
  rail.offsetHeight = 160;
  resized();
  eq(rail.style.top, '160px', 'with no plan bar the rail is centred in the page');
  bar(SUMMARY);
  const drawn = dom.document.root.querySelectorAll('[data-codex-extras="plan-bar"]')[0];
  eq([drawn && drawn.style.top, rail.style.top], ['268px', '104px'],
    'with the plan bar drawn 32 px above the message box, the rail is moved up to end 4 px above the bar rather than run under it');
  resized();
  eq(rail.style.top, '104px', 'and it stays there when the page is laid out again');
  bar(null);
  eq(rail.style.top, '160px', 'with the bar gone the rail is centred again');
  win.innerHeight = 900;
  composer.rect = { top: 720, left: 8, width: 1084, height: 170 };
  resized();
  bar(SUMMARY);
  eq(rail.style.top, '370px', 'in a page tall enough for the centred rail to end above the bar, the bar does not move it');
  bar(null);
  win.innerHeight = 300;
  scroller.rect = { top: 30, height: 166, left: 0, width: 1100 };
  composer.rect = { top: 200, left: 8, width: 1084, height: 100 };
  resized();
  bar(SUMMARY);
  eq(rail.style.top, '34px', 'in a page with no room for the rail between the top of the conversation and the bar, it stops 4 px below the top '
    + 'of the conversation, short of Codex\'s header and its New chat button, and stays over the bar');
};
