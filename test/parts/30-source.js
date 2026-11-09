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
    /* The one usage figure Codex records: tokens. Its rate-limit records carry no plan, quota or credit on this
       machine, so there is no share-of-allowance or money figure to show (see the report). */
    eq(rows.find((r) => r.label === 'Tokens used by this conversation').value, '2020 (2000 in, 20 out, 7 cached, 9 reasoning)',
      'and it says what the conversation has spent, read from the token_count record already parsed for the context figure');

    /*
     * Asking for one conversation that is too old for a snapshot to cover. Without `force` the stamp has not moved,
     * so the snapshot answers "nothing changed" and reads no rollout, which is why asking forces one pass.
     */
    await inWorker.refresh({ home });
    const quiet = await inWorker.refresh({ home, extra: [old.id] });
    const beforeAsk = inWorker.state(old.id);
    const forced = await inWorker.refresh({ home, extra: [old.id], force: true });
    const afterAsk = !!inWorker.state(old.id);
    eq([quiet, beforeAsk, forced, afterAsk], [false, null, true, true],
      'asking for an old conversation\'s state needs one forced pass; comparing stamps alone would read nothing and leave the row blank');
    await inWorker.refresh({ home, force: true });
    const stillKnown = !!inWorker.state(old.id);
    inWorker.held.set(old.id, { at: 1, state: { working: true } });
    const afterItMoved = inWorker.state(old.id);
    eq([stillKnown, afterItMoved], [true, null],
      'the answer is kept, so later passes need not read it again - but only while that conversation has not moved since');
    const { HELD_MAX } = require('../../src/codex-reader');
    for (let i = 0; i < HELD_MAX + 25; i++) inWorker.held.set(`spare-${i}`, { at: 0, state: {} });
    inWorker.hold([]);
    eq(inWorker.held.size, HELD_MAX, 'and what is kept is capped, oldest first');
    const broken = new CodexReader({ workerFile: path.join(tmp('nowhere'), 'missing.js'), log: () => {} });
    readers.push(broken);
    await broken.refresh({ home });
    eq([broken.inline, (broken.threads() || []).length], [true, made.length], 'a worker that cannot start leaves the reader working in this thread');

    /* ── the source ── */
    const { createCodexSource, conversationOf, PROTOCOL, EXTENSION_ID } = require('../../src/codex-source');
    const typed = [];
    let sidebarOn = '';
    const patching = { canDeliver: (id) => id === idle.id, deliver: async (id, text) => { typed.push(text); return { outcome: 'uncertain' }; },
      sidebarThread: () => sidebarOn };
    let trusted = true;
    /* A record of what was looked at that starts before every turn in the stand-in home, so that each of those turns
       counts as a reply nobody has seen until its conversation comes to the front. */
    const { createSeen, SINCE_KEY } = require('../../src/seen');
    const seenState = fake.memento();
    await seenState.update(SINCE_KEY, 1);
    const source = createCodexSource(vscode, { reader: inWorker, patching, trusted: () => trusted, seen: createSeen(seenState) });
    try {
      eq([source.protocol, source.id, source.label, source.extensionId, PROTOCOL, EXTENSION_ID], [1, 'codex', 'Codex', 'xnervwang.codex-extras', 1, 'xnervwang.codex-extras'],
        'the source speaks protocol 1 and names its extension');
      eq(source.planPath(idle.id), path.join(home, 'plugins', 'data', 'agent-work-plan-codex-extras', `${idle.id}.json`), 'its plans are in the plugin\'s data directory');
      eq([source.planPath('../x'), source.sessionForTab(control.codexTab(unread.id)), source.sessionForTab(newTab), source.sessionForTab(control.fileTab('/x'))],
        [null, unread.id, '', null], 'sessionForTab: a thread, \'\' for a new Codex tab, null for a file');
      control.setTabs([control.codexTab(idle.id)], 0);
      source._tabsChanged();
      const list = await source.listConversations();
      eq(list.map((c) => c.title).sort(), ['Archived', 'Idle here', 'Old', 'Unread elsewhere', 'Working here'], 'lists only conversations a person started');
      const by = new Map(list.map((c) => [c.title, c]));
      eq([by.get('Working here').state, by.get('Unread elsewhere').state, by.get('Idle here').state, by.get('Old').state], ['working', 'unread', 'idle', 'idle'],
        'working from the rollout; unread for a turn that ended after the user last had it in front; idle for the one in front');

      /* Bringing it to the front is what reads it, and the views are told at once rather than at the next poll. */
      let told = 0;
      const hear = source.onDidChangeConversations(() => { told++; });
      control.setTabs([control.codexTab(unread.id)], 0);
      source._tabsChanged();
      const afterLooking = new Map((await source.listConversations()).map((c) => [c.title, c.state]));
      eq([afterLooking.get('Unread elsewhere'), afterLooking.get('Idle here'), told > 0], ['idle', 'idle', true],
        'a conversation brought to the front stops being unread, the one left keeps having been read, and the views hear of it');
      eq(files.unreadThreads().has(unread.id), true,
        'while Codex\'s own read receipt for it still says unread, which is how every receipt stays inside VS Code');
      hear.dispose();

      /* A window that is not focused is not being looked at, even with the tab in front. */
      const archived = made[3];
      vscode.window.state = { focused: false };
      control.setTabs([control.codexTab(archived.id)], 0);
      source._tabsChanged();
      const unfocused = new Map((await source.listConversations()).map((c) => [c.title, c.state]));
      vscode.window.state = { focused: true };
      const focusedAgain = new Map((await source.listConversations()).map((c) => [c.title, c.state]));
      delete vscode.window.state;
      eq([unfocused.get('Archived'), focusedAgain.get('Archived')], ['unread', 'idle'],
        'a reply in the front tab of a window that is not focused stays unread until the window is');
      sidebarOn = unread.id;
      const stale = conversationOf({ id: 'x', title: 't', cwd: '/', updatedMs: Date.now() - 5 * 3600e3 },
        { unread: new Map(), openHere: new Set(), state: { working: true, lastActivityMs: Date.now() - 5 * 3600e3 } });
      eq(stale.state, 'idle', 'a turn silent for hours is no longer counted as working');

      /*
       * `prompt` cannot come from a file, since Codex writes an approval request to none, so it comes from the patch.
       * It wins over `working`: as far as its rollout goes a turn stopped on an approval is still running, but it is
       * the user who has to act.
       */
      const running = { id: 'w', title: 't', cwd: '/', updatedMs: Date.now() };
      const live = { working: true, lastActivityMs: Date.now() };
      const asked = (waiting) => conversationOf(running, { unread: new Map(), openHere: new Set(), state: live, waiting });
      eq([asked({ decide: 1, soon: 0 }).state, asked({ decide: 0, soon: 1 }).state, asked({ decide: 0, soon: 0 }).state, asked(null).state],
        ['prompt', 'prompt', 'working', 'working'],
        'a conversation the patch says is stopped on a request reads prompt, whichever kind of request it is');
      eq([asked({ decide: 2, soon: 1 }).decide, asked({ decide: 2, soon: 1 }).soon, asked({ decide: 1, soon: 0 }).working,
        asked({ decide: 1, soon: 0 }).running],
      [2, 1, true, true],
      'and carries the counts of each kind beside the rollout\'s own answer, which is what says the wait is still live');

      control.setTabs([control.codexTab(idle.id)], 0);
      eq([source.isFocused(idle.id), source.isFocused(unread.id), source.isFocused(working.id), source.isFocused('')], [true, true, false, false],
        'isFocused: the active tab, or the thread Codex\'s sidebar follows');
      /*
       * Agent Work Plan asks a moment after each report, and by then the user can be somewhere else. The sidebar says
       * nothing about that, so the active tab becoming a tab that is not Codex's is what ends it: answering true then
       * would pull the work plan view back to a conversation the user has left.
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
        'the sidebar stops answering for a conversation once the user goes to a tab of something else, until it comes to the front again');
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
      /* A request for a state rides the poll the source already makes, and is dropped once answered, so the same old
         rollout is not read again on every pass. */
      inWorker.held.delete(old.id);
      await inWorker.refresh({ home, force: true });
      const wantedBefore = !!inWorker.state(old.id);
      await source.wantState([old.id]);
      eq([wantedBefore, !!inWorker.state(old.id), [...source._wanted]], [false, true, []],
        'a conversation whose state was asked for is read once and then taken off the list');
      eq(await source.wantState([idle.id]), false, 'one the reader already has is not asked for at all');

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

    /*
     * A state database that cannot be read makes listThreads fall back to session_index.jsonl, which holds only the
     * conversations that have a name. Taken for the list of the living, it made every unnamed conversation look gone.
     */
    {
      const home2 = tmp('sweep-home');
      const NAMED = '01a1aaaa-0000-7000-8000-000000000001', UNNAMED = '01a1bbbb-0000-7000-8000-000000000002';
      const day = path.join(home2, 'sessions', '2026', '10', '01');
      fs.mkdirSync(day, { recursive: true });
      for (const id of [NAMED, UNNAMED]) fs.writeFileSync(path.join(day, `rollout-2026-10-01T00-00-00-${id}.jsonl`), '{}\n');
      fs.writeFileSync(path.join(home2, 'state_5.sqlite'), 'not a database');
      fs.writeFileSync(path.join(home2, 'session_index.jsonl'), JSON.stringify({ id: NAMED, thread_name: 'named', updated_at: '2026-10-01T00:00:00Z' }) + '\n');
      const dir2 = tmp('sweep-plans');
      for (const id of [NAMED, UNNAMED]) { const f = path.join(dir2, `${id}.json`); fs.writeFileSync(f, '{}'); fs.utimesSync(f, oldMs / 1000, oldMs / 1000); }
      const r = sweepOrphans({ home: home2, dir: dir2 });
      eq([r.deleted, r.live, fs.readdirSync(dir2).length], [0, null, 2],
        'a thread list that came from the index is no list of the living, and nothing is deleted on it');

      /* Even with a live set that leaves a conversation out, its rollout on disk keeps its plan: in sessions/, or moved
         into archived_sessions/ by archiving. */
      const ARCHIVED = '01a1cccc-0000-7000-8000-000000000003';
      fs.mkdirSync(path.join(home2, 'archived_sessions'), { recursive: true });
      fs.writeFileSync(path.join(home2, 'archived_sessions', `rollout-2026-10-01T00-00-00-${ARCHIVED}.jsonl.zst`), 'x');
      const f3 = path.join(dir2, `${ARCHIVED}.json`); fs.writeFileSync(f3, '{}'); fs.utimesSync(f3, oldMs / 1000, oldMs / 1000);
      const GONE = '01a1dddd-0000-7000-8000-000000000004';
      const f4 = path.join(dir2, `${GONE}.json`); fs.writeFileSync(f4, '{}'); fs.utimesSync(f4, oldMs / 1000, oldMs / 1000);
      const r2 = sweepOrphans({ home: home2, dir: dir2, live: new Set([NAMED]) });
      eq([r2.deleted, fs.readdirSync(dir2).sort()], [1, [NAMED, UNNAMED, ARCHIVED].map((id) => `${id}.json`).sort()],
        'a conversation whose rollout is still in sessions/ or archived_sessions/ keeps its plan; only one with none anywhere loses it');
    }
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
