// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A turn Codex 26.1117 draws with an activity part: a turn a Stop hook continued. Its first reply and the hook's prompt
 * sit in the activity part, above Codex's "Worked for" as a plain line of text, and only the last reply is on the
 * final-reply side. The page below has the elements and data-* attributes of such a turn as a window test read them
 * off Codex 26.1117.41037; class names are left out, as the page script reads none.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const HOOKED = '01a20103-c9f9-72e1-87a8-387c5fc366e0';
const PLAIN = '0199a1b2-0000-7000-8000-000000000004';

function pageUnder(root, dom) {
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: () => {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' } };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  return { send(m) { listeners.message({ data: m }); } };
}

module.exports = async ({ eq, root }) => {
  const now = new Date();
  const at = (h, m, s, ms = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s, ms).getTime();
  const dom = createDom();
  const { el } = dom;
  const user = (turn, unit, words) => el('div', { attrs: { 'data-local-conversation-user-anchor': 'true', 'data-content-search-unit-key': `${turn}:${unit}` },
    kids: [el('div', { kids: [el('h4', { attrs: { 'data-conversation-role': 'user' }, texts: ['You said:'] }),
      el('div', { attrs: { 'data-user-message-bubble': 'true' }, kids: [el('p', { texts: [words] })] })] })] });
  const reply = (target, words) => el('div', { attrs: { 'data-response-annotation-conversation': 'c', 'data-response-annotation-target': target }, kids: [
    el('h4', { attrs: { 'data-conversation-role': 'assistant' }, texts: ['ChatGPT said:'] }), el('p', { texts: [words] }),
    el('div', { kids: [el('button', { attrs: { 'aria-label': 'More actions', 'aria-expanded': 'false' } })] })] });
  const unit = (turn, id, kid) => el('div', { attrs: { 'data-history-message-id': id, 'data-content-search-unit-key': `${turn}:${id}` }, kids: [kid] });
  const turnOf = (key, kids) => el('div', { attrs: { 'data-turn-key': `history-content:turn:${key}` }, kids: [
    el('div', { attrs: { 'data-content-search-turn-key': key }, kids: [el('div', { attrs: { 'data-spacing': 'item' }, kids })] })] });

  const plainReply = reply('item-8', 'Make the backoff cap configurable.');
  const firstReply = reply('msg_fake_3', 'Done. The cap is configurable.');
  const lastReply = reply('msg_fake_4', 'Done. The cap is configurable.');
  const hookPrompt = user(HOOKED, '2:user', 'This turn is ending with 1 row still doing.');
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [
    turnOf(PLAIN, [el('div', { kids: [user(PLAIN, 'item-7', 'Write a summary.')] }),
      el('div', { attrs: { 'data-local-conversation-final-assistant': 'true' }, kids: [unit(PLAIN, 'item-8', plainReply)] })]),
    turnOf(HOOKED, [
      el('div', { kids: [user(HOOKED, 'u1', 'How is the retry delay configured?')] }),
      el('div', { kids: [el('div', { kids: [el('div', { attrs: { 'data-spacing': 'activity' }, kids: [
        el('div', { kids: [unit(HOOKED, 'msg_fake_3', firstReply)] }),
        el('div', { attrs: { 'data-conversation-bubble': 'true' }, kids: [hookPrompt] }),
        el('div', { kids: [el('div', { kids: [el('div', { kids: [el('span', { texts: ['Worked for 2s'] })] })] })] }),
      ] })] })] }),
      el('div', { attrs: { 'data-local-conversation-final-assistant': 'true' }, kids: [unit(HOOKED, 'msg_fake_4', lastReply)] }),
    ]),
  ] })] }));
  const page = pageUnder(root, dom);
  page.send({ type: 'codex-extras-view', timestamps: true, navigation: true, userEdge: true });
  page.send({ type: 'codex-extras-user-times', times: null, compactions: [],
    turns: { [PLAIN]: 'ctx 20% · gpt-x medium', [HOOKED]: 'ctx 0% · gpt-x medium' },
    turnTimes: { [PLAIN]: { u: [at(17, 8, 29)], r: [at(17, 8, 49, 800)], d: 21000 },
      [HOOKED]: { u: [at(2, 9, 15, 328), at(2, 9, 17, 925)], r: [at(2, 9, 17, 866), at(2, 9, 17, 944)], d: 2740 } } });

  const stamp = (host) => host.children.find((k) => k.getAttribute('data-codex-extras') === 'stamp') || null;
  const said = (host) => { const s = stamp(host); return s ? s.textContent : null; };
  const line = (host) => { const s = stamp(host); return s ? s.getAttribute('data-codex-extras-figures') : null; };
  eq([said(firstReply), said(lastReply)], ['02:09:17', '02:09:17'],
    'both replies of a turn a Stop hook continued take their times from the rollout, the one in the activity part as well');
  eq([said(hookPrompt), line(firstReply)], ['02:09:17', null], 'the hook\'s prompt keeps its own time, and the turn\'s line stays off the reply in the activity part');
  eq(line(lastReply), '  ctx\u00a00%\u00a0\u00b7 gpt-\u2060x\u00a0medium',
    'the last reply has the time, then the figures, and no duration: Codex already shows "Worked for" as a line of text');
  eq(line(plainReply), '  21s\u00a0\u00b7 ctx\u00a020%\u00a0\u00b7 gpt-\u2060x\u00a0medium',
    'a turn with no activity part, where Codex shows no "Worked for", still gets its duration after the time');
};
