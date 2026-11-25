// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The page script's side of Agent Plus's pen on a plan row (src/page/codex-extras-page.js takePrefill): the text goes
 * after whatever Codex's message box holds, after a space when that does not end in one, nothing is sent, and the page
 * tells the host what it saw. The editor's insertText stands in for the browser's, appending to the box.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const posted = [], listeners = [];
  const win = {
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    location: { pathname: '/index.html', hash: '' },
  };
  let typed = [], takes = true, keys = 0;
  const editable = dom.el('div', { attrs: { contenteditable: 'true' } });
  editable.dispatchEvent = () => { keys++; return true; };
  const composer = dom.el('div', { attrs: { 'data-codex-composer': '' }, kids: [dom.el('div', { attrs: { 'data-composer-input': '' }, kids: [editable] })] });
  const holder = dom.el('div', { kids: [composer] });
  dom.setBody(dom.el('body', { kids: [holder] }));
  dom.document.execCommand = (command, ui, text) => {
    typed.push([command, text]);
    if (takes && command === 'insertText') editable.textContent = editable.textContent + text;
    return takes;
  };
  const ctx = vm.createContext(Object.assign({ globalThis: win }, dom.sandbox));
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), ctx);
  const send = (id, text) => { for (const fn of listeners) fn({ data: { type: 'codex-extras-prefill', id, text } }); };
  const replies = () => posted.filter((m) => m.kind === 'prefill').map((m) => [m.id, m.outcome]);
  const settle = () => { for (let i = 0; i < 60; i++) dom.runTimers(); };

  editable.textContent = '';
  send('a', 'About row 2 (Port it): ');
  settle();
  eq([editable.textContent, typed, replies()], ['About row 2 (Port it): ', [['insertText', 'About row 2 (Port it): ']], [['a', 'drafted']]],
    'into an empty box the text goes as it is, and the host is told it is there');

  typed = [];
  editable.textContent = 'and also';
  send('b', 'About row 1 (Pick): ');
  settle();
  eq([editable.textContent, replies().pop()], ['and also About row 1 (Pick): ', ['b', 'drafted']], 'after the user\'s own words it goes after a space, and they are kept');
  editable.textContent = 'ends in a space ';
  send('c', 'About row 3 (Ship): ');
  settle();
  eq(editable.textContent, 'ends in a space About row 3 (Ship): ', 'with no second space when the box already ends in one');
  eq(keys, 0, 'and no key is pressed, so nothing is sent');

  const count = replies().length;
  send('c', 'About row 3 (Ship): ');
  settle();
  eq([replies().length, editable.textContent], [count, 'ends in a space About row 3 (Ship): '], 'the same request posted again is taken once');

  takes = false;
  send('d', 'About row 4 (Nope): ');
  settle();
  eq(replies().pop(), ['d', 'changed'], 'a box that does not take the text is reported as changed');
  takes = true;

  holder.removeChild(composer);
  send('e', 'About row 5 (Gone): ');
  settle();
  eq(replies().pop(), ['e', 'noComposer'], 'with no message box on the page, after looking for a while, it says so');
};
