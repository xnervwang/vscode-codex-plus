// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks that the plan bar's room does not move a conversation away from its end (keepEnd in
 * src/page/codex-extras-page.js). Codex's conversation scroller and the message box sit one above the other, so the
 * 32 px of top margin the box gets while the bar is drawn come out of the scroller's height. Codex measures the turns
 * a pass made taller on its next frame. While it is not following the end, it then keeps the passage at the top of the
 * view where it was. The window test (test/vscode/ui.js) checks the same on Codex's own page.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const BOX = { top: 602, left: 8, width: 1084, height: 142 };
const VIEW = 400;
const SUMMARY = { total: 3, done: 1, counts: { discussing: 0, todo: 1, doing: 1, waiting: 0, parked: 0, done: 1 },
  current: { number: '2', title: 'Wire the flag', state: 'doing', dim: false }, allDone: false, questions: 0,
  open: [{ number: '2', title: 'Wire the flag', state: 'doing', depth: 1 }, { number: '3', title: 'Docs', state: 'todo', depth: 1 }] };
const LONGER = Object.assign({}, SUMMARY, { questions: 1,
  current: { number: '2', title: 'Wire the flag through the settings page, the host and the page script', state: 'doing', dim: false } });

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const { el } = dom;
  const box = el('div', { attrs: { 'data-codex-composer-root': '' }, rect: Object.assign({}, BOX) });
  const scroller = el('div', { attrs: { 'data-app-action-timeline-scroll': '' } });
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-request-input-activity-root': '' }, kids: [scroller, box] })] }));
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  const room = () => (/\[data-codex-composer-root\]\{margin-top:32px !important;\}/.test((q('[data-codex-extras="style"]')[0] || { textContent: '' }).textContent) ? 32 : 0);
  let top = 0, content = 1000;
  const most = () => content - (VIEW - room());
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, set() {}, get: () => VIEW - room() });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, set() {}, get: () => content });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true,
    set(v) { top = Math.max(0, Math.min(Number(v) || 0, most())); }, get: () => { top = Math.max(0, Math.min(top, most())); return top; } });
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage() {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const send = (m) => listeners.message({ data: m });
  const bar = (summary) => send({ type: 'codex-extras-plan-bar', on: !!summary, summary: summary || null });
  const view = (more) => send(Object.assign({ type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false }, more));
  const at = () => ({ room: room(), fromEnd: content - scroller.clientHeight - scroller.scrollTop });
  const grows = (px) => { const keep = scroller.scrollTop; content += px; scroller.scrollTop = keep; };
  const toEnd = (short = 0) => { scroller.scrollTop = most() - short; };

  view();
  toEnd();
  eq(at(), { room: 0, fromEnd: 0 }, 'the conversation starts at its end, with no bar');
  bar(SUMMARY);
  eq(at(), { room: 32, fromEnd: 0 }, 'the bar drawn takes 32 px from the scroller, and a conversation at its end is scrolled by them and stays at its end');
  bar(LONGER);
  eq([at(), q('[data-codex-extras="plan-bar"] .apb-q').length], [{ room: 32, fromEnd: 0 }, 1],
    'the bar saying more, with a red part, takes no more room, and the conversation stays at its end');
  box.rect = Object.assign({}, BOX, { width: 300 });
  if (listeners.resize) listeners.resize();
  eq([at(), (q('[data-codex-extras="plan-bar"]')[0] || { getAttribute: () => null }).getAttribute('data-compact')], [{ room: 32, fromEnd: 0 }, '1'],
    'the compact bar over a narrow box takes the same room, and the conversation stays at its end');
  box.rect = Object.assign({}, BOX);
  if (listeners.resize) listeners.resize();
  bar(null);
  eq(at(), { room: 0, fromEnd: 0 }, 'the bar taken away gives the room back, and the conversation is still at its end');

  toEnd(100);
  bar(SUMMARY);
  eq([at(), scroller.scrollTop], [{ room: 32, fromEnd: 132 }, most() - 132], 'a conversation scrolled up is left where it was when the bar takes its room');
  bar(null);
  eq([at(), scroller.scrollTop], [{ room: 0, fromEnd: 100 }, most() - 100], 'and where it was when the bar gives it back');

  toEnd(10);
  bar(SUMMARY);
  eq(at(), { room: 32, fromEnd: 10 }, 'one within 24 px of its end, which Codex counts as at its end, stays as far from its end as it was');

  toEnd();
  view({ buttons: false });
  eq([at(), q('[data-codex-extras="plan-bar"]').length], [{ room: 0, fromEnd: 0 }, 0], 'Codex Plus turned off takes the bar and its room away, and the conversation is at its end');
  view();
  bar(SUMMARY);
  eq([at(), q('[data-codex-extras="plan-bar"]').length], [{ room: 32, fromEnd: 0 }, 1], 'turned on again the bar takes its room again, and the conversation is still at its end');
  grows(87);
  eq(at().fromEnd, 87, 'Codex measuring the turns the pass made taller, a frame later, moves the end down');
  dom.runTimers();
  eq(at(), { room: 32, fromEnd: 0 }, 'and on the next frame of the hold the conversation is back at its end');

  bar(LONGER);
  dom.document.dispatch('wheel', {});
  grows(40);
  dom.runTimers();
  eq(at().fromEnd, 40, 'a wheel in the page ends the hold, and the end that moves after it is left where it went');

  toEnd();
  bar(SUMMARY);
  grows(VIEW + 200);
  dom.runTimers();
  eq(at().fromEnd, VIEW + 200, 'and so does the end moving away by more than the view is tall, as when Codex shows another part of the conversation');
  dom.runTimers();
  eq(dom.waiting(), 0, 'with the hold ended no frame of it is left waiting');
};
