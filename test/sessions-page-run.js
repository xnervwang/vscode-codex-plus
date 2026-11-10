// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs src/page/sessions-page.js on the stand-in DOM of test/fake-dom.js, in a window `width` by `height` pixels, with
 * the webview API recording what the page posts. `toWindow(type, event)` hands an event to the page's window listeners
 * (message, blur, resize).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./fake-dom');

function runSessionsPage(root, { width = 400, height = 800 } = {}) {
  const dom = createDom();
  const page = dom.el('div', { attrs: { id: 'root' } });
  dom.setBody(dom.el('body', { kids: [page] }));
  const posted = [];
  const listeners = {};
  const win = { innerWidth: width, innerHeight: height, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  const sandbox = Object.assign({}, dom.sandbox, { window: win, Map, Set, Proxy, Promise,
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => null, setState() {} }) });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.js'), 'utf8'), sandbox);
  const toWindow = (type, e = {}) => { for (const fn of listeners[type] || []) fn(Object.assign({ type }, e)); };
  return { dom, page, posted, win, toWindow, toPage: (data) => toWindow('message', { data }),
    $: (sel) => page.querySelector(sel), $$: (sel) => page.querySelectorAll(sel) };
}

module.exports = { runSessionsPage };
