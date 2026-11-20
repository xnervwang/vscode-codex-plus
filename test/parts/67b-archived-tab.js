// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A page whose conversation is archived while it shows it is sent to Codex's read-only view of an archived conversation
 * (src/patching.js showArchived), since Codex's host otherwise draws its home there.
 */
const fake = require('../fake-vscode');

const T = '01a1f0f0-0000-7000-8000-0000000000b1';
const R = '01a1f0f0-0000-7000-8000-0000000000b2';
const S = '01a1f0f0-0000-7000-8000-0000000000b3';

module.exports = async ({ eq, tmp }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  delete require.cache[require.resolve('../../src/patching')];
  const patching = require('../../src/patching');
  const toPanels = [], toSidebar = [];
  const sidebarView = { visible: true, onDidChangeVisibility() { return { dispose() {} }; } };
  const provider = { sidebarView, postMessageToSidebar() {}, postMessageToWebview() {},
    sendMessageToPanel: (panel, m) => toPanels.push([panel.webview.id, m]), navigateToRoute: (path, state) => toSidebar.push([path, state]) };
  let conversations = [];
  const source = { listConversations: async () => conversations, onDidChangeConversations: () => ({ dispose() {} }), logo: null, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  const settings = () => ({ enabled: true, chime: false, figures: false, patchCodex: 'off', timestamps: false, conversationNavigation: false });
  patching.installHooks();
  patching.activate(context, { vscode, log: () => {}, source, context, settings });
  const panel = (id) => ({ webview: { id }, visible: true, viewColumn: 1, active: true, iconPath: null, reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const routes = () => toPanels.filter(([, m]) => m.type === 'navigate-to-route');
  const preview = (id) => ({ type: 'navigate-to-route', path: `/local/${id}`, state: { archivedConversationPreview: true } });
  const tab = panel('tab'), restored = panel('restored');
  try {
    globalThis.__codexExtrasPanel(tab, T, provider, `/local/${T}`);
    globalThis.__codexExtrasPanel(restored, R, provider, `/local/${R}`);
    conversations = [{ sessionId: T, archived: false }, { sessionId: R, archived: true }];
    await patching.refreshPanels();
    eq(routes(), [], 'nothing is sent to a tab on a conversation that is not archived, or on one archived before this window saw it');

    conversations = [{ sessionId: T, archived: true }, { sessionId: R, archived: true }];
    await patching.refreshPanels();
    eq(routes(), [['tab', preview(T)]], 'a tab whose conversation is archived while it is open is sent to the archived view');
    await patching.refreshPanels();
    eq(routes().length, 1, 'once: the next redraw sends nothing more');

    conversations = [{ sessionId: T, archived: false }, { sessionId: R, archived: true }];
    await patching.refreshPanels();
    conversations = [{ sessionId: T, archived: true }, { sessionId: R, archived: true }];
    await patching.refreshPanels();
    eq(routes().length, 2, 'archived again after being unarchived, it is sent again');

    globalThis.__codexExtrasMessage({ id: 'sidebar page' }, { type: 'codex-extras', kind: 'none' }, provider);
    globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: S, following: true });
    conversations = [{ sessionId: S, archived: false }];
    await patching.refreshPanels();
    conversations = [{ sessionId: S, archived: true }];
    await patching.refreshPanels();
    eq(toSidebar, [[`/local/${S}`, { archivedConversationPreview: true }]], 'and so is Codex\'s sidebar, when it shows the conversation');
  } finally {
    for (const p of [tab, restored]) if (patching._registry.has(p)) p.dispose();
    for (const d of context.subscriptions) { try { d.dispose(); } catch (_) { /* gone */ } }
  }
};
