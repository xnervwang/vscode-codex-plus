// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation started in a New tab as Codex 26.1117 starts one: the page asks Codex's host, which starts the thread
 * itself, so no page request or response names it (seen in a real window). What remains is the id Codex puts on the
 * page's newest turn, which the page script reports, and this window's turn/started notification, which names that
 * turn's conversation.
 *
 * The page also retains the conversation it started in the host's store, which the host patch hands over as the
 * window starting to follow it, and which on its own would read as Codex's sidebar going there.
 */
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');
const { createDom } = require('../fake-dom');

const NEW = '01a3aaaa-0000-7000-8000-00000000000a';
const NEW2 = '01a3bbbb-0000-7000-8000-00000000000b';
const SIDE = '01a3cccc-0000-7000-8000-00000000000c';
const NAMER = '01a3dddd-0000-7000-8000-00000000000d';
const TURN = '01a3eeee-0000-7000-8000-0000000000e1';
const TURN2 = '01a3eeee-0000-7000-8000-0000000000e2';
const NAMER_TURN = '01a3eeee-0000-7000-8000-0000000000e3';

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const patching = require('../../src/patching');
  const { createCodexSource } = require('../../src/codex-source');

  const provider = { sendMessageToPanel() {}, postMessageToWebview() {}, navigateToRoute() {} };
  let conversations = [];
  const focused = [];
  const source = { listConversations: async () => conversations, onDidChangeConversations: new fake.EventEmitter().event, logo: null,
    _focus: (id) => focused.push(id), _heard() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  patching.installHooks();
  patching._approvals.clear();
  patching.activate(context, { vscode, log: () => {}, source, context,
    settings: () => ({ patchCodex: 'off', chime: false, figures: false, enabled: true, timestamps: false }) });
  const panelOf = (id) => ({ webview: { id }, title: 'Codex', visible: false, viewColumn: 1, active: false, iconPath: null,
    reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const shows = (panel, turn) => globalThis.__codexExtrasMessage(panel.webview, { type: 'codex-extras', kind: 'turnShown', turn }, provider);
  const started = (thread, turn) => globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: thread, turn: { id: turn } } });
  const retained = (thread) => globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: thread, following: true });
  const newTab = (label, fragment) => ({ label, input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
    path: '/extension/panel/new', fragment }), 'chatgpt.conversationEditor') });
  const reader = { threads: () => [], sections: () => new Map(), state: () => null, unread: () => new Map(), hasPlan: () => false,
    thread: () => null, present: () => true, refresh: async () => false, ready: async () => ({ threads: [], readable: true }) };

  /* Codex's sidebar went to a conversation earlier. */
  retained(SIDE);
  eq(patching.sidebarThread(), SIDE, 'the sidebar went to a conversation before the New tab was opened');

  /* ── the first message in a New tab ── */
  const fresh = panelOf('new tab');
  fresh.visible = true; fresh.active = true;
  globalThis.__codexExtrasPanel(fresh, null, provider, '/extension/panel/new');
  shows(fresh, 'turn-index-0');
  retained(NEW);
  started(NEW, TURN);
  /* Codex names a conversation with a thread of its own, whose turn no page shows. */
  started(NAMER, NAMER_TURN);
  shows(fresh, TURN);
  conversations = [{ sessionId: SIDE, title: 'Why does the export skip rows?' }, { sessionId: NEW, title: 'Draft the release notes', working: true },
    { sessionId: NAMER, title: 'Name this conversation' }];
  await patching.refreshPanels();
  eq([patching._registry.get(fresh).thread, fresh.title, patching.panelThreads()], [NEW, 'Draft the release notes', [NEW]],
    'the New tab is the conversation its newest turn belongs to, and is titled by it');
  eq(patching.sidebarThread(), SIDE, 'and the sidebar is still taken to show what it showed before, not the conversation the New tab started');
  control.setTabs([newTab('Draft the release notes', 'new-1')], 0);
  let src = createCodexSource(vscode, { reader, patching });
  try {
    eq([src.sessionForTab(control.groups[0].tabs[0]), src.isFocused(NEW)], [NEW, true], 'so the work plan view and Agent Plus have it in front');
  } finally { src.dispose(); }

  /* ── the page telling its turn before the app-server's notification arrives ── */
  const second = panelOf('second new tab');
  globalThis.__codexExtrasPanel(second, null, provider, '/extension/panel/new');
  shows(second, TURN2);
  await patching.refreshPanels();
  eq(patching._registry.get(second).thread, '', 'a turn no notification has named yet names no conversation');
  started(NEW2, TURN2);
  conversations = [...conversations, { sessionId: NEW2, title: 'Add a dry-run flag', working: true }];
  await patching.refreshPanels();
  eq([patching._registry.get(second).thread, patching._registry.get(fresh).thread], [NEW2, NEW],
    'the notification that comes after it names it, for that page only');

  /* ── a turn of another conversation shown in the same tab ── */
  shows(fresh, TURN2);
  await patching.refreshPanels();
  eq(patching._registry.get(fresh).thread, NEW2, 'a page that goes on to show another conversation\'s turn shows that conversation');
  control.setTabs([newTab('Add a dry-run flag', 'new-1'), newTab('Add a dry-run flag', 'new-2')], 0);
  src = createCodexSource(vscode, { reader, patching });
  try {
    eq(control.groups[0].tabs.map((t) => src.sessionForTab(t)), [NEW2, NEW2], 'two New tabs showing one conversation are both that conversation\'s');
  } finally { src.dispose(); }
  shows(fresh, TURN);
  await patching.refreshPanels();
  eq(patching._registry.get(fresh).thread, NEW, 'and the first one again once its turn is the newest shown');

  /* ── the page script ── */
  const dom = createDom();
  const { el } = dom;
  const page = (key) => el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [
    el('div', { attrs: { 'data-turn-key': key }, kids: [el('div', { attrs: { 'data-content-search-turn-key': key }, kids: [
      el('div', { attrs: { 'data-local-conversation-user-anchor': '' }, kids: [el('div', { attrs: { 'data-user-message-bubble': '' }, texts: ['Draft the release notes'] })] })] })] })] })] });
  dom.setBody(page('turn-index-0'));
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' } };
  vm.runInContext(require(path.join(root, 'src', 'webview-inject.js')).pageScript(), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  const view = () => listeners.message({ data: { type: 'codex-extras-view', timestamps: true, navigation: true } });
  const told = () => posted.filter((m) => m.kind === 'turnShown').map((m) => m.turn);
  view();
  dom.setBody(page(TURN));
  view();
  view();
  eq(told(), ['turn-index-0', TURN], 'the page tells the host the id of its newest turn each time it changes, and only then');
  eq(Object.keys(posted.find((m) => m.kind === 'turnShown') || {}).sort(), ['kind', 'turn', 'type'], 'and nothing but that id');

  for (const p of [fresh, second]) p.dispose();
  patching._approvals.clear();
};
