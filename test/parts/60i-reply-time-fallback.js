// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const T1 = '019a6a10-0000-7000-8000-0000000000c1';
const T2 = '019a6a10-0000-7000-8000-0000000000c2';
const T3 = '019a6a10-0000-7000-8000-0000000000c3';

function pageUnder(root, dom) {
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: () => {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' } };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  return { send(m) { listeners.message({ data: m }); } };
}

module.exports = async ({ eq, root }) => {
  const now = new Date();
  const at = (h, m, s) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
  const dom = createDom();
  const { el } = dom;
  const userEl = (words) => el('div', { attrs: { 'data-local-conversation-user-anchor': '', 'data-content-search-unit-key': 'u' },
    kids: [el('div', { attrs: { 'data-user-message-bubble': '' }, kids: [el('p', { texts: [words] })] })] });
  const replyEl = () => el('div', { attrs: { 'data-response-annotation-target': '' }, kids: [
    el('h4', { attrs: { 'data-conversation-role': 'assistant' }, texts: ['Codex said'] }), el('p', { texts: ['an answer'] })] });
  const turnEl = (key, user, reply, worked) => el('div', { attrs: { 'data-turn-key': key }, kids: [el('div', { attrs: { 'data-content-search-turn-key': key },
    kids: [el('div', { kids: [user, ...(worked ? [el('button', { attrs: { 'aria-expanded': 'false' }, texts: ['Worked for 1m 2s'] })] : []),
      el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [reply] })] })] })] });
  const r1 = replyEl(), r2 = replyEl(), r3 = replyEl();
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [
    turnEl(T1, userEl('first'), r1), turnEl(T2, userEl('second'), r2), turnEl(T3, userEl('third'), r3, true)] })] }));
  const page = pageUnder(root, dom);
  page.send({ type: 'codex-extras-view', timestamps: true, navigation: true, userEdge: true });
  page.send({ type: 'codex-extras-user-times', times: null, compactions: [], turns: {},
    turnTimes: { [T1]: { u: [at(9, 2, 11)], r: [at(9, 2, 40)], d: 29000 }, [T2]: { u: [at(9, 4, 17)], r: [at(9, 4, 30), at(9, 5, 2)], d: 45000 },
      [T3]: { u: [at(9, 7, 0)], r: [at(9, 7, 20), at(9, 7, 41), at(9, 8, 2)], d: 62000 } } });

  const said = (host) => { const s = host.children.find((k) => k.getAttribute('data-codex-extras') === 'stamp'); return s ? s.textContent : ''; };
  eq(said(r1), '09:02:40', 'a reply with no time of Codex\'s takes the rollout\'s, the one reply of its turn');
  eq(said(r2), '', 'and a reply whose turn the rollout holds a different number of replies for gets none, rather than one that may be another\'s');
  eq(said(r3), '09:08:02', 'unless Codex\'s Worked for has folded the turn\'s earlier replies away: the reply shown takes the turn\'s last reply time');
};
