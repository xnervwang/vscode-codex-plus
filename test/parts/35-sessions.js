// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Two reasons Codex's conversations went missing from a window's list, one check each:
 *
 *   the workspace filter compared path strings, so a workspace reached through a symbolic link matched nothing
 *   a tab Codex opened with its New button names no conversation in its URI, so nothing was open as far as this
 *     extension could tell
 *
 * and what Codex's sidebar shows, which counts as open in this window as a tab does. Real directories and symbolic
 * links are made under the suite's scratch directory; Codex's own files are not touched.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `0000000${n}-0000-7000-8000-00000000000${n}`;

/** A reader with a fixed snapshot, which reads nothing from disk. */
const stubReader = (threads) => ({ threads: () => threads, sections: () => new Map(), state: () => null, unread: () => new Map(),
  hasPlan: () => false, thread: (id) => threads.find((t) => t.id === id) || null, present: () => true,
  refresh: async () => false, ready: async () => ({ threads, readable: true }) });

/** A thread row as src/codex-files.js listThreads() returns one. */
const thread = (n, cwd, extra = {}) => ({ id: ID(n), title: `t${n}`, cwd, kind: 'user', archived: false, pinned: false, section: null,
  createdMs: 1000, updatedMs: 2000 + n, present: true, rollout: '', ...extra });


