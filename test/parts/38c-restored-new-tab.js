// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A New tab that showed a conversation, across a reload. VS Code restores the tab on its URI, fragment and all, and
 * Codex 26.1117 draws it as a new conversation page: the route it reads from that URI is /extension/panel/new, and it
 * keeps nothing of what the page showed (seen in a real window). So the window remembers, by tab URI, the
 * conversation a tab showed that its URI does not name, and sends the restored tab's page back to it.
 *
 * The URI comes from the host patch, which keeps each conversation panel's URI on Codex's side from the moment Codex
 * resolves it, before this extension starts (src/host.js "conversation panel URIs"). It is taken here from the patch
 * as applied to a function shaped like Codex's resolveCustomEditor.
 */
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');

const NEW = '01a3c0c0-0000-7000-8000-00000000000a';
const NAMED = '01a3c0c0-0000-7000-8000-00000000000b';
const LATER = '01a3c0c0-0000-7000-8000-00000000000c';
const TURN = '01a3c0c0-0000-7000-8000-0000000000e1';
const TURN2 = '01a3c0c0-0000-7000-8000-0000000000e2';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const fresh = () => {
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(root, 'src') + path.sep)) delete require.cache[k];
    return { patching: require('../../src/patching'), source: require('../../src/codex-source'), memory: require('../../src/tab-memory') };
  };

  /* ── the host patch keeps each panel's URI ── */
  const host = require('../../src/host');
  const edit = host.EDITS.find((e) => e.name === 'conversation panel URIs');
  const codexLike = 'class P{async resolveCustomEditor(t,r,n){let o=String(t.uri);return o}}';
  const patched = codexLike.replace(edit.re, edit.to);
  const kept = vm.runInNewContext(`${patched};const panel={};new P().resolveCustomEditor({uri:'openai-codex://route/extension/panel/new#new-x'},panel,null);`
    + 'globalThis.__codexExtrasPanelUris instanceof WeakMap?globalThis.__codexExtrasPanelUris.get(panel):null', {});
  eq([patched !== codexLike, kept], [true, 'openai-codex://route/extension/panel/new#new-x'],
    'the host patch keeps the URI of the panel Codex resolves, whether or not this extension is running yet');

  const uri = (p, fragment) => vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: p, fragment });
  const NEW_URI = uri('/extension/panel/new', 'new-1'), EMPTY_URI = uri('/extension/panel/new', 'new-2'), NAMED_URI = uri(`/local/${NAMED}`);
  const tabOf = (label, u) => ({ label, input: new vscode.TabInputCustom(u, 'chatgpt.conversationEditor') });
  const workspaceState = fake.memento();
  const conversations = [{ sessionId: NEW, title: 'Draft the release notes' }, { sessionId: NAMED, title: 'Why does the export skip rows?' },
    { sessionId: LATER, title: 'Add a dry-run flag' }];
  const reader = { threads: () => [], sections: () => new Map(), state: () => null, unread: () => new Map(), hasPlan: () => false,
    thread: () => null, present: () => true, refresh: async () => false, ready: async () => ({ threads: [], readable: true }) };
  const panelOf = (name) => ({ name, webview: { name }, title: 'Codex', visible: false, viewColumn: 1, active: false, iconPath: null,
    reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const windowOf = (patching) => {
    const sent = [];
    const provider = { editorPanels: new Map(), sendMessageToPanel: (p, m) => sent.push([p.name, m]), postMessageToWebview() {}, navigateToRoute() {} };
    const source = { listConversations: async () => conversations, onDidChangeConversations: new fake.EventEmitter().event, logo: null, _focus() {}, _heard() {} };
    const context = { subscriptions: [], workspaceState, globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
    return { sent, provider, source, context,
      start: () => patching.activate(context, { vscode, log: () => {}, source, context, present: () => true,
        settings: () => ({ patchCodex: 'off', chime: false, figures: false, enabled: true, timestamps: false }) }),
      stop: () => { for (const d of context.subscriptions) { try { d.dispose(); } catch (_) { /* gone */ } } } };
  };
  const keepUri = (panel, u) => { (globalThis.__codexExtrasPanelUris || (globalThis.__codexExtrasPanelUris = new WeakMap())).set(panel, String(u)); };

  /* ── the first window ── */
  let { patching } = fresh();
  const one = windowOf(patching);
  one.start();
  const begun = panelOf('New tab'), empty = panelOf('empty New tab'), named = panelOf('named tab');
  for (const [p, u] of [[begun, NEW_URI], [empty, EMPTY_URI], [named, NAMED_URI]]) keepUri(p, u);
  globalThis.__codexExtrasPanel(begun, null, one.provider, '/extension/panel/new');
  globalThis.__codexExtrasPanel(empty, null, one.provider, '/extension/panel/new');
  globalThis.__codexExtrasPanel(named, NAMED, one.provider, `/local/${NAMED}`);
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: NEW, turn: { id: TURN } } });
  globalThis.__codexExtrasMessage(begun.webview, { type: 'codex-extras', kind: 'turnShown', turn: TURN }, one.provider);
  globalThis.__codexExtrasAppServer('notification', { method: 'turn/started', params: { threadId: LATER, turn: { id: TURN2 } } });
  globalThis.__codexExtrasMessage(named.webview, { type: 'codex-extras', kind: 'turnShown', turn: TURN2 }, one.provider);
  await patching.refreshPanels();
  eq([patching._registry.get(begun).thread, patching._registry.get(named).thread, begun.title], [NEW, LATER, 'Draft the release notes'],
    'in the first window the New tab shows the conversation begun in it, and the tab opened on a conversation the one begun after it');
  one.stop();

  /* ── the reload: VS Code restores the tabs, and Codex resolves the one in front before this extension starts ── */
  ({ patching } = fresh());
  const two = windowOf(patching);
  const back = panelOf('restored New tab'), backEmpty = panelOf('restored empty New tab');
  keepUri(back, NEW_URI);
  keepUri(backEmpty, EMPTY_URI);
  two.provider.editorPanels.set(back, { ready: false, pendingMessages: [], initialRoute: '/extension/panel/new' });
  two.provider.editorPanels.set(backEmpty, { ready: false, pendingMessages: [], initialRoute: '/extension/panel/new' });
  globalThis.__codexExtrasProvider = two.provider;
  control.setTabs([tabOf('Codex', NEW_URI), tabOf('Codex', EMPTY_URI), tabOf('Why does the export skip rows?', NAMED_URI)], 0);
  try {
    two.start();
    await tick();
    eq(patching._registry.get(back).thread, NEW, 'the restored New tab is taken to show the conversation it showed before the reload');
    eq(two.sent.filter(([n]) => n === 'restored New tab').map(([, m]) => [m.type, m.path]), [['navigate-to-route', `/local/${NEW}`]],
      'and its page, which Codex opens as a new conversation, is sent back to that conversation');
    eq([patching._registry.get(backEmpty).thread, two.sent.some(([n]) => n === 'restored empty New tab')], ['', false],
      'a restored New tab nothing was typed into stays a new conversation, and its page is left alone');
    await patching.refreshPanels();
    eq(back.title, 'Draft the release notes', 'the restored tab is titled by its conversation again');

    const { createCodexSource } = require('../../src/codex-source');
    const src = createCodexSource(vscode, { reader, patching });
    try {
      eq(control.groups[0].tabs.map((t) => src.sessionForTab(t)), [NEW, '', LATER],
        'each restored tab is that conversation\'s for the session list and Agent Plus, the tab not resolved yet included');
    } finally { src.dispose(); }

    /* Codex resolves the tab opened on a conversation when it comes to the front, after this extension started. */
    const backNamed = panelOf('restored named tab');
    keepUri(backNamed, NAMED_URI);
    globalThis.__codexExtrasPanel(backNamed, NAMED, two.provider, `/local/${NAMED}`);
    await tick();
    eq([patching._registry.get(backNamed).thread, patching.nowShowing(NAMED), two.sent.filter(([n]) => n === 'restored named tab').map(([, m]) => m.path)],
      [LATER, LATER, [`/local/${LATER}`]], 'a tab opened on one conversation that showed another is sent back to the other one when Codex resolves it');

    const { TabMemory } = require('../../src/tab-memory');
    const memento = fake.memento({ [require('../../src/tab-memory').OPEN_KEY]: [NEW, LATER, NAMED] });
    const mem = new TabMemory(vscode, memento, { alsoOpen: () => patching.panelThreads().concat(patching.shownByTabs()), nowShowing: (t) => patching.nowShowing(t) });
    try {
      eq(mem.dropped(), [], 'so none of their conversations is taken to be a tab VS Code dropped, and none is opened a second time');
    } finally { mem.dispose(); }

    /* Closing the tab forgets what it showed: a tab later opened on the same URI is a new conversation. */
    const tab = control.groups[0].tabs[0];
    control.setTabs([tabOf('Codex', EMPTY_URI), tabOf('Why does the export skip rows?', NAMED_URI)], 0);
    back.dispose();
    control.fireTabs({ closed: [tab] });
    await tick();
    const again = panelOf('New tab on the same URI');
    keepUri(again, NEW_URI);
    globalThis.__codexExtrasPanel(again, null, two.provider, '/extension/panel/new');
    await tick();
    eq([patching._registry.get(again).thread, two.sent.some(([n]) => n === 'New tab on the same URI')], ['', false],
      'once the tab is closed, what it showed is forgotten');
    for (const p of [backEmpty, backNamed, again]) if (p.dispose) p.dispose();
  } finally {
    two.stop();
    delete globalThis.__codexExtrasProvider;
    delete globalThis.__codexExtrasPanelUris;
  }
};
