// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Codex source and the views around it, against a stand-in VS Code: claiming Codex tabs, opening a thread in a tab,
 * the states read from Codex's files, the host hand-over and the views it hides, which conversation is in front, the
 * Conversations list's rules, the logo-and-dot icons, the session list's groups, and what the window remembers of its
 * tabs.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const files = require('../../src/codex-files');
  const tabs = require('../../src/codex-tabs');
  const home = tmp('home');
  const made = fixture.codexHome(home, [
    { title: 'Idle here', cwd: '/work/a', turns: [{}] },
    { title: 'Working here', cwd: '/work/a/sub', startMs: Date.now() - 120e3, turns: [{}, { running: true, tool: 'exec_command', toolRunning: true }] },
    { title: 'Unread elsewhere', cwd: '/other', turns: [{}], unread: true },
    { title: 'Archived', cwd: '/work/a', archived: true, turns: [{}] },
    { title: 'Guardian review', source: '{"subagent":{"other":"guardian"}}', threadSource: 'guardian_review', cwd: '/work/a' },
  ]);
  files.setCodexHome(home);
  const [idle, working, unread, archived, guardian] = made;
  try {
    /* ── tabs ── */
    const tab = control.codexTab(idle.id);
    eq(tabs.threadOfTab(vscode, tab), idle.id, 'a Codex conversation tab is claimed with its thread id');
    eq(tabs.threadOfTab(vscode, control.fileTab('/work/a/x.js')), '', 'a file tab is not');
    const prefixed = { input: new vscode.TabInputCustom(tab.input.uri, 'mainThreadWebview-chatgpt.conversationEditor') };
    eq(tabs.threadOfTab(vscode, prefixed), idle.id, 'a view type with a prefix VS Code added is still Codex\'s');
    const newTab = { input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: '/extension/panel/new' }), 'chatgpt.conversationEditor') };
    eq(tabs.threadOfTab(vscode, newTab), '', 'a new-conversation tab names no thread yet');
    control.state.openWith = (uri) => control.setTabs([control.codexTab(uri.path.split('/').pop())]);
    await tabs.openInTab(vscode, working.id);
    const call = control.state.commands.find((c) => c[0] === 'vscode.openWith');
    eq(call && [call[1].toString(), call[2]], [`openai-codex://route/local/${working.id}`, 'chatgpt.conversationEditor'],
      'opening in a tab uses the URI and view type Codex restores its own tabs with');

    /* ── the source ── */
    const { createCodexSource, conversationOf } = require('../../src/codex-source');
    const source = createCodexSource(vscode);
    try {
      eq([source.id, source.label], ['codex', 'Codex'], 'the source is codex');
      eq(source.planPath(idle.id), path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', `${idle.id}.json`), 'its plans are in the plugin\'s data directory');
      eq(source.planPath('../x'), null, 'and nothing else is a plan path');
      eq(source.sessionForTab(control.codexTab(unread.id)), unread.id, 'sessionForTab claims a Codex tab');
      eq(source.sessionForTab(control.fileTab('/x')), null, 'and not a file');
      const list = await source.listConversations();
      eq(list.map((c) => c.title).sort(), ['Archived', 'Idle here', 'Unread elsewhere', 'Working here'], 'lists only conversations a person started');
      const by = new Map(list.map((c) => [c.title, c]));
      eq([by.get('Working here').state, by.get('Unread elsewhere').state, by.get('Idle here').state], ['working', 'unread', 'idle'],
        'states come from the rollout and the read receipts');
      if (list.every((c) => ['prompt', 'working', 'unread', 'idle'].includes(c.state))) ok('every state is one the protocol knows');
      else bad('a state outside prompt/working/unread/idle');
      const stale = conversationOf({ ...made[1], updatedMs: 1 }, { unread: new Set(), openHere: new Set(), now: Date.now() + 3 * 3600e3,
        state: { working: true, lastActivityMs: 1 } });
      eq(stale.state, 'idle', 'a turn silent for hours is no longer counted as working');
      eq(source.canDeliver(idle.id), false, 'nothing can be typed into a conversation without the patch');
      eq((await source.deliverAnswer(idle.id, 'x')).delivered, false, 'and deliverAnswer says so');
      control.state.extensions.set('openai.chatgpt', { extensionUri: vscode.Uri.file(tmp('noext')) });
      eq(source.logo, null, 'no logo when the Codex extension has no logo files');
      const ext = tmp('codexext');
      fs.mkdirSync(path.join(ext, 'resources'));
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';
      fs.writeFileSync(path.join(ext, 'resources', 'blossom-black.svg'), svg);
      fs.writeFileSync(path.join(ext, 'resources', 'blossom-white.svg'), svg.replace('<path', '<path fill="white"'));
      control.state.extensions.set('openai.chatgpt', { extensionUri: vscode.Uri.file(ext) });
      eq(source.logo && path.basename(source.logo.light.fsPath), 'blossom-black.svg', 'the logo is read from the Codex extension\'s own folder');

      /* ── the host hand-over ── */
      const hostLink = require('../../src/host-link');
      const registered = [];
      const host = (version) => ({ isActive: true, exports: { workPlanHost: { version, registerSource: (s) => { registered.push(s); return { dispose() {} }; } } } });
      control.state.extensions.set(hostLink.HOST_ID, host(2));
      let linked = await hostLink.link(vscode, source);
      eq([linked.hosted, registered.length, registered[0] === source, control.state.context[hostLink.CONTEXT_KEY]], [true, 1, true, false],
        'a host of version 2 gets the source, and this extension does not mark itself standalone');
      control.state.extensions.set(hostLink.HOST_ID, host(1));
      linked = await hostLink.link(vscode, source);
      eq([linked.hosted, control.state.context[hostLink.CONTEXT_KEY]], [false, true], 'a host older than version 2 is not used: standalone');
      control.state.extensions.delete(hostLink.HOST_ID);
      let later = null;
      linked = await hostLink.link(vscode, source, { onHosted: (r) => { later = r; } });
      eq([linked.hosted, control.state.context[hostLink.CONTEXT_KEY]], [false, true], 'no host: standalone');
      control.state.extensions.set(hostLink.HOST_ID, host(2));
      control.fireExtensions();
      await new Promise((r) => setTimeout(r, 20));
      eq([!!later, control.state.context[hostLink.CONTEXT_KEY]], [true, false], 'a host enabled later takes over the views');
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const views = Object.values(pkg.contributes.views).flat();
      const shared = views.filter((v) => ['codexExtras.workPlan', 'codexExtras.conversations', 'codexExtras.answer'].includes(v.id));
      eq(shared.map((v) => /(^|&& )codexExtras\.standalone( |$)/.test(v.when)), [true, true, true],
        'the work plan, Conversations and Answer views show only when this extension draws them');
      if (views.every((v) => !/codexExtras\.hosted/.test(v.when || ''))) ok('no view waits for a hosted key, which is unset before activation');
      else bad('a view uses codexExtras.hosted');
      eq([pkg.contributes.viewsContainers.activitybar[0].icon, pkg.contributes.viewsContainers.panel[0].icon, pkg.icon],
        ['images/workplan.svg', 'images/workplan.svg', 'images/icon.png'], 'the containers use workplan.svg and the extension icon.png');
      if (['icon.png', 'icon.svg', 'workplan.svg'].every((f) => fs.existsSync(path.join(root, 'images', f)))) ok('the three images are in the repository');
      else bad('an image is missing');

      /* ── which conversation is in front ── */
      const { FocusTracker } = require('../../src/focus');
      control.setTabs([control.codexTab(idle.id), control.fileTab('/work/a/x.js'), control.codexTab(working.id)], 0);
      const focus = new FocusTracker(vscode, [source]);
      eq(focus.current && focus.current.sessionId, idle.id, 'the active Codex tab is in front');
      control.setTabs([control.codexTab(idle.id), control.fileTab('/work/a/x.js'), control.codexTab(working.id)], 1);
      control.fireTabs();
      eq(focus.current.sessionId, idle.id, 'a file tab in front keeps the conversation that was');
      control.setTabs([control.codexTab(idle.id), control.fileTab('/work/a/x.js'), control.codexTab(working.id)], 2);
      control.fireTabs();
      eq(focus.current.sessionId, working.id, 'another Codex tab moves it');
      source._focus(unread.id);
      eq(focus.current.sessionId, unread.id, 'the source\'s onDidFocus moves it too; the last one wins');
      focus.dispose();

      /* ── the Conversations list ── */
      const conversations = require('../../src/conversations');
      const planDir = source.planDir();
      fs.mkdirSync(planDir, { recursive: true });
      const writePlan = (id, nodes, mtime) => {
        const f = path.join(planDir, `${id}.json`);
        fs.writeFileSync(f, JSON.stringify({ nodes }));
        if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
      };
      writePlan(idle.id, [{ title: 'Ask', state: 'waiting', waitingOn: 'user', question: 'Ship it?' }, { title: 'Build', state: 'doing' }]);
      writePlan(archived.id, [{ title: 'Old', state: 'todo' }], Date.now() - 10 * 86400e3);
      const { readPlan } = require('../../src/workplan');
      const listed = await source.listConversations();
      const shown = conversations.build(listed.map((c) => ({ ...c, running: c.title !== 'Archived' })), {
        folders: ['/work/a'], readPlan, planFile: (id) => source.planPath(id) });
      eq(shown.map((c) => c.title), ['Idle here', 'Working here'], 'only this workspace\'s conversations, needs before working');
      eq([shown[0].state, shown[0].questions[0].question, shown[0].doing[0].row], ['needs', 'Ship it?', '2'],
        'a question on the plan makes it needs-you, with the question and the doing row under it');
      const stopped = conversations.build(listed.map((c) => ({ ...c, running: false })), { folders: ['/work/a'], readPlan,
        planFile: (id) => source.planPath(id) });
      eq(stopped.map((c) => c.title), ['Idle here'], 'a stopped one stays only with open rows written this week');

      /* ── logo and dot ── */
      const { withDot, iconsFor } = require('../../src/logo-dot');
      const composed = withDot(svg, '#22c55e');
      if (/<mask id="d">/.test(composed) && /fill="#22c55e"/.test(composed) && composed.includes('<path d="M1 1h22v22H1z"/>')) ok('the logo is drawn with a dot cut into its corner');
      else bad(`unexpected composite: ${composed.slice(0, 200)}`);
      eq(withDot('<svg width="1"><path/></svg>', '#000'), '', 'a logo without a viewBox is not composited');
      const icons = iconsFor({ light: source.logo.light.fsPath, dark: source.logo.dark.fsPath }, tmp('icons'));
      eq(icons && Object.keys(icons).sort(), ['idle', 'needs', 'prompt', 'unread', 'working'], 'one icon pair per state is written to storage');
      eq(iconsFor({ light: '/nope.svg', dark: '/nope.svg' }, tmp('icons2')), null, 'a missing logo falls back to the plain icons');
      const { ConversationsProvider } = require('../../src/conversations-view');
      const provider = new ConversationsProvider(vscode, { context: { globalStorageUri: vscode.Uri.file(tmp('gs')) }, logoOf: () => source.logo });
      provider.set(shown, source);
      const rows = provider.getChildren();
      const item = provider.getTreeItem(rows[0]);
      if (item.iconPath && item.iconPath.light && /logo-.*-needs-light\.svg$/.test(item.iconPath.light.fsPath)) ok('a conversation row carries the logo with its state\'s dot');
      else bad(`conversation row icon: ${JSON.stringify(item.iconPath)}`);
      eq(item.description.split(' · ')[0], 'needs you', 'and its state word comes first');
      const kid = provider.getTreeItem(provider.getChildren(rows[0])[0]);
      eq(kid.iconPath instanceof vscode.ThemeIcon, true, 'a question row has no logo');
      const plain = new ConversationsProvider(vscode, { context: { globalStorageUri: vscode.Uri.file(tmp('gs2')) }, logoOf: () => null });
      plain.set(shown, source);
      eq(plain.getTreeItem(plain.getChildren()[0]).iconPath instanceof vscode.ThemeIcon, true, 'without a logo the plain state icon is used');
    } finally { source.dispose(); }

    /* ── session list ── */
    const { group, dateSpan, looksLikeId } = require('../../src/sessions-view');
    const threads = files.listThreads();
    const groups = group(threads, { open: [working.id], closed: [{ thread: idle.id, title: 'Idle here', at: 1 }, { thread: working.id, at: 2 }],
      sections: new Map(), hideBackground: true });
    const names = groups.filter((g) => g.threads.length).map((g) => `${g.key}:${g.threads.map((t) => t.title).join('|')}`);
    eq(names, ['open:Working here', 'closed:Idle here', 'ungrouped:Working here|Unread elsewhere|Idle here', 'archived:Archived'],
      'open first, then recently closed (without the open one), the rest newest first, archived last; no guardian review');
    const withBg = group(threads, { hideBackground: false }).find((g) => g.key === 'background');
    eq(withBg && withBg.threads.map((t) => t.id), [guardian.id], 'turning the filter off lists the background threads');
    const day = 86400e3, t0 = new Date(2026, 8, 5, 12).getTime();
    eq(dateSpan(t0, t0 + 11 * day, t0 + 22 * day), '11d · 09/05→09/16', 'the date span reads like the session list\'s');
    eq([looksLikeId('69f9'), looksLikeId('69f'), looksLikeId('fix bug')], [true, false, false], 'four hex characters search the id');

    /* ── what the window remembers ── */
    const { TabMemory, OPEN_KEY } = require('../../src/tab-memory');
    const mem = fake.memento();
    await mem.update(OPEN_KEY, [idle.id, working.id, unread.id]);
    control.setTabs([control.codexTab(idle.id)], 0);
    const memory = new TabMemory(vscode, mem, { exists: (id) => id !== unread.id });
    eq(memory.dropped(), [working.id], 'a thread open last time that no tab shows is dropped, unless its rollout is gone');
    control.setTabs([], 0);
    control.fireTabs({ closed: [control.codexTab(idle.id)] });
    eq(memory.recentlyClosed().map((c) => c.thread), [idle.id], 'closing a tab puts it at the head of recently closed');
    eq(memory.dropped(), [working.id], 'and a tab the user closed is never reopened');
    control.state.openWith = (uri) => control.setTabs([control.codexTab(uri.path.split('/').pop())]);
    const reopened = await memory.reopenDropped();
    eq([reopened, mem.get(OPEN_KEY)], [[working.id], [working.id]], 'reopening opens the dropped one and records what is open');
    memory.dispose();

    /* ── answers without the patch go to the clipboard and open the conversation ── */
    const answers = require('../../src/answers');
    let revealed = '';
    const r = await answers.deliver(vscode, { id: 'codex', reveal: async (id) => { revealed = id; return true; } },
      { sessionId: idle.id, row: '1', question: 'Ship it?', key: 'k' }, 'yes');
    eq([r.kind, control.state.clipboard, revealed], ['clipboard', 'My answer to row 1 ("Ship it?"):\nyes', idle.id],
      'an answer that cannot be typed is copied, in the message form, and its conversation opened');
  } finally { files.setCodexHome(''); }
};
