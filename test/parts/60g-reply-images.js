// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What src/page/codex-extras-page.js fixImages does to the images in a reply. An image at a web address becomes a plain
 * link whatever codexPlus.replyImages says, and the other images become "[Image]" while it is off.
 *
 * Each media element carries the props React would keep on it, in the shape Codex's markdown media component passes
 * them, since that is where the script reads the address from.
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

/* An element with the fiber chain React leaves on it: the element's own fiber, a wrapper, then Codex's media component. */
function media(dom, tag, props, attrs = {}) {
  const e = dom.el(tag, { attrs });
  const component = { memoizedProps: Object.assign({ blockRemoteMedia: false, alt: '' }, props), return: null };
  const wrapper = { memoizedProps: { allowWide: false, label: props.alt || '' }, return: component };
  e['__reactFiber$test'] = { stateNode: e, memoizedProps: { src: 'data:image/png;base64,AAAA' }, return: wrapper };
  return e;
}

module.exports = async ({ eq, root }) => {
  const dom = createDom();
  const page = pageUnder(root, dom);
  const local = media(dom, 'img', { src: '/home/u/.codex/scratch/-repo/01a1/chart.png', alt: 'the chart' }, { src: 'data:image/png;base64,AAAA' });
  const inline = media(dom, 'img', { src: 'data:image/png;base64,BBBB', alt: '' }, { src: 'data:image/png;base64,BBBB' });
  const blocked = media(dom, 'button', { src: 'https://example.com/logo.png', alt: 'the logo' }, { disabled: '', type: 'button' });
  const loaded = media(dom, 'img', { src: 'https://cdn.example.org/plot.svg', alt: '' }, { src: 'https://cdn.example.org/plot.svg' });
  const plain = dom.el('img', { attrs: { src: 'data:image/png;base64,CCCC', alt: 'no props' } });
  const reply = dom.el('div', { attrs: { 'data-response-annotation-target': '' }, kids: [
    dom.el('p', { kids: [local] }), dom.el('p', { kids: [inline] }), dom.el('p', { kids: [blocked] }), dom.el('p', { kids: [loaded] }),
    dom.el('p', { kids: [plain] })] });
  const scroller = dom.el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 700 }, kids: [reply] });
  dom.setBody(dom.el('body', { kids: [scroller] }));

  const stand = (el) => {
    const n = el.nextElementSibling;
    return n && n.getAttribute('data-codex-extras') === 'img-stand'
      ? [n.tagName.toLowerCase(), n.textContent, n.title, n.getAttribute('href')] : null;
  };
  const hidden = (el) => el.hasAttribute('data-codex-extras-img-hidden');
  const read = () => [local, inline, blocked, loaded, plain].map((e) => [hidden(e), stand(e)]);

  page.view();
  eq(read(), [
    [false, null],
    [false, null],
    [true, ['a', 'the logo', 'https://example.com/logo.png', 'https://example.com/logo.png']],
    [true, ['a', 'https://cdn.example.org/plot.svg', 'https://cdn.example.org/plot.svg', 'https://cdn.example.org/plot.svg']],
    [false, null],
  ], 'with images on, a local file and a data: URL stay as Codex draws them, and an image at a web address, blocked or loaded, '
    + 'becomes a plain link named by its alt text or else its address');
  page.view();
  eq(reply.querySelectorAll('[data-codex-extras="img-stand"]').length, 2, 'another pass adds nothing more');

  page.view({ replyImages: false });
  eq(read(), [
    [true, ['span', '[Image]', '/home/u/.codex/scratch/-repo/01a1/chart.png', null]],
    [true, ['span', '[Image]', 'An image written into the reply', null]],
    [true, ['a', 'the logo', 'https://example.com/logo.png', 'https://example.com/logo.png']],
    [true, ['a', 'https://cdn.example.org/plot.svg', 'https://cdn.example.org/plot.svg', 'https://cdn.example.org/plot.svg']],
    [false, null],
  ], 'with images off, the others become "[Image]" with the path in the hover, and an element whose props cannot be read is left alone');

  local.parentNode.removeChild(local);
  page.view({ replyImages: false });
  eq(reply.querySelectorAll('[data-codex-extras="img-stand"]').length, 3, 'a stand-in whose image Codex took away goes with it');

  page.view({ replyImages: true });
  eq([hidden(inline), stand(inline)], [false, null], 'turned on again, Codex\'s own drawing of an image comes back');

  page.view({ buttons: false });
  eq([reply.querySelectorAll('[data-codex-extras="img-stand"]').length, reply.querySelectorAll('[data-codex-extras-img-hidden]').length,
    dom.document.head.querySelectorAll('style[data-codex-extras="img-stand"]').length], [0, 0, 0],
  'with the additions off, nothing of this is left in the page');
};
