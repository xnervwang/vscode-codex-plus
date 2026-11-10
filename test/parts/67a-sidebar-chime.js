// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Chimes for the conversation shown in Codex's sidebar. The sidebar's page runs the same script as a tab and plays a
 * chime the same way, so a turn that finishes or stops for the user there is heard without a tab. A conversation that
 * is also open in a tab chimes only in the tab.
 */
const fake = require('../fake-vscode');

const S = '01a1f0f0-0000-7000-8000-0000000000f3';

module.exports = async ({ eq, tmp }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  const toSidebar = [], toPanels = [];
  const sidebarView = { visible: true, onDidChangeVisibility() { return { dispose() {} }; } };
  const provider = { sidebarView, postMessageToSidebar: (m) => toSidebar.push(m), sendMessageToPanel() {},
    postMessageToWebview: (w, m) => toPanels.push(m), navigateToRoute() {} };
  let conversations = [{ sessionId: S, state: 'working', working: true }];
  const source = { listConversations: async () => conversations, onDidChangeConversations: () => ({ dispose() {} }), logo: null, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  const settings = () => ({ enabled: true, chime: true, figures: false, patchCodex: 'off', timestamps: false, conversationNavigation: false });
  patching.installHooks();
  patching.activate(context, { vscode, log: () => {}, source, context, settings });
  const chimes = (list) => list.filter((m) => m.type === 'codex-extras-chime').map((m) => m.kind);
  try {
    globalThis.__codexExtrasMessage({ id: 'sidebar page' }, { type: 'codex-extras', kind: 'none' }, provider);
    globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: S, following: true });
    await patching.refreshPanels();
    conversations = [{ sessionId: S, state: 'unread', working: false }];
    toSidebar.length = 0;
    await patching.refreshPanels();
    eq(chimes(toSidebar), ['done'], 'a turn finishing in the conversation the sidebar shows rings in the sidebar\'s page');

    globalThis.__codexExtrasAppServer('request', { id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: S, turnId: 't' } });
    await new Promise((r) => setTimeout(r, 20));
    eq(chimes(toSidebar), ['done', 'approval'], 'and so does a request for the user\'s permission there');
    globalThis.__codexExtrasAppServer('answer', { id: 41 });

    /* The same conversation opened in a tab too: the tab rings, the sidebar does not. */
    const panel = { webview: { id: 'tab page' }, visible: true, viewColumn: 1, active: true, iconPath: null, reveal() {}, onDidDispose(fn) { this.dispose = fn; } };
    globalThis.__codexExtrasPanel(panel, S, provider, `/local/${S}`);
    conversations = [{ sessionId: S, state: 'working', working: true }];
    await patching.refreshPanels();
    conversations = [{ sessionId: S, state: 'unread', working: false }];
    toSidebar.length = 0; toPanels.length = 0;
    await patching.refreshPanels();
    eq([chimes(toPanels), chimes(toSidebar)], [['done'], []], 'shown in a tab as well, it rings in the tab alone, and is heard once');
    if (patching._registry.has(panel)) panel.dispose();
  } finally {
    for (const d of context.subscriptions) { try { d.dispose(); } catch (_) { /* gone */ } }
  }
};
