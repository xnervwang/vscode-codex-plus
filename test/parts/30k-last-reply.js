// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * lastReplyAt, the end of a conversation's latest turn. Codex 26.1117 writes to a conversation without a reply when it
 * is opened (thread/resume appends a thread_settings_applied event to the rollout), when its goal is set (a
 * codex_internal_context message) and when it is unarchived (the row's updated_at). Each makes lastActiveAt the time
 * now and the conversation running again, and Agent Plus took that for a turn that ran between two of its reads: a
 * conversation with a reply not seen for a day was announced as finished. With lastReplyAt it is not, and a turn that
 * did run still is.
 */
const fs = require('fs');
const path = require('path');
const fixture = require('../fixture');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ eq, note, tmp, root }) => {
  const files = require('../../src/codex-files');
  const { conversationOf } = require('../../src/codex-source');
  const home = tmp('home');
  const dayAgo = Date.now() - 86400e3;
  const [t, fresh] = fixture.codexHome(home, [
    { title: 'Read a day ago', cwd: '/work', startMs: dayAgo, turns: [{}] },
    { title: 'No turn ended', cwd: '/work', startMs: Date.now() - 60e3, turns: [{ running: true }] },
  ]);
  files.setCodexHome(home);
  const read = (thread, unseen = true) => {
    const row = files.listThreads(home).find((x) => x.id === thread.id);
    return conversationOf(row, { unread: new Set(unseen ? [thread.id] : []), openHere: new Set(), state: files.rolloutState(thread.rollout) });
  };
  const ended = Math.floor((dayAgo + 5000) / 1000) * 1000;
  const before = read(t);
  eq([before.lastReplyAt, before.running, before.activity, before.unseen], [ended, false, 'stopped', true],
    'a conversation whose turn ended a day ago gives that end as lastReplyAt, and is not running');
  eq('lastReplyAt' in read(fresh), false, 'one with no turn ended yet gives none');

  /* Agent Plus's notices, from its own checkout, read the conversation before and after; without a checkout only the
     fields are checked. */
  const core = process.env.AGENT_WORK_PLAN_DIR || path.join(root, '..', 'vscode-agent-plus');
  const attention = fs.existsSync(path.join(core, 'src', 'attention.js')) ? require(path.join(core, 'src', 'attention.js')) : null;
  if (!attention) note(`no Agent Plus checkout at ${core}: its notices were not checked against lastReplyAt`);
  const shown = [];
  const att = attention && attention.createAttention({ dir: path.join(tmp('shared'), 'attention'), windowId: 'check-00000000', focused: () => true,
    settings: () => ({ enabled: true, finished: true, waiting: true }), warmupMs: 0, batchMs: 10, stableMs: 50, show: (text) => shown.push(text) });
  const feed = async (c) => {
    if (!att) return;
    att.publish([{ sourceId: 'codex', label: 'Codex', conversations: [c] }]);
    att.refresh();
    await wait(80);
    att.refresh();
  };
  try {
    await feed(before);
    await wait(20);

    /* What Codex writes when the conversation is opened and when its goal is set, then its row as unarchiving leaves it. */
    const now = Date.now();
    fs.appendFileSync(t.rollout, [
      { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: t.id,
        thread_settings: { model: 'gpt-test' } } },
      { timestamp: new Date(now + 1).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '<codex_internal_context source="user_goal">\nUser set the goal: "Ship it"\n</codex_internal_context>' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    {
      const { DatabaseSync } = require('node:sqlite');
      files.closeAll();
      const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
      db.prepare('update threads set updated_at = ?, updated_at_ms = ? where id = ?').run(Math.floor(now / 1000), now + 2, t.id);
      db.close();
    }
    const after = read(t);
    eq([after.lastReplyAt, after.lastActiveAt >= now, after.running, after.activity, after.unseen], [ended, true, true, 'stopped', true],
      'opened, its goal set and unarchived, it is active and running again, and its lastReplyAt has not moved');
    if (!att) return;
    await feed(after);
    await wait(80);
    await feed(after);
    eq(shown, [], 'Agent Plus does not announce it as finished');

    /* Read, and then a turn that does run between two reads. */
    await feed(read(t, false));
    await wait(20);
    const at = Date.now();
    fs.appendFileSync(t.rollout, fixture.rolloutLines({ id: t.id, cwd: '/work', startMs: at, turns: [{ id: 'later', startMs: at }] })
      .split('\n').slice(1).join('\n'));
    const ran = read(t);
    await feed(ran);
    await wait(80);
    await feed(ran);
    eq([ran.lastReplyAt > ended, shown], [true, ['"Read a day ago" finished.']], 'while a turn that ran between two reads moves lastReplyAt and is announced');
  } finally { if (att) att.dispose(); }
};
