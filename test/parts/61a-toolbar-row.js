// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The information and chime buttons, placed after the permissions button in Codex's message-box toolbar. The toolbar is
 * built as Codex 26.1021 renders it (test/render measured it): a grid holding a group on the left with the add-context
 * and permissions buttons, and one on the right with the model picker, each group a flex row and each button known by
 * its data-composer-navigation-target or data-codex-intelligence-trigger. The left column is as wide as its content and
 * the right group is pushed to the right, so a node added after the permissions button moves none of Codex's buttons
 * while the gap between the groups holds it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const FLEX = { display: 'flex' }, CONTENTS = { display: 'contents' };
const ICON_CLASS = 'no-drag cursor-interaction rounded-full text-tertiary h-token-button-composer aspect-square';

/* Codex's message box with its toolbar row; `rightAt` is where the right group starts, which sets the width of the gap
   between the two groups. */
function toolbar(dom, { rightAt = 799, meter = false, squeeze = false } = {}) {
  const { el } = dom;
  const add = el('button', { attrs: { type: 'button', 'aria-label': 'Add files and more', 'data-composer-navigation-target': 'add-context' },
    class: ICON_CLASS, rect: { top: 708, left: 16, width: 28, height: 28 }, kids: [el('svg', { rect: { top: 714, left: 22, width: 16, height: 16 } })] });
  const perm = el('button', { attrs: { type: 'button', 'aria-label': 'Change permissions', 'data-composer-navigation-target': 'permissions' },
    class: 'no-drag cursor-interaction rounded-full text-tertiary h-token-button-composer', rect: { top: 708, left: 49, width: 119, height: 28 } });
  const left = el('div', { class: 'flex min-w-0 items-center gap-[5px]', computed: FLEX, rect: { top: 708, left: 16, width: 152, height: 28 },
    kids: [el('span', { computed: CONTENTS, kids: [add] }), perm] });
  const trigger = el('button', { attrs: { type: 'button', 'data-codex-intelligence-trigger': 'true' }, rect: { top: 708, left: rightAt + 20, width: 121, height: 28 } });
  const modelSlot = el('span', { rect: { top: 708, left: rightAt + 20, width: 121, height: 28 }, kids: [el('span', { computed: CONTENTS, kids: [trigger] })] });
  const ide = el('span', { class: 'flex items-center gap-1', rect: { top: 708, left: rightAt + 145, width: 104, height: 28 } });
  const codexMeter = meter ? el('span', { class: 'text-sm', rect: { top: 713, left: rightAt, width: 16, height: 18 },
    kids: [el('span', { attrs: { role: 'img', 'aria-label': `Context usage: ${meter}%` }, rect: { top: 715, left: rightAt, width: 16, height: 16 } })] }) : null;
  const right = el('div', { class: 'flex min-w-0 items-center gap-1', computed: FLEX, rect: { top: 708, left: rightAt, width: 1048 - rightAt, height: 28 },
    kids: [...(codexMeter ? [codexMeter] : []), modelSlot, ide] });
  if (!meter) modelSlot.rect.left = rightAt;
  const send = el('button', { attrs: { type: 'button', 'aria-label': 'Send' }, rect: { top: 708, left: 1056, width: 28, height: 28 } });
  const editor = el('div', { attrs: { role: 'textbox', 'data-codex-composer': 'true', contenteditable: 'true' }, rect: { top: 660, left: 20, width: 1060, height: 44 } });
  const grid = el('div', { attrs: { 'data-composer-footer-responsive': '', 'data-composer-rows': 'stacked' }, computed: { display: 'grid' },
    rect: { top: 660, left: 8, width: 1084, height: 76 },
    kids: [el('div', { kids: [el('div', { attrs: { 'data-composer-input': '' }, kids: [editor] })] }),
      el('div', { kids: [left] }), el('div', { kids: [el('div', { computed: FLEX, kids: [el('div', { computed: FLEX, kids: [right] }), el('div', { kids: [send] })] })] })] });
  const root = el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 602, left: 8, width: 1084, height: 142 }, kids: [grid] });
  /* The right group wider than the box that holds it: how a row out of room looks while the gap between the groups
     still measures wide enough. */
  if (squeeze) { right.parentElement.clientWidth = 200; right.parentElement.scrollWidth = 260; }
  return { root, add, perm, left, right, modelSlot, trigger, ide, send, editor, codexMeter };
}

function page(root, build) {
  const dom = createDom();
  const box = build(dom);
  const activity = dom.el('div', { attrs: { 'data-request-input-activity-root': '' }, kids: [box.root] });
  dom.setBody(dom.el('body', { kids: [activity] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760, innerWidth: 1100 };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  /* One pass of the watcher over the message box, as after Codex redraws something in it. */
  const pass = () => { dom.fire([{ type: 'childList', target: box.root }]); dom.runTimers(); };
  return { dom, box, posted, q, pass, send(m) { listeners.message({ data: m }); },
    view(over = {}) { this.send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over)); } };
}

