// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Agent map lists every kind of work a conversation left running, not only its sub-agents and detached commands,
 * and any one of them is enough to show the pill. Each sub-agent carries its own activity and whether its reply is
 * unread. The session list draws a sub-agent row by its nickname.
 *
 * The page is covered by test/parts/61f-agent-map-work-page.js.
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');

const ID = (n) => `01a1f0f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

module.exports = async ({ eq, root }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const { mapOf, NO_MAP } = require('../../src/agent-map');

  /* ── the model ── */
  const A = ID(1), B = ID(2);
  const sub = (n, extra) => ({ id: ID(n), title: `Sub ${n}`, kind: 'subagent', parent: A, nickname: `nick${n}`, createdMs: n, updatedMs: n, ...extra });
  const threads = [{ id: A, title: 'Main', kind: 'user', parent: '', createdMs: 0, updatedMs: 50 },
    sub(3), sub(4), sub(5), sub(6), sub(7), { id: B, title: 'Other', kind: 'user', parent: '', createdMs: 2, updatedMs: 60 }];
  const reader = { threads: () => threads, wakeup: () => null, goal: () => null };
  const states = {
    [ID(3)]: { activity: 'working', state: 'working', lastActiveAt: 30 },
    [ID(4)]: { activity: 'background', state: 'working', lastActiveAt: 40, unseen: true },
    [ID(5)]: { activity: 'waiting', state: 'prompt', lastActiveAt: 50 },
    [ID(6)]: { activity: 'stopped', state: 'unread', unseen: true, lastActiveAt: 60 },
  };
  const work = [
    { thread: A, kind: 'command', pid: 11, start: '100', startMs: 1000, cmd: '/bin/bash -lc npm run watch', name: '', session: '', job: '' },
    { thread: ID(3), kind: 'claudeWorker', pid: 50, start: '200', startMs: 2000, cmd: 'claude -p go', name: 'night worker', session: ID(500), job: '' },
    { thread: A, kind: 'claudeBg', pid: 60, start: '300', startMs: 3000, cmd: '', name: 'night suite', session: ID(600), job: 'abcd1234' },
  ];
  const m = mapOf(A, { reader, stateOf: (id) => states[id] || null, left: () => ['subagent', 'command', 'claudeWorker', 'claudeBg'],
    running: (id) => (id === A ? work : []), envelope: '✉️' });
  eq(m.agents.map((a) => [a.name, a.dot, a.unseen]),
    [['nick3', 'working', false], ['nick4', 'background', true], ['nick5', 'waiting', false], ['nick6', 'stopped', true], ['nick7', 'unknown', false]],
    'each sub-agent\'s dot is its own activity: working, background work only, waiting for you, stopped, or not known while its rollout is unread; '
    + 'an unread reply is marked apart from the dot');
  eq([m.envelope, m.kinds], ['✉️', ['command', 'claudeWorker', 'claudeBg']],
    'the map carries the envelope the theme calls for, and the kinds of work still running besides the sub-agents');
  eq((m.background || []).map((w) => [w.kind, w.pid, w.startMs, w.cmd, w.name, w.job]),
    [['command', 11, 1000, '/bin/bash -lc npm run watch', '', ''], ['claudeWorker', 50, 2000, 'claude -p go', 'night worker', ''],
      ['claudeBg', 60, 3000, '', 'night suite', 'abcd1234']],
    'and lists that work: a background terminal by its command, a claude -p worker and a claude --bg session by the name Claude Code gave them');
  for (const kind of ['command', 'detached', 'codexExec', 'claudeWorker', 'claudeBg']) {
    const alone = mapOf(B, { reader, left: () => [kind] });
    eq([alone.shown, alone.kinds], [true, [kind]], `${kind} running and nothing else is enough for the pill`);
  }
  eq([mapOf(B, { reader, left: () => [] }).shown, mapOf(B, { reader, left: () => ['subagent'] }).kinds, NO_MAP.background, NO_MAP.kinds],
    [false, [], [], []], 'with nothing running and nothing else to show there is no pill');

  /* ── the source ── */
  {
    const { createCodexSource } = require('../../src/codex-source');
    const { createSeen } = require('../../src/seen');
    const S = ID(3);
    let clock = 1000;
    const seen = createSeen(undefined, { now: () => clock });
    const scan = {
      available: true,
      threads: { [A]: ['command'], [S]: ['claudeWorker'], [B]: ['codexExec'] },
      detached: [],
      running: [
        { thread: A, kind: 'command', pid: 11, start: '100', startMs: 10, cmd: '/bin/bash -lc npm run watch', name: '', session: '', job: '' },
        { thread: S, kind: 'claudeWorker', pid: 50, start: '200', startMs: 20, cmd: 'claude -p go', name: 'night worker', session: ID(500), job: '' },
        { thread: B, kind: 'codexExec', pid: 40, start: '100', startMs: 5, cmd: 'codex exec --json -', name: '', session: '', job: '' },
      ],
    };
    const rows = [{ id: A, title: 'Main', kind: 'user', parent: '', createdMs: 1, updatedMs: 1 },
      { id: S, title: '', kind: 'subagent', parent: A, nickname: 'scout', createdMs: 2, updatedMs: 2 },
      { id: B, title: 'Other', kind: 'user', parent: '', createdMs: 3, updatedMs: 3 }];
    const st = { [S]: { working: false, startedMs: 1500, endedMs: 2000, lastEndedMs: 2000, lastActivityMs: 2000 } };
    const stub = { request: (op) => Promise.resolve(op === 'leftRunning' ? scan : null), refresh: () => Promise.resolve(false), threads: () => rows,
      thread: (id) => rows.find((t) => t.id === id) || null, state: (id) => st[id] || null, hasPlan: () => false, busy: null, sections: () => new Map() };
    let here = [];
    const patching = { panelThreads: () => [], approvalsOf: () => null, sidebarThread: () => '', runningCommands: (id) => here.filter((c) => c.thread === id) };
    const source = createCodexSource(vscode, { reader: stub, patching, seen, scanLeft: () => true, leftEveryMs: 0, procDir: '/made/up' });
    try {
      await source._leftDone();
      const has = (name) => typeof source[name] === 'function';
      eq([has('leftOf'), has('runningOf')], [true, true], 'the source says what a conversation has left running, and lists it');
      if (has('leftOf') && has('runningOf')) {
        eq(source.leftOf(A), ['command', 'claudeWorker'], 'its kinds take in what its sub-agents started');
        eq(source.runningOf(A).map((w) => [w.kind, w.thread, w.pid, w.cmd, w.name]),
          [['command', A, 11, '/bin/bash -lc npm run watch', ''], ['claudeWorker', S, 50, 'claude -p go', 'night worker']],
          'and so does the list, oldest first, leaving out another conversation\'s');
        here = [{ thread: A, command: 'npm run watch', startedMs: 15 }];
        eq(source.runningOf(A).filter((w) => w.kind === 'command').map((w) => [w.pid, w.startMs, w.cmd]), [[0, 15, 'npm run watch']],
          'a background terminal this window\'s Codex runs is listed by the command the model gave, once');
      }
      eq((source.threadState(S) || {}).unseen, true, 'a sub-agent whose turn ended after the user last looked at it has an unread reply');
      clock = 3000;
      seen.mark(S);
      eq((source.threadState(S) || {}).unseen, false, 'and has none once they have looked at it');
    } finally { source.dispose(); }
  }

  /* ── extension.js ── */
  const ext = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  eq([/left: \(id\) => source\.leftOf\(id\)/.test(ext), /running: \(id\) => source\.runningOf\(id\)/.test(ext), /envelope: envelope\(vscode\)/.test(ext)],
    [true, true, true], 'the extension builds each page\'s map with the kinds, the work and the envelope');

  /* ── the session list's sub-agent rows ── */
  {
    const { SessionsModel } = require('../../src/sessions-view');
    const t = (n, extra) => ({ id: ID(n), title: `t${n}`, kind: 'user', parent: '', cwd: '/w', section: '', createdMs: n, updatedMs: n, ...extra });
    const list = [t(20, { updatedMs: 90 }),
      t(21, { kind: 'subagent', parent: ID(20), nickname: 'scout', title: '', createdMs: 21 }),
      t(22, { kind: 'subagent', parent: ID(20), nickname: '', title: 'Fix the test', createdMs: 22 }),
      t(23, { kind: 'subagent', parent: ID(20), nickname: '', title: '', createdMs: 23 }),
      t(24, { kind: 'subagent', parent: ID(20), nickname: 'idler', title: 'Look around', createdMs: 24 })];
    const convs = new Map([[ID(20), { activity: 'working' }]]);
    const subs = new Map([[ID(21), { activity: 'working', unseen: false }], [ID(22), { activity: 'background' }],
      [ID(23), { activity: 'waiting' }], [ID(24), { activity: 'stopped', unseen: true }]]);
    const model = new SessionsModel(vscode, { memory: { openThreads: () => [], recentlyClosed: () => [], frontAt: () => 0 }, memento: fake.memento(),
      reader: { threads: () => list, sections: () => new Map(), state: () => ({}), thread: (id) => list.find((x) => x.id === id) || null },
      stateOf: (id) => convs.get(id), threadState: (id) => subs.get(id) || null,
      settings: () => ({ recentClosedSessions: 10, hideBackgroundSessions: false }) }).model();
    const rowsOf = model.groups.flatMap((g) => g.rows);
    const row = (n) => rowsOf.find((r) => r.id === ID(n)) || {};
    eq([21, 22, 23, 24].map((n) => [row(n).title, row(n).dot, row(n).child, row(n).unread]),
      [['scout', 'working', true, false], ['Fix the test', 'background', true, false], ['(untitled)', 'waiting', true, false], ['idler', 'none', true, true]],
      'a sub-agent row is titled by its nickname, else its title, as in the Agent map, and drawn indented with its own dot and envelope');
    const css = fs.readFileSync(path.join(root, 'src', 'page', 'sessions-page.css'), 'utf8');
    eq(/\.cp-row\.cp-child \.cp-dot\.d-none[^{]*\{[^}]*visibility:\s*hidden/.test(css), true,
      'a sub-agent row with no dot keeps the dot\'s room, so it stays indented under its parent');
  }
};
