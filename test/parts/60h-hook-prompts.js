// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * foldHooks (src/page/codex-extras-page.js) reads hookFeedback from React's props, so each bubble here carries a fiber
 * chain ending in the message item Codex renders.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

function pageUnder(root, dom) {
  const listeners = {};
  const win = {
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
    addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' },
  };
  const ctx = vm.createContext(Object.assign({ globalThis: win }, dom.sandbox));
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), ctx);
  return {
    view(over = {}) {
      listeners.message({ data: Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over) });
    },
  };
}

function message(dom, key, text, item) {
  const bubble = dom.el('div', { attrs: { 'data-user-message-bubble': 'true' }, kids: [
    dom.el('div', { attrs: { 'data-markdown-text-tone': 'user-message' }, kids: [dom.el('p', { texts: [text] })] })] });
  const component = { memoizedProps: { item: Object.assign({ type: 'user-message', message: text }, item) }, return: null };
  bubble['__reactFiber$test'] = { stateNode: bubble, memoizedProps: { className: '' }, return: { memoizedProps: { text }, return: component } };
  const anchor = dom.el('div', { attrs: { 'data-local-conversation-user-anchor': 'true', 'data-content-search-unit-key': `${key}:user` }, kids: [bubble] });
  return { anchor, bubble };
}

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const page = pageUnder(root, dom);
  const asked = message(dom, 't1', 'Draw the chart.', {});
  const hook = message(dom, 't1b', 'The summary of this conversation has not been written, and the plan has rows.', { hookFeedback: true });
  const notice = message(dom, 't1c', 'Codex Plus notice, not a message from the user: a command this conversation left running detached is no longer running.', {});
  const turn = dom.el('div', { attrs: { 'data-turn-key': 'history-content:turn:t1' }, kids: [asked.anchor, hook.anchor, notice.anchor] });
  const scroller = dom.el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 700 }, kids: [turn] });
  dom.setBody(dom.el('body', { kids: [scroller] }));

  const state = () => [asked.bubble, hook.bubble].map((b) => [b.getAttribute('data-codex-extras-hook'), b.classList.contains('codex-extras-user-edge')]);
  const sheets = () => dom.document.head.querySelectorAll('style[data-codex-extras="hook-fold"]').length;

  page.view();
  eq(state(), [[null, true], ['fold', false]],
    "the hook's prompt is folded and has no user edge, and the user's own message is left as it is with its edge");
  eq(notice.bubble.getAttribute('data-codex-extras-hook'), 'fold', 'the notice this extension sends a conversation as a user message is folded the same way');
  eq(sheets(), 1, 'one stylesheet does the folding');
  const sheet = dom.document.head.querySelector('style[data-codex-extras="hook-fold"]').textContent;
  const colourRules = sheet.split('}').map((r) => r.split('{')).filter(([sel, body]) => sel && /(^|;)color:/.test(body || '')).map(([sel]) => sel);
  const coloured = (bubble) => { const text = bubble.querySelector('[data-markdown-text-tone]'); return colourRules.some((sel) => text.matches(sel)); };
  eq([coloured(hook.bubble), coloured(asked.bubble)], [true, false],
    "the dim colour is given to the prompt's text itself, inside Codex's markdown, and not to the user's own message");

  hook.bubble.dispatch('click', {});
  eq(hook.bubble.getAttribute('data-codex-extras-hook'), 'open', 'a click shows the whole prompt');
  page.view();
  eq(hook.bubble.getAttribute('data-codex-extras-hook'), 'open', 'and it stays open through the next pass');
  hook.bubble.dispatch('click', {});
  eq(hook.bubble.getAttribute('data-codex-extras-hook'), 'fold', 'another click folds it again');
  asked.bubble.dispatch('click', {});
  eq(asked.bubble.getAttribute('data-codex-extras-hook'), null, "a click on the user's own message changes nothing");

  page.view({ buttons: false });
  eq([state(), sheets()], [[[null, true], [null, true]], 0], 'with the additions off, nothing of this is left in the page');
  hook.bubble.dispatch('click', {});
  eq(hook.bubble.getAttribute('data-codex-extras-hook'), null, 'and a click on it then does nothing');
};
