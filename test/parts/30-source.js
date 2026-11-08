// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's tabs, the reader of Codex's files and its worker thread, the Codex source as Agent Work Plan sees it, the
 * sweep of plans whose conversation is gone, the session list and what the window remembers of its tabs, against a
 * stand-in Codex home.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ ok, bad, eq, tmp }) => {
  const { vscode, control } = fake.create();
  fake.install(vscode);
  const files = require('../../src/codex-files');
  const tabs = require('../../src/codex-tabs');
  const { CodexReader } = require('../../src/codex-reader');
  const home = tmp('home');
  const made = fixture.codexHome(home, [
    { title: 'Idle here', cwd: '/work/a', turns: [{}] },
    { title: 'Working here', cwd: '/work/a/sub', startMs: Date.now() - 120e3, turns: [{}, { running: true, tool: 'exec_command', toolRunning: true }] },
    { title: 'Unread elsewhere', cwd: '/other', turns: [{}], unread: true },
    { title: 'Archived', cwd: '/work/a', archived: true, turns: [{}] },
    { title: 'Guardian review', source: '{"subagent":{"other":"guardian"}}', threadSource: 'guardian_review', cwd: '/work/a' },
    { title: 'Old', cwd: '/work/a', startMs: Date.now() - 9 * 86400e3, turns: [{}] },
  ]);
  files.setCodexHome(home);
  const [idle, working, unread, , guardian, old] = made;
  const readers = [];
  try {
    /* ── tabs ── */
    const tab = control.codexTab(idle.id);
    eq(tabs.threadOfTab(vscode, tab), idle.id, 'a Codex conversation tab is claimed with its thread id');
    eq(tabs.threadOfTab(vscode, control.fileTab('/work/a/x.js')), '', 'a file tab is not');
    const prefixed = { input: new vscode.TabInputCustom(tab.input.uri, 'mainThreadWebview-chatgpt.conversationEditor') };
    eq(tabs.threadOfTab(vscode, prefixed), idle.id, 'a view type with a prefix VS Code added is still Codex\'s');
    const newTab = { input: new vscode.TabInputCustom(vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: '/extension/panel/new' }), 'chatgpt.conversationEditor') };
    eq([tabs.threadOfTab(vscode, newTab), tabs.isCodexTab(vscode, newTab), tabs.isCodexTab(vscode, control.fileTab('/x'))], ['', true, false],
      'a new-conversation tab names no thread yet, and is still Codex\'s');

    /* ── the reader, in a worker thread and in this one ── */
    const inThread = new CodexReader({ inline: true });
    const inWorker = new CodexReader();
    readers.push(inThread, inWorker);
    const [movedA, movedB] = await Promise.all([inThread.refresh({ home }), inWorker.refresh({ home })]);
    const shape = (r) => ({ ids: r.threads().map((t) => t.id), unread: [...r.unread().keys()], states: Object.keys(r.snap.states).sort(),
      present: r.threads().map((t) => t.present) });
    eq([movedA, movedB, !!inWorker.worker, inWorker.inline], [true, true, true, false], 'the reader starts a worker thread and both take a first snapshot');
    eq(shape(inWorker), shape(inThread), 'the worker thread reads exactly what this thread reads');
    eq([inWorker.state(old.id), !!inWorker.state(idle.id), inWorker.present(idle.id), inWorker.present('00000000-0000-0000-0000-000000000000')],
      [null, true, true, false], 'only recent threads have their rollout read; rollouts are marked present');
    eq(await inWorker.refresh({ home }), false, 'a second snapshot with nothing moved says so and keeps the first');
    const rows = await inWorker.request('info', { home, id: idle.id });
    eq(rows.find((r) => r.label === 'Thread id').value, idle.id, 'Session Information is read in the worker too');
    const broken = new CodexReader({ workerFile: path.join(tmp('nowhere'), 'missing.js'), log: () => {} });
    readers.push(broken);
    await broken.refresh({ home });
    eq([broken.inline, (broken.threads() || []).length], [true, made.length], 'a worker that cannot start leaves the reader working in this thread');

    /* ── the source ── */
    const { createCodexSource, conversationOf, PROTOCOL, EXTENSION_ID } = require('../../src/codex-source');
    const typed = [];
    const patching = { canDeliver: (id) => id === idle.id, deliver: async (id, text) => { typed.push(text); return { outcome: 'uncertain' }; },
      sidebarThread: () => unread.id };
    let trusted = true;
    const source = createCodexSource(vscode, { reader: inWorker, patching, trusted: () => trusted });
    try {
      eq([source.protocol, source.id, source.label, source.extensionId, PROTOCOL, EXTENSION_ID], [1, 'codex', 'Codex', 'xnervwang.codex-extras', 1, 'xnervwang.codex-extras'],
        'the source speaks protocol 1 and names its extension');
      eq(source.planPath(idle.id), path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', `${idle.id}.json`), 'its plans are in the plugin\'s data directory');
      eq([source.planPath('../x'), source.sessionForTab(control.codexTab(unread.id)), source.sessionForTab(newTab), source.sessionForTab(control.fileTab('/x'))],
        [null, unread.id, '', null], 'sessionForTab: a thread, \'\' for a new Codex tab, null for a file');
      const list = await source.listConversations();
      eq(list.map((c) => c.title).sort(), ['Archived', 'Idle here', 'Old', 'Unread elsewhere', 'Working here'], 'lists only conversations a person started');
      const by = new Map(list.map((c) => [c.title, c]));
      eq([by.get('Working here').state, by.get('Unread elsewhere').state, by.get('Idle here').state, by.get('Old').state], ['working', 'unread', 'idle', 'idle'],
        'working, unread and idle come from the reader\'s snapshot');
      const stale = conversationOf({ id: 'x', title: 't', cwd: '/', updatedMs: Date.now() - 5 * 3600e3 },
        { unread: new Map(), openHere: new Set(), state: { working: true, lastActivityMs: Date.now() - 5 * 3600e3 } });
      eq(stale.state, 'idle', 'a turn silent for hours is no longer counted as working');

      control.setTabs([control.codexTab(idle.id)], 0);
      eq([source.isFocused(idle.id), source.isFocused(unread.id), source.isFocused(working.id), source.isFocused('')], [true, true, false, false],
        'isFocused: the active tab, or the thread Codex\'s sidebar follows');
      /*
       * Agent Work Plan asks a moment after each report, and by then the reader can be somewhere else. The sidebar says
       * nothing about that, so the active tab becoming a tab that is not Codex's is what ends it: answering true then
       * would pull the work plan view back to a conversation the reader has left.
       */
      source._focus(unread.id);
      control.setTabs([control.fileTab('/w/elsewhere.js')], 0);
      source._tabsChanged();
      const afterLeaving = source.isFocused(unread.id);
      control.setTabs([control.codexTab(idle.id)], 0);
      source._tabsChanged();
      const backOnACodexTab = source.isFocused(unread.id);
      source._focus(unread.id);
      eq([afterLeaving, backOnACodexTab, source.isFocused(unread.id)], [false, false, true],
        'the sidebar stops answering for a conversation once the reader goes to a tab of something else, until it comes to the front again');
      eq([source.canDeliver(idle.id), source.canDeliver(working.id)], [true, false], 'an answer can go only to a conversation the patch can type into');
      const d1 = await source.deliverAnswer(idle.id, 'once', { deliveryId: 'd-1' });
      const d2 = await source.deliverAnswer(idle.id, 'once', { deliveryId: 'd-1' });
      trusted = false;
      const d3 = await source.deliverAnswer(idle.id, 'later', { deliveryId: 'd-2' });
      trusted = true;
      eq([d1, d2, d3.outcome, source.canDeliver(idle.id), typed], [{ outcome: 'uncertain' }, { outcome: 'uncertain' }, 'notReceived', true, ['once']],
        'a draft Codex cannot confirm is uncertain; the same delivery id is typed once; Restricted Mode types nothing');
      /* Every delivery id is kept for as long as this source is registered. One forgotten to make room would be typed a
         second time, which is the one thing remembering it prevents. A notReceived is still not kept: nothing was typed,
         and the sender may try again. */
      for (let i = 0; i < 400; i++) await source.deliverAnswer(idle.id, 'bulk', { deliveryId: `bulk-${i}` });
      const again = await source.deliverAnswer(idle.id, 'the very first one again', { deliveryId: 'd-1' });
      trusted = false;
      await source.deliverAnswer(idle.id, 'refused', { deliveryId: 'd-3' });
      trusted = true;
      const retried = await source.deliverAnswer(idle.id, 'retried', { deliveryId: 'd-3' });
      eq([again, retried.outcome, typed.filter((t) => t === 'the very first one again').length, typed.filter((t) => t === 'retried').length],
        [{ outcome: 'uncertain' }, 'uncertain', 0, 1],
        'a delivery id from 400 answers ago is still recognised, and one that was not received can be sent again');

      control.state.openWith = (uri) => control.setTabs([control.codexTab(uri.path.split('/').pop())]);
      const here = await source.reveal(idle.id, { title: 'Idle here' });
      const elsewhere = await source.reveal(working.id, { title: 'Working here' });
      control.answer('is not open in this window', 'Open it here');
      const offered = await source.reveal(unread.id, { title: 'Unread elsewhere' });
      await new Promise((r) => setTimeout(r, 20));
      const opened = control.state.commands.filter((c) => c[0] === 'vscode.openWith').map((c) => c[1].path.split('/').pop());
      eq([here, elsewhere, offered, opened], [true, false, true, [idle.id, unread.id]],
        'reveal: an open tab is brought forward; one running elsewhere is false; one not open is offered, and opened only on request');
      eq(source.logo, null, 'no logo when the Codex extension has no logo files');
      const ext = tmp('ext');
      fs.mkdirSync(path.join(ext, 'resources'));
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>';
      fs.writeFileSync(path.join(ext, 'resources', 'blossom-black.svg'), svg);
      fs.writeFileSync(path.join(ext, 'resources', 'blossom-white.svg'), svg);
      control.state.extensions.set('openai.chatgpt', { extensionUri: vscode.Uri.file(ext), extensionPath: ext });
      eq(source.logo && path.basename(source.logo.light.fsPath), 'blossom-black.svg', 'the logo is read from the Codex extension\'s own folder');
    } finally { source.dispose(); }

    /* ── plans of conversations that are gone are swept, recent ones and live ones kept ── */
    const { sweepOrphans, planQuestions } = require('../../src/workplan');
    const sweepDir = tmp('sweep');
    const oldMs = Date.now() - 30 * 86400e3;
    const ids = { live: idle.id, dead: '0dead000-0000-7000-8000-000000000000', fresh: '0f000000-0000-7000-8000-000000000000' };
    for (const [k, id] of Object.entries(ids)) {
      for (const ext of ['.json', '.turn']) {
        const f = path.join(sweepDir, id + ext);
        fs.writeFileSync(f, '{}');
        if (k !== 'fresh') fs.utimesSync(f, oldMs / 1000, oldMs / 1000);
      }
    }
    fs.writeFileSync(path.join(sweepDir, 'config.json'), '{}');
    const swept = sweepOrphans({ dir: sweepDir, live: new Set([ids.live]) });
    eq([swept.deleted, fs.readdirSync(sweepDir).sort()], [2, ['config.json', `${ids.fresh}.json`, `${ids.fresh}.turn`, `${ids.live}.json`, `${ids.live}.turn`].sort()],
      'a gone conversation\'s plan and side files are removed; a live one, one written this week and other files stay');
    eq(sweepOrphans({ dir: sweepDir, live: null }).deleted, 0, 'and nothing is removed when the live set could not be read');
    eq(planQuestions([{ title: 'a', state: 'waiting', waitingOn: 'user', question: 'Q?' }, { title: 'b', state: 'todo' }]).map((q) => q.question), ['Q?'],
      'planQuestions() finds the rows that wait on the user, for the chime');

    /* ── session list ── */
    const { group, dateSpan, looksLikeId, SessionsProvider } = require('../../src/sessions-view');
    const threads = inWorker.threads();
    const groups = group(threads, { open: [working.id], closed: [{ thread: idle.id, title: 'Idle here', at: 1 }, { thread: working.id, at: 2 }],
      sections: new Map(), hideBackground: true });
    const names = groups.filter((g) => g.threads.length).map((g) => `${g.key}:${g.threads.map((t) => t.title).join('|')}`);
    eq(names, ['open:Working here', 'closed:Idle here', 'ungrouped:Working here|Unread elsewhere|Idle here|Old', 'archived:Archived'],
      'open first, then recently closed (without the open one), the rest newest first, archived last; no guardian review');
    const withBg = group(threads, { hideBackground: false }).find((g) => g.key === 'background');
    eq(withBg && withBg.threads.map((t) => t.id), [guardian.id], 'turning the filter off lists the background threads');
    const day = 86400e3, t0 = new Date(2026, 8, 5, 12).getTime();
    eq(dateSpan(t0, t0 + 11 * day, t0 + 22 * day), '11d · 09/05→09/16', 'the date span reads like the session list\'s');
    eq([looksLikeId('69f9'), looksLikeId('69f'), looksLikeId('fix bug')], [true, false, false], 'four hex characters search the id');
    const provider = new SessionsProvider(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
      settings: () => ({ sessionsInWorkspaceOnly: false, recentClosedSessions: 10, hideBackgroundSessions: true }), stateOf: () => null, reader: inWorker });
    provider.refresh();
    eq(provider.getChildren().map((e) => e.group.key), ['open', 'ungrouped', 'archived'], 'the session list draws from the reader\'s snapshot');

    /* ── what the window remembers ── */
    const { TabMemory, OPEN_KEY, LAST_KEY } = require('../../src/tab-memory');
    const mem = fake.memento();
    await mem.update(OPEN_KEY, [idle.id, working.id, unread.id]);
    control.setTabs([control.codexTab(idle.id)], 0);
    const memory = new TabMemory(vscode, mem, { exists: (id) => id !== unread.id });
    eq(memory.dropped(), [working.id], 'a thread open last time that no tab shows is dropped, unless its rollout is gone');
    eq([memory.lastUsed(), mem.get(LAST_KEY).thread], [idle.id, idle.id], 'the conversation in front is remembered across reloads');
    control.setTabs([], 0);
    control.fireTabs({ closed: [control.codexTab(idle.id)] });
    eq(memory.recentlyClosed().map((c) => c.thread), [idle.id], 'closing a tab puts it at the head of recently closed');
    eq(memory.dropped(), [working.id], 'and a tab the user closed is never reopened');
    control.state.openWith = (uri) => control.setTabs([control.codexTab(uri.path.split('/').pop())]);
    const reopened = await memory.reopenDropped();
    eq([reopened, mem.get(OPEN_KEY)], [[working.id], [working.id]], 'reopening opens the dropped one and records what is open');
    memory.dispose();
    const later = new TabMemory(vscode, mem, {});
    control.setTabs([], 0);
    eq(later.lastUsed(), working.id, 'a new window starts from the one last in front');
    later.dispose();
    if (made.length === 6) ok('the stand-in Codex home holds six threads');
    else bad('fixture');
  } finally {
    for (const r of readers) r.dispose();
    files.setCodexHome('');
  }
};
