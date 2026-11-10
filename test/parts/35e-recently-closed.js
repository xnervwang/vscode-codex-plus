// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Recently closed records the conversation a closed Codex tab was showing. The tab's URI is right only for a tab opened
 * on that conversation: a tab opened with a New button keeps /extension/panel/new, and one whose page started another
 * conversation still names the first. The patch reports what each disposed panel showed, and that is recorded whichever
 * of the two events VS Code sends first.
 */
const fake = require('../fake-vscode');

const NEW = '01a1aaaa-0000-7000-8000-0000000000a1';
const NAMED = '01a1bbbb-0000-7000-8000-0000000000b1';
const LATER = '01a1cccc-0000-7000-8000-0000000000c1';

module.exports = async ({ eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const patching = require('../../src/patching');
  const { TabMemory, CLOSED_KEY } = require('../../src/tab-memory');
  const { group } = require('../../src/sessions-view');

  const provider = { sendMessageToPanel() {}, postMessageToWebview() {}, navigateToRoute() {} };
  let conversations = [];
  const source = { listConversations: async () => conversations, onDidChangeConversations: () => ({ dispose() {} }), logo: null, _focus() {} };
  const context = { subscriptions: [], globalState: fake.memento(), globalStorageUri: vscode.Uri.file(tmp('gs')) };
  patching.installHooks();
  patching.activate(context, { vscode, log: () => {}, source, context, settings: () => ({ patchCodex: 'off', chime: false, figures: false }) });
  const panelOf = (id) => ({ webview: { id }, visible: false, iconPath: null, reveal() {}, onDidDispose(fn) { this.dispose = fn; } });
  const uri = (p) => vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: p });
  const tabOf = (p) => ({ label: 'Codex', input: new vscode.TabInputCustom(uri(p), 'chatgpt.conversationEditor') });

  const mem = fake.memento();
  const memory = new TabMemory(vscode, mem, { titleOf: (id) => ({ [NEW]: 'started in a New tab', [LATER]: 'started later' })[id] || '',
    alsoOpen: () => patching.panelThreads(), nowShowing: (id) => patching.nowShowing(id) });
  const sub = patching.onPanelClosed((thread, opened) => memory.panelClosed(thread, opened));
  try {
    /* ── a New tab: its URI names nothing, its panel names the conversation ── */
    const one = panelOf('new tab');
    globalThis.__codexExtrasPanel(one, null, provider, '/extension/panel/new');
    globalThis.__codexExtrasPageRequest(one.webview, { id: 's1', method: 'thread/start' }, 'request');
    globalThis.__codexExtrasPageResponse(one.webview, { id: 's1', result: { thread: { id: NEW } } });
    conversations = [{ sessionId: NEW }];
    await patching.refreshPanels();
    const newTab = tabOf('/extension/panel/new');
    control.setTabs([newTab], 0);
    control.fireTabs({ opened: [newTab] });
    eq(memory.openThreads(), [NEW], 'a conversation in a New tab is open, as the patch says');
    /* VS Code closes the tab, then disposes its panel. */
    control.setTabs([], 0);
    control.fireTabs({ closed: [newTab] });
    one.dispose();
    eq(memory.recentlyClosed().map((c) => [c.thread, c.title]), [[NEW, 'started in a New tab']],
      'closing a New tab records the conversation it showed, with its title');

    /* ── a tab opened on a conversation whose page then started another one, panel disposed first ── */
    const two = panelOf('named tab');
    globalThis.__codexExtrasPanel(two, NAMED, provider, `/local/${NAMED}`);
    globalThis.__codexExtrasPageRequest(two.webview, { id: 's2', method: 'thread/start' }, 'request');
    globalThis.__codexExtrasPageResponse(two.webview, { id: 's2', result: { thread: { id: LATER } } });
    conversations = [{ sessionId: NEW }, { sessionId: NAMED }, { sessionId: LATER }];
    await patching.refreshPanels();
    const namedTab = tabOf(`/local/${NAMED}`);
    control.setTabs([namedTab], 0);
    control.fireTabs({ opened: [namedTab] });
    two.dispose();
    control.setTabs([], 0);
    control.fireTabs({ closed: [namedTab] });
    eq(memory.recentlyClosed().map((c) => c.thread), [LATER, NEW],
      'a tab whose URI still names the conversation it was opened on records the one it showed when it closed');

    /* ── the same tab, with the tab event first ── */
    const three = panelOf('named tab again');
    globalThis.__codexExtrasPanel(three, NAMED, provider, `/local/${NAMED}`);
    globalThis.__codexExtrasPageRequest(three.webview, { id: 's3', method: 'thread/start' }, 'request');
    globalThis.__codexExtrasPageResponse(three.webview, { id: 's3', result: { thread: { id: LATER } } });
    await patching.refreshPanels();
    await mem.update(CLOSED_KEY, []);
    control.setTabs([namedTab], 0);
    control.fireTabs({ opened: [namedTab] });
    control.setTabs([], 0);
    control.fireTabs({ closed: [namedTab] });
    three.dispose();
    eq(memory.recentlyClosed().map((c) => c.thread), [LATER], 'and so it does when VS Code reports the closed tab before the panel');

    /* ── a panel disposed with no tab closed, as when the window shuts down ── */
    await mem.update(CLOSED_KEY, []);
    const four = panelOf('shutting down');
    globalThis.__codexExtrasPanel(four, NAMED, provider, `/local/${NAMED}`);
    const realNow = Date.now;
    Date.now = () => realNow() + 60000;
    try { four.dispose(); } finally { Date.now = realNow; }
    eq(memory.recentlyClosed(), [], 'a panel that goes away while no Codex tab closed is not recorded as closed');
  } finally {
    sub.dispose();
    memory.dispose();
  }

  /* ── where the group sits ── */
  const t = (id) => ({ id, title: id.slice(0, 4), kind: 'user', cwd: '/w', updatedMs: 2, createdMs: 1, archived: false, section: '' });
  const groups = group([t(NEW), t(NAMED)], { open: [NAMED], closed: [{ thread: NEW, title: 'x', at: 1 }] });
  eq(groups.slice(0, 2).map((g) => g.key), ['closed', 'open'], 'Recently closed comes above Open sessions, as in Claude Code Plus');
};
