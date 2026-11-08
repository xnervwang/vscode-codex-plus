// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Reading Codex's state database and rollouts, against a stand-in CODEX_HOME. */
const fs = require('fs');
const path = require('path');
const files = require('../../src/codex-files');
const fixture = require('../fixture');

module.exports = ({ ok, bad, eq, tmp }) => {
  const home = tmp('home');
  const made = fixture.codexHome(home, [
    { title: 'Idle one', turns: [{}] },
    { title: 'Working one', turns: [{}, { running: true, tool: 'exec_command', toolRunning: true }] },
    { title: 'Unread one', turns: [{ reply: 'x' }], unread: true },
    { title: 'Guardian review', source: '{"subagent":{"other":"guardian"}}', threadSource: 'guardian_review' },
    { title: '', source: '{"subagent":{"thread_spawn":{"parent_thread_id":"p","agent_nickname":"Bohr"}}}', threadSource: 'subagent' },
    { title: 'exec run', source: 'exec' },
  ]);
  files.setCodexHome(home);
  try {
    eq(files.stateDbPath(), path.join(home, 'state_5.sqlite'), 'finds the state database by its generation number');
    const threads = files.listThreads();
    eq(threads.length, 6, 'lists every thread');
    const kind = (title) => (threads.find((t) => t.title === title) || {}).kind;
    eq([kind('Idle one'), kind('Guardian review'), kind('exec run')], ['user', 'guardian', 'background'],
      'classifies a user thread, a guardian review and a codex exec run');
    const sub = threads.find((t) => t.kind === 'subagent');
    eq(sub && [sub.parent, sub.nickname], ['p', 'Bohr'], 'reads a sub-agent\'s parent and nickname from its source');
    eq(threads[0].title, 'exec run', 'newest first');

    const working = files.rolloutState(made[1].rollout);
    eq([working.working, working.lastTool && working.lastTool.name, working.lastTool && working.lastTool.endedMs],
      [true, 'exec_command', 0], 'a turn with no task_complete is working, with its running tool call');
    const idle = files.rolloutState(made[0].rollout);
    eq([idle.working, idle.durationMs, idle.model, idle.context && idle.context.window], [false, 5000, 'gpt-test', 258400],
      'an idle thread carries the last turn\'s duration, model and context window');
    const unread = files.unreadThreads();
    eq([...unread.keys()], [made[2].id], 'an unread receipt marks only that thread');
    eq(files.rolloutOf(made[0].id), made[0].rollout, 'finds a rollout through the database');
    eq(files.sessionMeta(made[0].rollout).id, made[0].id, 'reads session_meta from the first line');

    // A huge last line must not hide the turn start behind the first window.
    const big = made[0].rollout;
    fs.appendFileSync(big, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
      payload: { type: 'function_call_output', output: 'x'.repeat(300 * 1024) } }) + '\n');
    eq(files.rolloutState(big).model, 'gpt-test', 'grows the tail window past a long line');

    // A rollout Codex compressed after a week: the database still names the plain file.
    const zlib = require('zlib');
    const plain = made[2].rollout;
    if (typeof zlib.zstdCompressSync === 'function') {
      fs.writeFileSync(plain + '.zst', zlib.zstdCompressSync(fs.readFileSync(plain)));
      fs.renameSync(plain, plain + '.moved');
      eq([files.existingRollout(plain), files.rolloutOf(made[2].id), files.rolloutState(plain).durationMs], [plain + '.zst', plain, 5000],
        'a compressed rollout still counts as there, and its end is read through zstd');
      fs.renameSync(plain + '.moved', plain);
    } else {
      fs.renameSync(plain, plain + '.zst');
      eq(files.existingRollout(plain), plain + '.zst', 'a compressed rollout still counts as there (no zstd in this Node to read it)');
      fs.renameSync(plain + '.zst', plain);
    }

    // Without the database, the index still gives ids and titles.
    const bare = tmp('bare');
    fs.writeFileSync(path.join(bare, 'session_index.jsonl'),
      JSON.stringify({ id: made[0].id, thread_name: 'From index', updated_at: new Date().toISOString() }) + '\n');
    files.setCodexHome(bare);
    eq((files.listThreads() || []).map((t) => t.title), ['From index'], 'falls back to session_index.jsonl');
  } finally { files.setCodexHome(''); }
  ok('codex-files restores the default CODEX_HOME afterwards');
};
