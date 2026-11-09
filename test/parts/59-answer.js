// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * An answer sent into a Codex conversation: the page script waits for the draft Codex's route state put in the message
 * box, sends it with Enter (or the modified Enter), and says what it saw; the host turns that into the outcome Agent
 * Work Plan's Answer view shows.
 *
 * The message box is built in the shape Codex 26.1021's own bundles render: a root marked data-codex-composer-root
 * (composer-controls), holding the div marked data-composer-input (composer-layout), which holds the contenteditable
 * editor. Both names are in the data-* list of the real layout sample in test/fixtures/. Whether Codex's editor takes a
 * dispatched Enter is the one thing only a live page can show; here a stand-in listener plays Codex's part.
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
    const p = page(root, { onKey: (e, el) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) el.textContent = ''; } });
    p.send({ type: 'codex-extras-answer', id: 'a1', text: ANSWER });
    for (let i = 0; i < 3; i++) p.dom.runTimers();
    eq(p.replies().length, 0, 'while the draft has not appeared yet, the page waits');
    p.editor.textContent = ANSWER.replace(', and', ',\n and');
    const r = p.settle();
    eq([r && r.outcome, (p.editor.dispatched || []).map((e) => [e.type, e.key, !!e.ctrlKey])], ['submitted', [['keydown', 'Enter', false]]],
      'once the draft is there it is sent with Enter, and the box letting go of it is reported as submitted');
    eq([Object.keys(r).sort(), JSON.stringify(p.posted).includes('release branch')], [['id', 'kind', 'outcome', 'type'], false],
      'the report is a word and the request\'s id, with nothing of the answer in it');
  }
  {
    const p = page(root, { holds: ANSWER, onKey: (e, el) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) el.textContent = ''; } });
    p.send({ type: 'codex-extras-answer', id: 'a2', text: ANSWER });
    const r = p.settle();
    eq([r && r.outcome, (p.editor.dispatched || []).map((e) => !!(e.ctrlKey || e.metaKey))], ['submitted', [false, true]],
      'a box that wants a modified Enter, as Codex\'s own setting can ask, gets one after the plain Enter did nothing');
  }
  {
    const p = page(root, { holds: ANSWER });
    p.send({ type: 'codex-extras-answer', id: 'a3', text: ANSWER });
    eq((p.settle() || {}).outcome, 'drafted', 'a box that keeps the text through both is reported as drafted, for the user to send');
  }
  {
    const p = page(root, { holds: 'a draft of my own' });
    p.send({ type: 'codex-extras-answer', id: 'a5', text: ANSWER });
    eq([(p.settle() || {}).outcome, (p.editor.dispatched || []).length], ['occupied', 0],
      'a box that holds something else, which Codex does not overwrite, is reported as occupied and nothing is pressed');
  }
  {
    const p = page(root, { box: false });
    p.send({ type: 'codex-extras-answer', id: 'a6', text: ANSWER });
    eq((p.settle() || {}).outcome, 'noComposer', 'a page with no message box says so');
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
  const THREAD = '019a6a10-0000-7000-8000-0000000000a1';
  let says = 'submitted';
  const asked = [];
  const view = { visible: true, onDidChangeVisibility: () => ({ dispose() {} }) };
  const provider = {
    sidebarView: view, sidebarViews: [],
    sendMessageToPanel: (panel, msg) => asked.push(['panel', msg.type]),
    navigateToRoute: (p, st) => asked.push(['sidebar route', p, st && st.prefillPromptOnlyIfEmpty]),
    postMessageToWebview: (webview, msg) => {
      if (msg.type !== 'codex-extras-answer') return;
      asked.push(['page', msg.text === ANSWER]);
      setImmediate(() => globalThis.__codexExtrasMessage(webview, { kind: 'answer', id: msg.id, outcome: says }, provider));
    },
    postMessageToSidebar: (msg) => {
      if (msg.type !== 'codex-extras-answer') return;
      asked.push(['sidebar page', msg.text === ANSWER]);
      setImmediate(() => globalThis.__codexExtrasMessage({}, { kind: 'answer', id: msg.id, outcome: says }, provider));
    },
  };
  const panel = { webview: {}, reveal() {}, onDidDispose() {}, iconPath: null };
  globalThis.__codexExtrasPanel(panel, THREAD, provider);
  const outcomes = [];
  for (const word of ['submitted', 'drafted', 'occupied', 'noDraft']) { says = word; outcomes.push(await patching.deliver(THREAD, ANSWER)); }
  eq(outcomes.map((o) => o.outcome), ['submitted', 'drafted', 'notReceived', 'uncertain'],
    'what the page saw becomes the outcome: sent, left as a draft, refused because the box held a draft, or uncertain');
  eq(/already holds a draft of yours/.test(outcomes[2].reason || ''), true, 'and a refusal says why');

  /* A conversation shown only in Codex's sidebar takes it too, through Codex's own route and the sidebar's page. */
  const SIDE = '019a6a10-0000-7000-8000-0000000000a2';
  globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: SIDE, following: true });
  asked.length = 0;
  says = 'submitted';
  eq([patching.canDeliver(SIDE), (await patching.deliver(SIDE, ANSWER)).outcome, asked],
    [true, 'submitted', [['sidebar route', `/local/${SIDE}`, true], ['sidebar page', true]]],
    'a conversation the sidebar shows can take an answer, into an empty box only, and is sent there');
  view.visible = false;
  eq([patching.canDeliver(SIDE), (await patching.deliver(SIDE, ANSWER)).outcome], [false, 'notReceived'],
    'while the sidebar is hidden it cannot');
  patching._approvals.clear();
};
