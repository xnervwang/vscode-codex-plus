// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The plan bar in Codex's page (src/page/codex-extras-page.js), on the stand-in DOM: drawn by Agent Plus's shared
 * fragment from the summary the host sends, on <body> just above the message box. The window test (test/vscode/ui.js)
 * checks the bar on Codex's own page in a real VS Code window.
 */
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const BOX = { top: 602, left: 8, width: 1084, height: 142 };

function page(root) {
  const dom = createDom();
  const { el } = dom;
  const box = el('div', { attrs: { 'data-codex-composer-root': '' }, rect: Object.assign({}, BOX) });
  const body = el('body', { kids: [box] });
  dom.setBody(body);
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  return { dom, box, body, posted, q, send(m) { listeners.message({ data: m }); }, resize() { if (listeners.resize) listeners.resize(); } };
}

const SUMMARY = { total: 5, done: 2, counts: { discussing: 0, todo: 2, doing: 1, waiting: 0, parked: 0, done: 2 },
  current: { number: '3.2', title: 'CLI: budget subcommand with set, list and remove', state: 'doing', dim: false }, allDone: false, questions: 0,
  open: [{ number: '3', title: 'CLI', state: 'todo', depth: 1 }, { number: '3.2', title: 'CLI: budget subcommand with set, list and remove', state: 'doing', depth: 2 },
    { number: '4', title: 'Docs', state: 'todo', depth: 1 }] };
const bar = (m) => Object.assign({ type: 'codex-extras-plan-bar', on: true, summary: SUMMARY }, m);
const click = (e) => e.dispatch('click', { stopPropagation() {}, preventDefault() {} });

module.exports = async ({ eq, root }) => {
  const p = page(root);
  const drawn = () => p.q('[data-codex-extras="plan-bar"]')[0] || null;
  const sheet = () => (p.q('[data-codex-extras="style"]')[0] || { textContent: '' }).textContent;
  const room = () => /\[data-codex-composer-root\]\{margin-top:32px !important;\}/.test(sheet());
  const barStyle = () => p.q('style[data-agent-plus-plan-bar-style]').length;
  p.send({ type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false });
  eq(drawn(), null, 'with no summary from the host there is no plan bar');

  p.send(bar());
  const b = drawn();
  eq([!!b, b && b.parentNode === p.body, b && b.getAttribute('data-agent-plus-plan-bar'), b && b.style.display],
    [true, true, '1', ''], 'a summary draws the bar with Agent Plus\'s fragment, on the page\'s body rather than inside anything of Codex\'s');
  eq(b && [b.style.top, b.style.left, b.style.width], [`${BOX.top - 32}px`, `${BOX.left}px`, `${BOX.width}px`],
    'just above the message box, 6 px clear of it, and as wide as it');
  eq([room(), barStyle()], [true, 1], 'and the box is given 32 px more top margin, the bar\'s height and its gap, so it covers nothing above the box');
  eq(/position:fixed;z-index:25;/.test(b.style.cssText), true, 'it sits on Codex\'s content and under every overlay Codex draws, as the row below the box does');
  eq([b.getAttribute('data-compact'), b.querySelectorAll('.apb-count')[0].textContent, /3\.2 CLI: budget/.test(b.textContent), b.querySelectorAll('.apb-q').length],
    ['0', '3 open', true, 0], 'drawn full: the open rows and the current one, and no red part with no question waiting');

  p.send(bar({ summary: Object.assign({}, SUMMARY, { questions: 2 }) }));
  const red = drawn().querySelectorAll('.apb-q')[0];
  eq(red && red.textContent, '2 to decide', 'questions waiting for the user add the red part');
  p.posted.length = 0;
  click(red);
  click(drawn());
  eq(p.posted.filter((m) => m.kind === 'planBar'), [{ type: 'codex-extras', kind: 'planBar', action: 'answer' }, { type: 'codex-extras', kind: 'planBar', action: 'open' }],
    'a click on the red part asks for the Answer view and one on the bar for the plan, sending only which part was clicked');

  p.box.rect = Object.assign({}, BOX, { left: 4, width: 300 });
  p.resize();
  eq([drawn().getAttribute('data-compact'), drawn().style.width, (drawn().querySelectorAll('.apb-q')[0] || {}).textContent],
    ['1', '300px', '2'], 'a box narrower than COMPACT_BELOW gets the compact bar, still as wide as the box');
  p.box.rect = Object.assign({}, BOX);
  p.resize();
  eq(drawn().getAttribute('data-compact'), '0', 'and a wide one the full bar again');

  const first = drawn();
  first.remove();
  p.send({ type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false });
  eq([drawn() === first, drawn() && drawn().parentNode === p.body, drawn() && drawn().style.top], [true, true, `${BOX.top - 32}px`],
    'a bar a redraw took off the page is put back on the next pass');
  p.box.rect = Object.assign({}, BOX, { top: 540, height: 204 });
  p.resize();
  eq(drawn().style.top, '508px', 'and the bar follows the box when it grows with what is typed');
  p.box.rect = Object.assign({}, BOX);
  p.resize();

  p.send(bar({ summary: { total: 0, done: 0, counts: {}, current: null, allDone: true, questions: 0, open: [] } }));
  eq([!!drawn(), /All rows done/.test(drawn().textContent), drawn().querySelectorAll('.apb-count')[0].textContent],
    [true, true, ''], 'a plan with no open row says so, with no count');

  p.send(bar({ summary: null }));
  eq([drawn(), room(), barStyle()], [null, false, 0], 'a conversation with no plan has no bar, no room for one and no style of it left');
  p.send(bar());
  eq(!!drawn() && room(), true, 'and the bar comes back with the next summary');
  p.send(bar({ on: false, summary: null }));
  eq([drawn(), room()], [null, false], 'the bar turned off takes it away');
  p.send(bar());
  p.send({ type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false, buttons: false });
  eq(drawn(), null, 'and so does Codex Plus turned off, even before the host\'s next summary');
  p.send({ type: 'codex-extras-view', timestamps: false, navigation: false, userColor: '', userEdge: false });
  eq(!!drawn(), true, 'turned on again it is back');
  p.box.remove();
  p.resize();
  eq([drawn(), room()], [null, false], 'a page with no message box has no bar');
};