module.exports = async ({ eq, root }) => {
  {
    const p = page(root, (dom) => toolbar(dom));
    p.view();
    const tools = p.q('[data-codex-extras="tools"]')[0];
    const buttons = p.q('[data-codex-extras="bar-button"]');
    eq([!!tools, tools && tools.parentNode === p.box.left, tools && tools.previousElementSibling === p.box.perm, buttons.length,
      buttons.every((b) => tools && tools.contains(b))], [true, true, true, 2, true],
    'the information and chime buttons go into Codex\'s toolbar row, straight after its permissions button');
    eq(p.q('[data-codex-extras="bar"]').length, 0, 'and with them there, no row of this script\'s own is drawn below the message box');
    eq([buttons.map((b) => b.tagName), buttons.map((b) => b.getAttribute('type')), buttons.map((b) => b.getAttribute('tabindex')),
      buttons.map((b) => b.className === ICON_CLASS)],
    [['BUTTON', 'BUTTON'], ['button', 'button'], ['-1', '-1'], [true, true]],
    'each is a button with the classes of Codex\'s own add-context button, so it has that button\'s size, colour and hover, and is left out of the Tab order');
    eq(buttons.map((b) => b.querySelectorAll('svg').length), [1, 1], 'each carries its drawn glyph');

    /* Pressing one keeps the caret in Codex's message box, and a click on one goes no further than the button. */
    let prevented = 0, stopped = 0;
    buttons[0].dispatch('mousedown', { preventDefault() { prevented++; } });
    buttons[1].dispatch('click', { stopPropagation() { stopped++; } });
    eq([prevented, stopped, p.posted.filter((m) => m.kind === 'toggleChime').length], [1, 1, 1],
      'a press does not take the focus from the message box, and a click stops at the button and does its own thing only');

    /* Codex redrawing the left group drops what this script added to it; the next pass puts it back in the same place. */
    tools.remove();
    p.pass();
    const back = p.q('[data-codex-extras="tools"]')[0];
    eq([!!back, back && back.previousElementSibling === p.box.perm], [true, true], 'buttons Codex\'s redraw took out are put back after its permissions button');
    /* Something Codex adds after its permissions button pushes this script's buttons away from it; they are moved back. */
    const chip = p.dom.el('button', { attrs: { 'data-composer-navigation-target': 'some-chip' }, rect: { top: 708, left: 170, width: 40, height: 28 } });
    p.box.left.insertBefore(chip, p.box.perm.nextSibling);
    p.pass();
    eq([p.q('[data-codex-extras="tools"]')[0].previousElementSibling === p.box.perm, p.box.left.children.slice(-1)[0] === chip], [true, true],
      'and moved back next to it when Codex puts something of its own between them');
    const before = p.dom.takeMutations().length;
    p.pass();
    eq(p.dom.takeMutations().length - before <= 0, true, 'a pass that finds them in place changes nothing in Codex\'s tree');

    p.view({ chimeButton: false });
    eq(p.q('[data-codex-extras="bar-button"]').map((b) => /About this conversation/.test(b.getAttribute('aria-label'))), [true],
      'codexPlus.chimeButton off leaves the information button alone');
    p.view({ infoButton: false });
    eq(p.q('[data-codex-extras="bar-button"]').map((b) => /chime/i.test(b.getAttribute('aria-label'))), [true],
      'codexPlus.infoButton off leaves the chime button alone');
    p.view({ infoButton: false, chimeButton: false, contextMeter: false });
    eq(p.q('[data-codex-extras="tools"]').length + p.q('[data-codex-extras="bar-button"]').length, 0, 'both off, neither is drawn');
    p.view({ buttons: false });
    eq(p.q('[data-codex-extras="tools"]').length + p.q('[data-codex-extras="bar"]').length, 0, 'and the master switch off draws neither');
  }
  {
    /* The room between the groups is less than the buttons need: they go below the message box instead, as before. */
    const p = page(root, (dom) => toolbar(dom, { rightAt: 172 }));
    p.view();
    const bar = p.q('[data-codex-extras="bar"]')[0];
    eq([p.q('[data-codex-extras="tools"]').filter((t) => t.parentNode === p.box.left).length, !!bar, bar && bar.parentNode === p.dom.document.body,
      bar && p.q('[data-codex-extras="bar-button"]').every((b) => bar.contains(b))], [0, true, true, true],
    'where the toolbar has no room for them they are not squeezed in: they sit in the row below the message box');
    eq([/pointer-events:none/.test(bar.style.cssText), p.q('[data-codex-extras="bar-button"]').every((b) => /pointer-events:auto/.test(b.style.cssText))],
      [true, true], 'and that row takes no clicks, only its buttons do');
  }
  {
    /* The gap measures wide enough, but with the buttons added Codex's right group overflows the box that holds it and
       its buttons end up over the send button, so this also counts as no room. */
    const p = page(root, (dom) => toolbar(dom, { squeeze: true }));
    p.view();
    const bar = p.q('[data-codex-extras="bar"]')[0];
    eq([!!bar, p.q('[data-codex-extras="tools"]').filter((t) => t.parentNode === p.box.left).length], [true, 0],
      'a right group pushed past the box that holds it counts as no room, and the buttons go below the message box');
    p.dom.takeMutations();
    p.pass(); p.pass();
    eq(p.dom.takeMutations().filter((m) => !(m.target.closest && m.target.closest('[data-codex-extras]'))).length, 0,
      'and the passes after that do not try the row again at the same width, so Codex\'s tree is left still');
  }
};
