// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What reaches the pages besides the panels' own: Codex's sidebar runs the same page script as a tab does (both are
 * built from webview/index.html), and is posted to through the provider's postMessageToSidebar, as Codex posts to it.
 *
 *   the sidebar's page   gets the settings it draws from, and while it is showing, the message times and figures of the
 *                        conversation it went to
 *   figures turned off   a page that was showing the strip is told to clear it, not left with the last figures
 *   the patch removed    every page is told that everything is off, in the full message a page reads its settings
 *                        from: a field left out reads as on (src/page/codex-extras-page.js, codex-extras-view)
 *
 * The provider is a stand-in with Codex's three ways of posting, recording what each was given.
 */
const fake = require('../fake-vscode');

const T = '01a1f0f0-0000-7000-8000-0000000000f1';
const S = '01a1f0f0-0000-7000-8000-0000000000f2';

module.exports = async ({ eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const patching = require('../../src/patching');
  const toSidebar = [], toPanels = [];
  const sidebarView = { visible: true, onDidChangeVisibility() { return { dispose() {} }; } };
  const provider = { sidebarView, postMessageToSidebar: (m) => toSidebar.push(m),
    sendMessageToPanel: (p, m) => toPanels.push({ p, m }), postMessageToWebview: (w, m) => toPanels.push({ w, m }), navigateToRoute() {} };
  let set = { enabled: true, timestamps: true, conversationNavigation: true, userMessageColor: 'lightgreen', userMessageEdge: true,
    lowContextOutline: true, figures: true, chime: false, patchCodex: 'off' };
  const conversations = [{ sessionId: T, state: 'working', working: true, lastTool: { name: 'exec_command', startedMs: 5, endedMs: 0, callId: 'c1' } },
    { sessionId: S, state: 'working', working: true, lastTool: { name: 'apply_patch', startedMs: 7, endedMs: 0, callId: 'c2' } }];
  const source = { listConversations: async () => conversations, onDidChangeConversations: () => ({ dispose() {} }), logo: null, _focus() {} };
  const asked = [];
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  patching.installHooks();
  patching.activate(context, { vscode, log: () => {}, source, context, settings: () => set,
    userTimes: async (id) => { asked.push(id); return { times: [1000], compactions: [], turns: {} }; } });
  globalThis.__codexExtrasMessage({ id: 'sidebar page' }, { type: 'codex-extras', kind: 'none' }, provider);
  const panel = { webview: { id: 'tab page' }, visible: true, viewColumn: 1, active: true, iconPath: null, reveal() {}, onDidDispose(fn) { this.dispose = fn; } };
  globalThis.__codexExtrasPanel(panel, T, provider, `/local/${T}`);
  globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: S, following: true });
  try {
    toSidebar.length = 0;
    await patching.refreshPanels();
    const view = toSidebar.find((m) => m.type === 'codex-extras-view');
    eq([!!view, view && view.userColor, view && view.timestamps], [true, 'lightgreen', true],
      'the sidebar\'s page is sent the settings it draws from, as a tab\'s page is');
    const times = toSidebar.find((m) => m.type === 'codex-extras-user-times');
    const strip = toSidebar.find((m) => m.type === 'codex-extras-figures');
    eq([!!times, asked.includes(S), strip && strip.tool], [true, true, 'apply_patch'],
      'and, while it is showing, the message times and figures of the conversation it went to');

    sidebarView.visible = false;
    toSidebar.length = 0;
    await patching.refreshPanels();
    eq(toSidebar.map((m) => m.type), ['codex-extras-view'], 'a hidden sidebar is sent the settings alone');
    sidebarView.visible = true;

    set = { ...set, figures: false };
    toPanels.length = 0; toSidebar.length = 0;
    await patching.refreshPanels();
    const cleared = (list) => list.some((m) => m.type === 'codex-extras-figures' && !m.text && !m.tool);
    eq([cleared(toPanels.map((x) => x.m)), cleared(toSidebar)], [true, true], 'with the figures turned off, a page is told to clear its strip');

    control.state.extensions.set('openai.chatgpt', { extensionPath: tmp('codex-none'), packageJSON: { version: '0' } });
    toPanels.length = 0; toSidebar.length = 0;
    patching.removePatch(vscode);
    const off = (list) => list.find((m) => m.type === 'codex-extras-view') || {};
    const flags = (m) => ['timestamps', 'navigation', 'userEdge', 'lowContext', 'replyFigures', 'buttons', 'chime'].map((k) => m[k]);
    eq([flags(off(toPanels.map((x) => x.m))), flags(off(toSidebar))], [Array(7).fill(false), Array(7).fill(false)],
      'taking the patch off tells the tabs and the sidebar that every addition is off, each one by name');
  } finally {
    if (patching._registry.has(panel)) panel.dispose();
  }
};