module.exports = async ({ ok, bad, eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const { folderTest, realPath } = require('../../src/folders');
  const tabs = require('../../src/codex-tabs');
  const { unnamedTabThread, createCodexSource } = require('../../src/codex-source');

  /* ── the workspace filter, through a symbolic link ── */
  const base = tmp('fs');
  const real = path.join(base, 'local', 'home', 'u');
  fs.mkdirSync(path.join(real, 'ws', 'sub'), { recursive: true });
  const link = path.join(base, 'home-u');
  let linked = true;
  try { fs.symlinkSync(real, link, 'dir'); } catch (_) { linked = false; }
  if (!linked) {
    bad('this filesystem does not allow symbolic links, so the very bug the filter fixes cannot be checked here');
  } else {
    /* What VS Code reports as the workspace folder is the link; what Codex recorded is the directory behind it. */
    const asWorkspace = folderTest([path.join(link, 'ws')], new Map());
    eq([asWorkspace(path.join(real, 'ws')), asWorkspace(path.join(real, 'ws', 'sub')), asWorkspace(path.join(link, 'ws', 'sub')),
      asWorkspace(path.join(real, 'elsewhere'))], [true, true, true, false],
    'a workspace folder given through a symbolic link holds the conversations recorded under the real path');
    const bare = (cwd) => [path.join(link, 'ws')].some((f) => cwd === f || cwd.startsWith(f + path.sep));
    eq(bare(path.join(real, 'ws', 'sub')), false, 'comparing the strings instead, as before, places that same conversation outside the workspace');
    /* A conversation started in a folder since deleted still belongs to the workspace that held it. */
    eq([asWorkspace(path.join(real, 'ws', 'gone', 'deeper')), realPath(path.join(link, 'ws')) === path.join(real, 'ws')],
      [true, true], 'a directory that no longer exists is placed through the nearest ancestor that does');
  }

  const inside = linked ? path.join(real, 'ws', 'sub') : path.join(base, 'ws', 'sub');
  const threads = [thread(1, inside), thread(2, path.join(base, 'other')), thread(3, path.join(base, 'other2'))];
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(linked ? path.join(link, 'ws') : path.join(base, 'ws')) }];

  /* ── the tab URIs Codex really uses ── */
  const uri = (p) => vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: p });
  eq([tabs.threadOfUri(uri(`/local/${ID(1)}`)), tabs.threadOfUri(uri('/local/not-a-uuid')), tabs.threadOfUri(uri('/extension/panel/new')),
    tabs.threadOfUri(uri(`/remote/${ID(1)}`)), tabs.threadOfUri(vscode.Uri.file('/work/a.js'))],
  [ID(1), 'not-a-uuid', '', '', ''],
  'the id is read as Codex reads it: any non-empty segment after /local, nothing for its new-panel route or a cloud task');
  const newPanel = { label: 'Codex', input: new vscode.TabInputCustom(uri('/extension/panel/new'), 'chatgpt.conversationEditor') };
  eq([tabs.isCodexTab(vscode, newPanel), tabs.threadOfTab(vscode, newPanel)], [true, ''],
    'a tab Codex opened with its New button is its own, and names no conversation however long one runs in it');
  const shape = tabs.tabShape({ input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route',
    path: '/extension/panel/new', query: 'prompt=my%20secret' }), 'chatgpt.conversationEditor') });
  eq([shape, shape.includes('secret')], ['input TabInputCustom, viewType chatgpt.conversationEditor, uri openai-codex:/extension/panel/new', false],
    'the log line gives the input class, the view type and the scheme and path, and never the query Codex puts route state in');

  /* ── which conversation an unnamed tab holds, from the patch ── */
  /* The elimination rule alone, given what the patch reports. How the patch comes to know a New tab's conversation,
     from a panel Codex hands over with no thread, is test/parts/37-new-tab.js. */
  const patch = (list) => ({ panelThreads: () => list, revealPanel: () => false, sidebarThread: () => '', canDeliver: () => false });
  control.setTabs([newPanel], 0);
  eq(unnamedTabThread(vscode, patch([ID(1)])), ID(1), 'one unnamed Codex tab and one conversation the patch has a panel for can only be each other');
  eq(unnamedTabThread(vscode, patch([ID(1), ID(2)])), '', 'two conversations and one tab is a guess, so it stays unanswered');
  control.setTabs([newPanel, { label: 'Codex', input: new vscode.TabInputCustom(uri('/extension/panel/new'), 'chatgpt.conversationEditor') }], 0);
  eq(unnamedTabThread(vscode, patch([ID(1)])), '', 'and so is two tabs for one conversation');
  control.setTabs([newPanel, control.codexTab(ID(2))], 0);
  eq(unnamedTabThread(vscode, patch([ID(1), ID(2)])), ID(1), 'a conversation another tab already names does not count as free');
  eq([unnamedTabThread(vscode, null), unnamedTabThread(vscode, {})], ['', ''], 'without the patch there is nothing to go on');

  /* ── what the source answers for such a tab, and what it writes to the log ── */
  const said = [];
  control.setTabs([newPanel], 0);
  const source = createCodexSource(vscode, { log: (m) => said.push(m), reader: stubReader(threads), patching: patch([ID(1)]) });
  try {
    eq([source.sessionForTab(newPanel), said.length], [ID(1), 0], 'the source answers with the conversation the patch named, and says nothing to the log');
  } finally { source.dispose(); }
  const quiet = createCodexSource(vscode, { log: (m) => said.push(m), reader: stubReader(threads), patching: patch([ID(1), ID(2)]) });
  try {
    eq([quiet.sessionForTab(newPanel), quiet.sessionForTab(newPanel), said.length], ['', '', 1],
      'when it cannot tell, it leaves a line in the output panel - once for that shape of tab, not once a second');
    eq(said[0].includes('viewType chatgpt.conversationEditor') && said[0].includes('/extension/panel/new'), true,
      'and the line carries what the tab actually looks like');
    eq(quiet.sessionForTab(control.fileTab('/work/a.js')), null, 'a tab of something else is still not Codex\'s');
  } finally { quiet.dispose(); }

  /* ── the open set, and not reopening what is already open ── */
  const { TabMemory, OPEN_KEY } = require('../../src/tab-memory');
  const mem = fake.memento();
  await mem.update(OPEN_KEY, [ID(1), ID(2)]);
  control.setTabs([newPanel], 0);
  const memory = new TabMemory(vscode, mem, { alsoOpen: () => [ID(1)] });
  try {
    eq([memory.openThreads(), memory.dropped()], [[ID(1)], [ID(2)]],
      'a conversation only the patch can name counts as open, so it is not reopened in a second tab; the one truly missing still is');
  } finally { memory.dispose(); }
  const blind = new TabMemory(vscode, mem, {});
  try {
    eq(blind.dropped(), [ID(1), ID(2)], 'without that, the conversation already in front is taken for dropped - the second tab the user saw');
  } finally { blind.dispose(); }
  const throws = new TabMemory(vscode, mem, { alsoOpen: () => { throw new Error('no patch'); } });
  try { eq(throws.openThreads(), [], 'a patch that fails to answer leaves the tab URIs as the only source'); } finally { throws.dispose(); }

  /* ── the patch's own two answers, with a stand-in panel ── */
  const patching = require('../../src/patching');
  let disposed = null, revealed = 0;
  const panel = { webview: {}, reveal() { revealed++; }, onDidDispose: (fn) => { disposed = fn; }, iconPath: null };
  patching.installHooks();
  globalThis.__codexExtrasPanel(panel, ID(4), { navigateToRoute() {}, sendMessageToPanel() {} });
  eq([patching.panelThreads(), patching.revealPanel(ID(4)), revealed, patching.revealPanel(ID(5))], [[ID(4)], true, 1, false],
    'the patch reports the conversations its panels show, and raises the one asked for');
  disposed();
  eq(patching.panelThreads(), [], 'a closed panel is no longer open');
  ok('the workspace filter was checked against real directories and a symbolic link');
  /*
   * The conversation Codex's sidebar shows is open in this window as much as a tab is, while a sidebar view is
   * visible. The patch knows the view (the provider's sidebarView, a WebviewView) and which conversation the sidebar
   * went to last, and tells the source on the view's own visibility event.
   */
  {
    const inside = tmp('sidebar-ws');
    delete require.cache[require.resolve('../../src/patching')];
    const patching = require('../../src/patching');
    patching.installHooks();
    let hear = null;
    const view = { visible: true, onDidChangeVisibility: (fn) => { hear = fn; return { dispose() {} }; } };
    globalThis.__codexExtrasMessage({}, { kind: 'tz', timeZone: 'UTC' }, { sidebarView: view, sidebarViews: [] });
    patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
      vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: false, figures: false }),
      source: { onDidChangeConversations: () => ({ dispose() {} }), _focus() {}, listConversations: async () => [], logo: null },
      context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) } });
    let redraws = 0;
    patching.onSidebarChanged(() => { redraws++; });
    eq(patching.sidebarShowing(), '', 'before the sidebar has gone to any conversation it shows none');
    globalThis.__codexExtrasBroadcast('thread-stream-following-changed', { conversationId: ID(2), following: true });
    eq([patching.sidebarShowing(), redraws], [ID(2), 1], 'once it goes to one, that one is shown, and the list is told');
    view.visible = false;
    hear();
    eq([patching.sidebarShowing(), redraws], ['', 2], 'a sidebar that is hidden shows nothing, which its own visibility event says');
    view.visible = true;
    patching._approvals.clear();
  }
};
