// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The two buttons in the row below Codex's message box: the conversation's session information, and the chime on or
 * off. The message box is built as Codex 26.1021's composer-controls bundle renders its root (data-codex-composer-root,
 * a name in the real layout sample's data-* list), measured where a live page would put it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

function page(root, { box = true } = {}) {
  const dom = createDom();
  const kids = box ? [dom.el('div', { attrs: { 'data-codex-composer-root': '' }, rect: { top: 600, left: 40, width: 700, height: 120 } })] : [];
  dom.setBody(dom.el('body', { kids: [dom.el('div', { kids })] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' }, innerHeight: 760 };
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const q = (sel) => dom.document.root.querySelectorAll(sel);
  return { dom, posted, q, send(m) { listeners.message({ data: m }); },
    view(over = {}) { this.send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userColor: '', userEdge: true }, over)); } };
}

module.exports = async ({ eq, tmp, root }) => {
  const SECRET = '/home/someone/private-project';
  {
    const p = page(root);
    p.view();
    const bar = p.q('[data-codex-extras="bar"]')[0];
    const buttons = p.q('[data-codex-extras="bar-button"]');
    eq([!!bar, buttons.length, bar && bar.style.top, bar && bar.style.left, bar && bar.parentNode === p.dom.document.body],
      [true, 2, '722px', '40px', true], 'two buttons sit in a row of this script\'s own just below the message box, on the body');
    eq([/pointer-events:none/.test(bar.style.cssText), buttons.every((b) => /pointer-events:auto/.test(b.style.cssText))], [true, true],
      'the row takes no clicks, only its two buttons do');
    eq([buttons[1].textContent, buttons[1].style.textDecoration, buttons.map((b) => b.getAttribute('title'))], ['\u266a', 'none', [null, null]],
      'the chime button is a plain note while chimes are on, in one colour like Codex\'s own icons, and neither button has a native title');
    p.view({ chime: false });
    const muted = p.q('[data-codex-extras="bar-button"]')[1];
    eq([muted.textContent, muted.style.textDecoration, /turn them on/.test(muted.getAttribute('aria-label'))], ['\u266a', 'line-through', true],
      'and the same note struck through, saying how to turn them on, while they are off');
    muted.dispatch('mouseenter', {});
    const label = p.q('[data-codex-extras="label"]');
    eq([label.length, label[0] && /turn them on/.test(label[0].textContent)], [1, true], 'hovering it draws a label of this script\'s own');
    muted.dispatch('mouseleave', {});
    eq(p.q('[data-codex-extras="label"]').length, 0, 'which goes when the pointer leaves');
    eq([/z-index:25;/.test(bar.style.cssText)], [true], 'the row sits above Codex\'s content and below the lowest layer of its overlays, z-30');
    p.q('[data-codex-extras="bar-button"]')[1].dispatch('click', { stopPropagation() {} });
    eq(p.posted.filter((m) => m.kind === 'toggleChime').length, 1, 'clicking it asks the host to switch the setting');

    p.q('[data-codex-extras="bar-button"]')[0].dispatch('click', { stopPropagation() {} });
    const ask = p.posted.filter((m) => m.kind === 'infoAsk')[0];
    eq(!!(ask && ask.id), true, 'the information button asks the host for the conversation\'s rows');
    p.send({ type: 'codex-extras-info', id: ask.id, rows: [{ label: 'Thread id', value: '019a6a10-0000-7000-8000-000000000001' },
      { label: 'Starting directory', value: SECRET }] });
    const box = p.q('[data-codex-extras="info"]')[0];
    eq([box && box.style.display, box && /019a6a10/.test(box.textContent)], ['block', true], 'and shows them in a box above the row');
    const values = box.querySelectorAll('span').filter((s) => s.getAttribute('title') === 'Click to copy');
    values[1].dispatch('click', { stopPropagation() {} });
    const copy = p.posted.filter((m) => m.kind === 'infoCopy')[0];
    eq([copy && copy.index, JSON.stringify(p.posted).includes(SECRET)], [1, false],
      'clicking a value sends back its position only, and none of the text');

    /* Codex redrawing its message box: the row comes back on the next pass. */
    bar.remove();
    p.view();
    eq(p.q('[data-codex-extras="bar"]').length, 1, 'a row taken out of the page is put back on the next pass');
    p.view({ buttons: false });
    eq(p.q('[data-codex-extras="bar"]').length + p.q('[data-codex-extras="info"]').length, 0, 'with the master switch off nothing of it is drawn');
  }
  {
    const p = page(root, { box: false });
    p.view();
    eq(p.q('[data-codex-extras="bar"]').length, 0, 'with no message box recognised nothing is drawn');
  }

  /* ── the host: the rows, a value copied from its own copy, and the chime switched ── */
  const { vscode } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  patching.installHooks();
  const copied = [];
  let toggled = 0;
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: true, figures: false }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) },
    sessionInfo: async (id) => [{ label: 'Thread id', value: id }, { label: 'Starting directory', value: SECRET }],
    copy: async (value) => copied.push(value), toggleChime: () => { toggled++; } });
  const THREAD = '019a6a10-0000-7000-8000-0000000000b1';
  const sent = [];
  const provider = { postMessageToWebview: (w, m) => sent.push(m), sendMessageToPanel() {} };
  const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'infoAsk', id: 'i1' }, provider);
  await new Promise((r) => setTimeout(r, 20));
  const info = sent.filter((m) => m.type === 'codex-extras-info')[0];
  eq([info && info.id, info && info.rows.map((r) => r.value)], ['i1', [THREAD, SECRET]], 'the page is sent the rows of the conversation its panel shows');
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'infoCopy', id: 'i1', index: 1 }, provider);
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'infoCopy', id: 'an-older-box', index: 0 }, provider);
  eq(copied, [SECRET], 'a value is copied from what this side sent, by its position, and an older box\'s request copies nothing');
  globalThis.__codexExtrasMessage(panel.webview, { kind: 'toggleChime' }, provider);
  eq(toggled, 1, 'and the chime button switches the setting');
  patching._approvals.clear();
};
