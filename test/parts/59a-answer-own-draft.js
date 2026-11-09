// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * An answer whose text is already in the message box as the user's own draft, and a box that changes under the Enter
 * that sends an answer.
 *
 * Codex puts an answer in the box only when the box is empty (route state prefillPromptOnlyIfEmpty), so the box is
 * looked at when the page is told an answer is coming, which the host does before it navigates with the answer: text
 * there then is the user's, whatever it says, and is left alone. After Enter, an answer counts as sent only when the box
 * is empty again; a box holding something else by then says nothing either way.
 *
 * The page and its message box are the stand-ins of test/parts/59-answer.js, shaped as Codex 26.1021 renders them.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

const ANSWER = 'Use the release branch, and keep the old flag for one more week.';

function page(root, { box = true, holds = '', onKey = null } = {}) {
  const dom = createDom();
  const editor = dom.el('div', { attrs: { contenteditable: 'true', class: 'ProseMirror' } });
  if (holds) editor.textContent = holds;
  if (onKey) editor.addEventListener('keydown', (e) => onKey(e, editor));
  const kids = box ? [dom.el('div', { attrs: { 'data-codex-composer-root': '' }, kids: [dom.el('div', { attrs: { 'data-composer-input': '' }, kids: [editor] })] })] : [];
  dom.setBody(dom.el('body', { kids: [dom.el('div', { kids })] }));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' } };
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const replies = () => posted.filter((m) => m.kind === 'answer');
  return {
    dom, editor, posted, replies,
    send(m) { listeners.message({ data: m }); },
    /* Step the page's timers until it has answered, or give up. */
    settle() { for (let i = 0; i < 80 && !replies().length; i++) dom.runTimers(); return replies()[0]; },
  };
}

module.exports = async ({ eq, tmp, root }) => {
  /* ── the page ── */
  {
    const p = page(root, { holds: ANSWER.replace(', and', ',\n and'), onKey: (e, el) => { if (e.key === 'Enter') el.textContent = ''; } });
    p.send({ type: 'codex-extras-answer', id: 'own-1', text: ANSWER });
    eq([(p.settle() || {}).outcome, (p.editor.dispatched || []).length, p.editor.textContent.length > 0], ['occupied', 0, true],
      'a draft of the user\'s own that reads like the answer is left in the box, unsent, and reported as occupied');
  }
  {
    const p = page(root, { onKey: (e, el) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) el.textContent = 'and something I typed meanwhile'; } });
    p.send({ type: 'codex-extras-answer', id: 'own-2', text: ANSWER });
    p.dom.runTimers();
    p.editor.textContent = ANSWER;
    const r = p.settle();
    eq([r && r.outcome !== 'submitted', r && r.outcome], [true, 'changed'],
      'a box that holds other text after the Enter is not reported as sent: the answer may or may not have gone');
  }

  /* ── the host ── */
  const { vscode } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  patching.installHooks();
  patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
    vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: false, figures: false }),
    source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
    context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) } });
  const THREAD = '019a6a10-0000-7000-8000-0000000000b1';
  let says = 'submitted';
  const order = [];
  const provider = {
    sidebarView: { visible: false, onDidChangeVisibility: () => ({ dispose() {} }) }, sidebarViews: [],
    sendMessageToPanel: (p, msg) => order.push(msg.type),
    navigateToRoute() {},
    postMessageToWebview: (webview, msg) => {
      if (msg.type !== 'codex-extras-answer') return;
      order.push(msg.type);
      setImmediate(() => globalThis.__codexExtrasMessage(webview, { kind: 'answer', id: msg.id, outcome: says }, provider));
    },
  };
  const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  const r = await patching.deliver(THREAD, ANSWER, { waitMs: 500 });
  eq([r.outcome, order], ['submitted', ['codex-extras-answer', 'navigate-to-route']],
    'the page is told an answer is coming before Codex is asked to put it in the box, so it sees the box as it was');
  says = 'changed';
  eq((await patching.deliver(THREAD, ANSWER, { waitMs: 500 })).outcome, 'uncertain', 'and a box that changed under the Enter is uncertain');
  patching._approvals.clear();
};
