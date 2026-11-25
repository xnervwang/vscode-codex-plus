// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Other conversations named in a reply, drawn as links by the page script (codexPlus.conversationLinks). A title in
 * corner brackets, a whole title standing on its own and a session id each become a link. The conversation the page
 * shows, code blocks and a reply still being written are left alone. A click asks the host to open the conversation,
 * a link that a redraw of Codex's drops comes back, and with the setting off no link is left.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const T1 = '019a6a10-0000-7000-8000-0000000000d1';
const T2 = '019a6a10-0000-7000-8000-0000000000d2';
const T3 = '019a6a10-0000-7000-8000-0000000000d3';
const SELF = '019a6a20-1111-7000-8000-000000000001';
const A = '7c1e2d3f-2222-7000-8000-000000000002';
const B = '019a6a20-3333-7000-8000-000000000003';
const C = 'c0ffee42-4444-7000-8000-000000000004';
const MENTION = 'data-agent-plus-mention';

/* The test moves the page's clock forward, because a newly finished reply is linked only some time after the pass
   that found it. */
let skew = 0;
class Clock extends Date {
  constructor(...a) { if (a.length) super(...a); else super(Date.now() + skew); }
  static now() { return Date.now() + skew; }
}

function pageUnder(root, dom) {
  const listeners = {}, posted = [];
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerWidth: 1200, innerHeight: 800 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(),
    vm.createContext(Object.assign({ globalThis: win }, dom.sandbox, { Date: Clock })));
  return { send(m) { listeners.message({ data: m }); }, posted };
}

