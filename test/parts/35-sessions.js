// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The three reasons the session list came up empty in a real window, one check each:
 *
 *   the workspace filter compared path strings, so a workspace reached through a symbolic link matched nothing
 *   a filtered-out conversation was simply absent, with no count and no way back
 *   a tab Codex opened with its New button names no conversation in its URI, so nothing was open as far as this
 *     extension could tell
 *
 * Real directories and symbolic links are made under the suite's scratch directory; Codex's own files are not touched.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `0000000${n}-0000-7000-8000-00000000000${n}`;

/** A thread row as src/codex-files.js listThreads() returns one. */
const thread = (n, cwd, extra = {}) => ({ id: ID(n), title: `t${n}`, cwd, kind: 'user', archived: false, pinned: false, section: null,
  createdMs: 1000, updatedMs: 2000 + n, present: true, rollout: '', ...extra });

/** A reader with a fixed snapshot: the view reads nothing from disk. */
const stubReader = (threads) => ({ threads: () => threads, sections: () => new Map(), state: () => null, unread: () => new Map(),
  hasPlan: () => false, thread: (id) => threads.find((t) => t.id === id) || null, present: () => true,
  refresh: async () => false, ready: async () => ({ threads, readable: true }) });

const stubMemory = () => ({ openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 });

module.exports = async ({ ok, bad, eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const { folderTest, realPath } = require('../../src/folders');
  const tabs = require('../../src/codex-tabs');
  const { SessionsProvider } = require('../../src/sessions-view');
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

  /* ── the view holds this workspace's conversations, as Claude Code's own list does ── */
  const inside = linked ? path.join(real, 'ws', 'sub') : path.join(base, 'ws', 'sub');
  const outsideA = path.join(base, 'other');
  const outsideB = path.join(base, 'other2');
  const threads = [thread(1, inside), thread(2, outsideA), thread(3, outsideB)];
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(linked ? path.join(link, 'ws') : path.join(base, 'ws')) }];
  let workspaceOnly = true;
  const provider = new SessionsProvider(vscode, { memory: stubMemory(), memento: fake.memento(), reader: stubReader(threads),
    stateOf: () => null, settings: () => ({ sessionsInWorkspaceOnly: workspaceOnly, recentClosedSessions: 10, hideBackgroundSessions: true }) });
  provider.refresh();
  const ungrouped = provider.groups.find((g) => g.key === 'ungrouped');
  eq([ungrouped.threads.map((t) => t.title), provider.groups.some((g) => g.threads.some((t) => t.title === 't2' || t.title === 't3'))],
    [['t1'], false], 'the conversation in this workspace is listed even though its folder is the one behind the link, and those of other folders are not');
  eq(provider.getChildren().map((r) => r.group.label).includes('Other folders'), false, 'and there is no group for other folders');
  workspaceOnly = false;
  provider.refresh();
  eq(provider.groups.find((g) => g.key === 'ungrouped').threads.length, 3, 'with the filter off every conversation is listed with the rest');
  workspaceOnly = true;

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
  /* ── the groups a reader of Claude Code's list would recognise, each with its count ── */
  const { group } = require('../../src/sessions-view');
  const inWs = (cwd) => cwd === inside;
  const shaped = group([thread(1, inside), thread(2, outsideA), thread(5, inside, { archived: true })],
    { open: [], closed: [], cwdFilter: inWs });
  eq(shaped.map((g) => g.label), ['Open sessions', 'Recently closed', 'Ungrouped', 'Archived sessions'],
    'the group names are the ones Claude Code\'s session list uses, in its order');
  eq(shaped.filter((g) => !g.expanded).map((g) => g.label), ['Recently closed', 'Archived sessions'],
    'the two a reader opens only when looking for something start collapsed');

  /* ── an empty open group says so; no group carries a nought ── */
  const bare = new SessionsProvider(vscode, { memory: stubMemory(), memento: fake.memento(), reader: stubReader([thread(1, inside)]),
    stateOf: () => null, settings: () => ({ sessionsInWorkspaceOnly: false, recentClosedSessions: 10, hideBackgroundSessions: true }) });
  bare.refresh();
  const openRow = bare.getChildren()[0];
  const openItem = bare.getTreeItem(openRow);
  const openKids = bare.getChildren(openRow);
  eq([openItem.label, openItem.description, openKids.map((k) => k.kind), bare.getTreeItem(openKids[0]).label],
    ['Open sessions', undefined, ['empty'], 'No conversation open in this window'],
    'with nothing open the group says so in a row of its own rather than showing a nought');
  eq(bare.getTreeItem(bare.getChildren()[1]).description, '1', 'a group that holds something counts it after its name');

  /* ── a conversation the user has not read gets no dot, and asks for one when its group opens ── */
  const asked = [];
  const old = thread(7, outsideA, { updatedMs: 50 });
  const unreadReader = { ...stubReader([thread(1, inside), old]), state: (id) => (id === ID(1) ? { working: false } : null) };
  const lazy = new SessionsProvider(vscode, { memory: stubMemory(), memento: fake.memento(), reader: unreadReader,
    stateOf: () => ({ state: 'idle' }), wantState: (ids) => asked.push(...ids),
    settings: () => ({ sessionsInWorkspaceOnly: false, recentClosedSessions: 10, hideBackgroundSessions: true }) });
  lazy.refresh();
  const groupRow = lazy.getChildren().find((r) => r.group.key === 'ungrouped');
  const kids = lazy.getChildren(groupRow);
  const known = lazy.getTreeItem(kids.find((k) => k.thread.id === ID(1)));
  const notRead = lazy.getTreeItem(kids.find((k) => k.thread.id === ID(7)));
  eq([known.iconPath.id, notRead.iconPath.id, notRead.tooltip.value.includes('not read')], ['circle-outline', 'blank', true],
    'the one whose rollout was read carries its status dot; the one that was not carries none, and says not read rather than idle');
  eq(asked, [ID(7)], 'opening the group asks for that one rollout, and only that one');
  asked.length = 0;
  lazy.getChildren(groupRow);
  eq(asked, [ID(7)], 'a group nobody opened asks for nothing, so the cost follows what is on screen');

  /* ── what Recently closed and Archived sessions do with their settings ── */
  const closedList = [{ thread: ID(8), title: 'closed one', at: 9 }];
  const noneKept = group([thread(1, inside)], { open: [], closed: [] });
  eq(noneKept.find((g) => g.key === 'closed').threads.length, 0, 'with none kept, Recently closed is empty and so is left out of the tree');
  const kept = group([thread(1, inside)], { open: [], closed: closedList });
  eq(kept.find((g) => g.key === 'closed').threads.map((t) => t.title), ['closed one'],
    'a conversation closed here is listed by the title it was closed under, even with no thread row left for it');
  const archivedOnly = group([thread(5, inside, { archived: true })], { open: [], closed: [] });
  const arch = archivedOnly.find((g) => g.key === 'archived');
  eq([arch.threads.length, arch.expanded], [1, false], 'Archived sessions holds the archived ones and starts closed');
  const archProvider = new SessionsProvider(vscode, { memory: stubMemory(), memento: fake.memento(),
    reader: stubReader([thread(5, inside, { archived: true })]), stateOf: () => null,
    settings: () => ({ sessionsInWorkspaceOnly: false, recentClosedSessions: 10, hideBackgroundSessions: true }) });
  archProvider.refresh();
  const archRow = archProvider.getChildren().find((r) => r.group.key === 'archived');
  eq(archProvider.getTreeItem(archProvider.getChildren(archRow)[0]).contextValue, 'codexPlusThreadArchived',
    'and its rows are the ones whose right-click menu offers Delete Conversation');

  ok('the session list was checked against real directories and a symbolic link');
  /*
   * The conversation Codex's sidebar shows is open in this window as much as a tab is, so Open sessions lists it while
   * a sidebar view is visible, and clicking it goes to the sidebar rather than opening a tab. The patch knows the view
   * (the provider's sidebarView, a WebviewView) and which conversation the sidebar went to last; the list redraws on the
   * view's own visibility event.
   */
  {
    const inside = tmp('sidebar-ws');
    const t1 = thread(1, inside), t2 = thread(2, inside);
    eq(group([t1, t2], { open: [], closed: [], sidebar: ID(2) })[0].threads.map((t) => t.id), [ID(2)],
      'a conversation the sidebar shows is in Open sessions');
    eq(group([t1, t2], { open: [ID(2)], closed: [], sidebar: ID(2) })[0].threads.length, 1, 'and once only when a tab shows it too');
    delete require.cache[require.resolve('../../src/patching')];
    const patching = require('../../src/patching');
    patching.installHooks();
    let hear = null;
    const view = { visible: true, onDidChangeVisibility: (fn) => { hear = fn; return { dispose() {} }; } };
    globalThis.__codexExtrasMessage({}, { kind: 'tz', timeZone: 'UTC' }, { sidebarView: view, sidebarViews: [] });
    patching.activate({ subscriptions: [], globalStorageUri: vscode.Uri.file(tmp('gs')), globalState: fake.memento() }, {
      vscode, log: () => {}, settings: () => ({ patchCodex: 'off', chime: false, figures: false }), planQuestions: () => 0,
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
    const listing = new SessionsProvider(vscode, { memory: stubMemory(), memento: fake.memento(), reader: stubReader([t1, t2]),
      settings: () => ({ sessionsInWorkspaceOnly: false, hideBackgroundSessions: true, recentClosedSessions: 10 }),
      stateOf: () => null, sidebarShowing: () => patching.sidebarShowing() });
    listing.refresh();
    const open = listing.getChildren(listing.getChildren()[0]);
    const row = listing.getTreeItem(open[0]);
    eq([open.length, row.command.command, /in Codex's sidebar/.test(row.tooltip.value)], [1, 'codexPlus.openThreadInSidebar', true],
      'its row goes to the sidebar when clicked, and says that it is there');
    patching._approvals.clear();
  }
};
