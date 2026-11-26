// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's part of Agent Plus's session list, its pure parts (src/session-list-source.js): a thread as a Session, with
 * its kind, parent, branch, what the source made of it and its goal; the pages; what the one import hands over; and the
 * Account & usage part.
 */
module.exports = async ({ eq }) => {
  const L = require('../../src/session-list-source');
  const t = (id, o = {}) => Object.assign({ id, title: `T ${id}`, cwd: '/w', createdMs: 100, updatedMs: 900, kind: 'user', parent: '', nickname: '',
    section: '', archived: false, archivedMs: 0, pinned: false, branch: 'main' }, o);
  const conv = { title: 'T a', state: 'working', activity: 'working', running: true, lastUserAt: 500, lastActiveAt: 800, lastReplyAt: 700,
    waitingFor: null, left: ['command', 'nothing'] };

  const a = L.sessionOf(t('a'), conv, null);
  eq(a, { sessionId: 'a', title: 'T a', cwd: '/w', createdAt: 100, lastActiveAt: 800, kind: 'user', parentId: '', branch: 'main', detail: true,
    state: 'working', activity: 'working', running: true, lastUserAt: 500, lastReplyAt: 700, hover: ['A background command is still running'] },
  'a conversation read has its activity, its last message rather than when its row was written, and what still runs in its hover');
  eq([L.sessionOf(t('a'), { ...conv, unseen: true }, null).unseen, a.unseen], [true, undefined], 'one Codex Plus holds as not read says so, for the list\'s envelope');
  const kid = L.sessionOf(t('k', { kind: 'subagent', parent: 'a', nickname: 'Ada' }), null, null);
  const exec = L.sessionOf(t('e', { kind: 'background' }), null, null);
  const guard = L.sessionOf(t('g', { kind: 'guardian' }), null, null);
  eq([kid.title, kid.kind, kid.parentId, kid.detail, kid.activity, kid.lastActiveAt, exec.kind, exec.parentId, guard.kind],
    ['Ada', 'subagent', 'a', false, 'stopped', 900, 'background', '', 'background'],
    'a sub-agent goes by its nickname under its parent; codex exec and approval reviews are background; one not read yet asks for its detail');
  const goal = (status) => L.sessionOf(t('a'), conv, { status, objective: 'Ship it', tokensUsed: 1200, tokenBudget: 5000 });
  eq([goal('active').badges, goal('active').actions, goal('paused').actions, goal('blocked').badges[0].dim, goal('complete').badges, goal('complete').actions],
    [[{ text: 'goal', tooltip: 'Goal (goal, 1,200 of 5,000 tokens): Ship it', dim: false }], ['goal.pause', 'goal.clear'], ['goal.resume', 'goal.clear'], true, undefined, undefined],
    'a goal is a badge, dimmed unless it is active, with Pause or Resume and Clear; a goal met has neither');

  const term = { pid: 7, kind: 'terminal', label: 'terminal pts/3 in ~/w', detail: ['process 7'] };
  const execHolder = { pid: 8, kind: 'exec', label: 'codex exec in ~/w', detail: ['process 8'] };
  const there = L.sessionOf(t('a'), conv, null, [term]);
  const idle = L.sessionOf(t('a'), { ...conv, running: true, activity: 'stopped' }, null, [term, execHolder]);
  eq([there.elsewhere, idle.elsewhere.map((p) => p.running), L.sessionOf(t('a'), conv, null, []).elsewhere,
    L.sessionOf(t('a'), conv, null, Array.from({ length: 12 }, (_, i) => ({ ...term, pid: i }))).elsewhere.length],
  [[{ kind: 'terminal', label: 'terminal pts/3 in ~/w', detail: ['process 7'], running: true }], [false, true], undefined, 8],
  'a conversation another Codex process holds open lists it as a place, running there while a turn runs or when it is a codex exec, not while it is only recent; none lists no place, and at most eight are listed');
  eq([L.sessionOf(t('a'), conv, null, [term], { here: true }).processes, there.processes, L.sessionOf(t('a'), conv, null, [], { here: true }).processes],
    [2, undefined, undefined], 'held open elsewhere while this window shows it too, it is open in two processes at once; one place alone is not counted');

  const all = Array.from({ length: 5 }, (_, i) => i);
  eq([L.pageOf(all, null, 2), L.pageOf(all, '2', 2), L.pageOf(all, '4', 2)], [{ sessions: [0, 1], cursor: '2' }, { sessions: [2, 3], cursor: '4' }, { sessions: [4], cursor: null }],
    'pages follow the cursor to the end');

  const PIN = 'pin-section';
  const imp = L.importOf([t('a', { archived: true, archivedMs: 42 }), t('b', { section: 's1' }), t('c', { section: 's1' }), t('d', { section: PIN }), t('e', { pinned: true, section: 's1' }),
    t('f', { section: 'gone' })], { sections: [[PIN, 'Pinned'], ['s1', ' Plugins ']], pinnedSection: PIN, colors: { b: 'green', zz: 'red' } });
  eq(imp, { archived: [{ sessionId: 'a', at: 42 }], groups: [{ name: 'Plugins', sessionIds: ['b', 'c'] }], pinned: ['d', 'e'], colors: { b: 'green' } },
    'the import hands over what Codex archived and when, its sections as groups, its Pinned section and pin mark as pinned, and the title colours');

  const view = { account: [{ label: 'Signed in with', value: 'API key' }], windows: [{ name: '5-hour', usedPercent: 32, resetsAt: 1000 }], tokens: [{ label: 'Tokens today', value: 1900000 }] };
  eq(L.accountOf(view, { title: 'T a', tokens: { total: 412000 } }), { rows: [{ label: 'Signed in with', value: 'API key' }, { label: 'Tokens today', value: '1,900,000' }],
    bars: [{ label: '5-hour limit', percent: 32, resetsAt: 1000000 }], conversation: { title: 'T a', rows: [{ label: 'Tokens', value: '412,000' }] } },
  'Account & usage: the sign-in and the day\'s tokens, the limits as bars, and the tokens of the conversation in front');
  eq([L.accountOf(null, null), L.accountOf(view, null).conversation], [null, undefined], 'with no account known there is no part, and with no conversation no conversation rows');
};
