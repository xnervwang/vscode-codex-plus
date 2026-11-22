// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which conversation a Codex tab shows at the moment VS Code reports it coming to the front, while the panel of the tab
 * that was in front still says it is visible (seen in a real window: the tab event first, the two panels' view state
 * changes after it).
 */
const fake = require('../fake-vscode');

const X = '01a2aaaa-0000-7000-8000-00000000000a';
const Y = '01a2bbbb-0000-7000-8000-00000000000b';
const A = '01a2cccc-0000-7000-8000-00000000000c';
const B = '01a2dddd-0000-7000-8000-00000000000d';

module.exports = async ({ eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const patching = require('../../src/patching');
  const { createCodexSource } = require('../../src/codex-source');

  const provider = { sendMessageToPanel() {}, postMessageToWebview() {}, navigateToRoute() {} };
  let conversations = [];
  const source = { listConversations: async () => conversations, onDidChangeConversations: new fake.EventEmitter().event, logo: null, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  patching.installHooks();
  patching._approvals.clear();
  patching.activate(context, { vscode, log: () => {}, source, context,
    settings: () => ({ patchCodex: 'off', chime: false, figures: false, enabled: true, timestamps: false }) });
  /* A Codex panel as VS Code hands it over: titled "Codex" until something names it. */
  const panelOf = (id) => ({ webview: { id }, title: 'Codex', visible: false, viewColumn: 1, active: false, iconPath: null,
    reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const adopt = (panel, thread, route) => globalThis.__codexExtrasPanel(panel, thread, provider, route);
  const start = async (panel, id, n) => {
    globalThis.__codexExtrasPageRequest(panel.webview, { id: `start-${n}`, method: 'thread/start', params: {} }, 'request');
    globalThis.__codexExtrasPageResponse(panel.webview, { id: `start-${n}`, result: { thread: { id } } });
  };
  const show = (front, ...behind) => {
    front.visible = true; front.active = true;
    for (const p of behind) { p.visible = false; p.active = false; }
  };
  const newTab = (label = 'Codex', fragment = '') => ({ label, input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex',
    authority: 'route', path: '/extension/panel/new', fragment }), 'chatgpt.conversationEditor') });
  const namedTab = (thread, label) => ({ ...control.codexTab(thread), label });
  const reader = { threads: () => [], sections: () => new Map(), state: () => null, unread: () => new Map(), hasPlan: () => false,
    thread: () => null, present: () => true, refresh: async () => false, ready: async () => ({ threads: [], readable: true }) };
  const asked = (tabs, active) => {
    control.setTabs(tabs, active);
    const src = createCodexSource(vscode, { reader, patching });
    try {
      const front = control.groups[0].tabs[active];
      return control.groups[0].tabs.map((t) => src.sessionForTab(t)).concat(src.isFocused(src.sessionForTab(front)));
    } finally { src.dispose(); }
  };

  /* ── a conversation's tab, from a New tab nothing was typed into ── */
  const empty = panelOf('new tab, nothing typed');
  const onX = panelOf('tab on X');
  adopt(empty, null, '/extension/panel/new');
  adopt(onX, X, `/local/${X}`);
  show(empty, onX);
  conversations = [{ sessionId: X, title: 'Find the retry delay' }];
  await patching.refreshPanels();
  eq(asked([newTab('Codex', 'new-1'), namedTab(X, 'Find the retry delay')], 1), ['', X, true],
    'a tab whose URI names its conversation is that conversation\'s the moment it comes to the front, while the New tab it left still says it is visible');

  /* ── the same, from a New tab whose conversation is known ── */
  await start(empty, Y, 1);
  conversations = [{ sessionId: X, title: 'Find the retry delay' }, { sessionId: Y, title: 'Draft the release notes' }];
  await patching.refreshPanels();
  eq([patching._registry.get(empty).thread, empty.title], [Y, 'Draft the release notes'], 'the New tab\'s page started Y, and its panel is titled by it');
  eq(asked([newTab('Draft the release notes', 'new-1'), namedTab(X, 'Find the retry delay')], 1), [Y, X, true],
    'and the tab coming to the front from it is still the conversation its URI names, not the one the panel left visible shows');
  show(onX, empty);
  eq(asked([newTab('Draft the release notes', 'new-1'), namedTab(X, 'Find the retry delay')], 0), [Y, X, true],
    'the other way round, the New tab coming to the front while the named tab still says it is visible is its own conversation');

  /* ── two New tabs ── */
  const second = panelOf('second new tab');
  adopt(second, null, '/extension/panel/new');
  await start(second, A, 2);
  conversations = [...conversations, { sessionId: A, title: 'Add a dry-run flag' }];
  await patching.refreshPanels();
  show(empty, onX, second);
  eq(asked([newTab('Draft the release notes', 'new-1'), namedTab(X, 'Find the retry delay'), newTab('Add a dry-run flag', 'new-2')], 2), [Y, X, A, true],
    'with two New tabs whose conversations are known, each is matched to its panel by the title the panel gave it, whichever panel says it is visible');
  const third = panelOf('third new tab');
  adopt(third, null, '/extension/panel/new');
  show(third, onX, second, empty);
  eq(asked([newTab('Draft the release notes', 'new-1'), newTab('Add a dry-run flag', 'new-2'), newTab('Codex', 'new-3')], 2), [Y, A, '', false],
    'and a third with nothing typed into it has no conversation, in front or not');
  show(empty, onX, second, third);
  eq(asked([newTab('Draft the release notes', 'new-1'), newTab('Add a dry-run flag', 'new-2'), newTab('Codex', 'new-3')], 2), [Y, A, '', false],
    'nor does it take the conversation of the New tab it left, whose panel still says it is visible');

  /* ── two conversations of one title ── */
  await start(third, B, 3);
  conversations = [...conversations, { sessionId: B, title: 'Add a dry-run flag' }];
  await patching.refreshPanels();
  show(third, onX, second, empty);
  eq(asked([newTab('Add a dry-run flag', 'new-2'), newTab('Add a dry-run flag', 'new-3')], 1), ['', B, true],
    'two New tabs of one title are told apart only for the one in front, by the panel visible in its column');

  for (const p of [empty, onX, second, third]) p.dispose();
  patching._approvals.clear();
};