module.exports = async ({ eq, root }) => {
  const now = Date.now();
  const dom = createDom();
  const { el } = dom;
  const userEl = (words) => el('div', { attrs: { 'data-local-conversation-user-anchor': '', 'data-content-search-unit-key': 'u' },
    kids: [el('div', { attrs: { 'data-user-message-bubble': '' }, kids: [el('p', { texts: [words] })] })] });
  const replyEl = (...kids) => el('div', { attrs: { 'data-response-annotation-target': '' }, kids });
  const turnEl = (key, user, ...replies) => el('div', { attrs: { 'data-turn-key': key }, kids: [el('div', { attrs: { 'data-content-search-turn-key': key },
    kids: [el('div', { kids: [user, el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: replies })] })] })] });

  const p1 = el('p', { texts: ['See 「回归测试 CSV和 JSON」, and 「整理发布说明的草稿」 here.'] });
  const pre1 = el('pre', { kids: [el('code', { texts: ['echo 「回归测试 CSV和 JSON」 ' + C] })] });
  const r1 = replyEl(p1, pre1);
  let p2 = el('p', { texts: ['Fix the retry delay in the uploader landed yesterday.'] });
  const r2 = replyEl(p2);
  const p3a = el('p', { texts: [`It started in ${C}, and `] , kids: [el('code', { texts: [`${C.slice(0, 8)}`] })] });
  const r3a = replyEl(p3a);
  const p3b = el('p', { texts: ['Next: 「回归测试 CSV和 JSON」'] });
  const r3b = replyEl(p3b);
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [
    turnEl(T1, userEl('first'), r1), turnEl(T2, userEl('second'), r2), turnEl(T3, userEl('third'), r3a, r3b)] })] }));
  const page = pageUnder(root, dom);
  page.send({ type: 'codex-extras-view', timestamps: true, navigation: false, userEdge: false, buttons: true });
  /* While the last turn runs, the rollout holds its first reply but not yet the one being written. */
  const times = (replies3, ended3) => ({ type: 'codex-extras-user-times', times: null, compactions: [], turns: {},
    turnTimes: { [T1]: { u: [now - 9e5], r: [now - 8e5], d: 9000 }, [T2]: { u: [now - 7e5], r: [now - 6e5], d: 9000 },
      [T3]: { u: [now - 5e5], r: replies3.map((k) => now - 4e5 + k), ...(ended3 ? { e: true } : {}) } } });
  page.send(times([1]));
  const list = [
    { sourceId: 'codex', label: 'Codex', sessionId: SELF, title: '整理发布说明的草稿', lastActiveAt: now },
    { sourceId: 'claude-code', label: 'Claude Code', sessionId: A, title: '回归测试 CSV和 JSON', lastActiveAt: now - 120000 },
    { sourceId: 'codex', label: 'Codex', sessionId: B, title: 'Fix the retry delay in the uploader', lastActiveAt: now - 3600000 },
    { sourceId: 'codex', label: 'Codex', sessionId: C, title: 'Profile the cold start', lastActiveAt: now - 60000 },
  ];
  const links = () => dom.document.querySelectorAll(`[${MENTION}]`);
  const linkTo = (n) => n.querySelectorAll(`[${MENTION}]`).map((a) => `${a.getAttribute(MENTION)}=${a.textContent}`);
  eq(links().length, 0, 'before the host sends the conversations, nothing is linked');

  const later = () => { skew += 1000; dom.runTimers(); };
  page.send({ type: 'codex-extras-conversations', on: true, list, self: { sessionId: SELF, title: list[0].title } });
  eq(links().length, 0, 'a reply is not linked on the pass that first finds it finished, while Codex may still be drawing it for the last time');
  later();
  eq(linkTo(p1), [`claude-code:${A}=回归测试 CSV和 JSON`],
    'a title in corner brackets is a link to its conversation, and the title of the conversation the page shows is not');
  eq(p1.textContent, 'See 「回归测试 CSV和 JSON」, and 「整理发布说明的草稿」 here.',
    'and the reply reads as it did');
  eq(linkTo(pre1), [], 'nothing in a code block is linked');
  eq(linkTo(p2), [`codex:${B}=Fix the retry delay in the uploader`], 'a whole title standing on its own is a link');
  eq(linkTo(p3a), [`codex:${C}=${C}`, `codex:${C}=${C.slice(0, 8)}`],
    'a session id is a link, whole or by its first 8 characters in inline code, in a reply the rollout already holds');
  eq(linkTo(p3b), [], 'the reply still being written is left alone');

  page.send(times([1, 2]));
  later();
  eq(linkTo(p3b), [`claude-code:${A}=回归测试 CSV和 JSON`], 'and is linked once the rollout holds it');

  const link = p1.querySelectorAll(`[${MENTION}]`)[0];
  eq([link.getAttribute('role'), link.getAttribute('tabindex'), link.getAttribute('data-codex-extras')], ['link', '0', 'convo-link'],
    'a link is one of this script\'s own elements, taken as a link by the keyboard and a screen reader');
  const sheet = dom.document.head.querySelectorAll('style').map((s) => s.textContent).join('');
  eq(/\[data-codex-extras="convo-link"\]\{[^}]*color:var\(--vscode-textLink-foreground/.test(sheet), true, 'and is drawn in the theme\'s link colour');

  link.dispatch('mouseenter', {});
  const label = dom.document.querySelectorAll('[data-codex-extras="label"]')[0];
  eq(!!label && /^回归测试 CSV和 JSON\nClaude Code conversation 7c1e2d3f, active 2m ago$/.test(label.textContent), true,
    'hovering it shows the conversation, its agent and when it was last active, in the page\'s own label');
  link.dispatch('mouseleave', {});
  eq(dom.document.querySelectorAll('[data-codex-extras="label"]').length, 0, 'and leaving it takes the label away');

  let stopped = false;
  link.dispatch('click', { preventDefault() {}, stopPropagation() { stopped = true; } });
  eq([page.posted.filter((m) => m.kind === 'openConversation').pop(), stopped],
    [{ type: 'codex-extras', kind: 'openConversation', sourceId: 'claude-code', sessionId: A }, true],
    'a click asks the host to open that conversation by its agent and id alone, and goes no further in Codex\'s page');

  /* Codex draws the reply again with nodes of its own. */
  const fresh = el('p', { texts: ['Fix the retry delay in the uploader landed yesterday.'] });
  r2.removeChild(p2);
  r2.appendChild(fresh);
  p2 = fresh;
  dom.fire(dom.takeMutations());
  dom.runTimers();
  eq(linkTo(p2), [`codex:${B}=Fix the retry delay in the uploader`], 'a link Codex\'s redraw dropped is put back on the next pass');
  dom.takeMutations();
  dom.fire([{ type: 'childList', target: r2 }]);
  dom.runTimers();
  const wrote = dom.takeMutations().filter((m) => [r1, r2, r3a, r3b].some((r) => r.contains(m.target)));
  eq([wrote.length, links().length], [0, 5], 'and a pass over replies already linked writes nothing into them');

  page.send({ type: 'codex-extras-conversations', on: true, list: list.filter((c) => c.sessionId !== B), self: { sessionId: SELF, title: list[0].title } });
  eq([linkTo(p2), p2.textContent], [[], 'Fix the retry delay in the uploader landed yesterday.'],
    'a conversation gone from the list loses its links');

  page.send({ type: 'codex-extras-conversations', on: false, list: [], self: { sessionId: SELF, title: '' } });
  eq([links().length, p1.textContent, p3a.textContent], [0, 'See 「回归测试 CSV和 JSON」, and 「整理发布说明的草稿」 here.',
    `It started in ${C}, and ${C.slice(0, 8)}`], 'with the setting off no link is left, and the replies read as before');
  eq(p1.childNodes.filter((n) => n.nodeType === 3).length, 1, 'with the text a link took joined back to the words around it');

  page.send({ type: 'codex-extras-conversations', on: true, list, self: { sessionId: SELF, title: list[0].title } });
  eq(linkTo(p1), [`claude-code:${A}=回归测试 CSV和 JSON`], 'and turned on again, the title in brackets is found again');

  /* A stopped turn: it ended before its last reply reached the rollout. */
  const p4 = el('p', { texts: ['Stopped before 「回归测试 CSV和 JSON」'] });
  r3b.appendChild(p4);
  page.send(times([1], true));
  eq(linkTo(p4), [`claude-code:${A}=回归测试 CSV和 JSON`], 'a reply of a turn that has ended is linked even when the rollout holds fewer replies');
};
