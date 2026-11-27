// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The context in use at the start of a turn, before its first model call has written a token_count: the newest one in
 * the rollout, from the turn before. The context meter and the figures strip draw from it, so without it they go blank
 * at the start of every turn. Everything else, such as the tool call the turn is running, comes from that turn only.
 */
const fs = require('fs');
const path = require('path');
const fixture = require('../fixture');

module.exports = async ({ eq, tmp }) => {
  const files = require('../../src/codex-files');
  const id = '01a1eeee-0000-7000-8000-000000000001';
  const t0 = Date.UTC(2026, 10, 21, 17, 0, 0);
  const done = { id: '01a1eeee-0000-7000-8000-0000000000a1', startMs: t0, tool: 'exec_command', context: 79000, total: 79900 };
  const iso = (ms) => new Date(ms).toISOString();
  const T2 = '01a1eeee-0000-7000-8000-0000000000a2', at = t0 + 60000;
  const started = [
    { timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: T2, started_at: Math.floor(at / 1000), model_context_window: 258400 } },
    { timestamp: iso(at), type: 'turn_context', payload: { turn_id: T2, model: 'gpt-test', effort: 'low', cwd: '/w' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    + fixture.userMessageRows({ at: at + 1, threadId: id, turnId: T2, text: 'and the next thing', item: 9 }).map((r) => JSON.stringify(r)).join('\n') + '\n';
  const file = path.join(tmp('turn-start'), 'rollout.jsonl');
  fs.writeFileSync(file, fixture.rolloutLines({ id, cwd: '/w', turns: [done], startMs: t0 - 1000 }) + started);

  const st = files.rolloutState(file);
  eq([st.working, st.turnId, st.context, st.tokens && st.tokens.total], [true, T2, { used: 79000, window: 258400 }, 79920],
    'a turn that has made no model call yet is working, with the context and tokens of the newest token_count, the last turn\'s');
  eq([st.lastTool, st.model], [null, 'gpt-test'], 'while the tool call it shows as running is its own, of which it has none yet, and the model is its own');

  /* A compaction writes the thread's new history as one long line, and a goal's turn after it can start without a
     message from the user. */
  const G = '01a1eeee-0000-7000-8000-0000000000a3', gat = t0 + 60000;
  const afterCompaction = (pad) => [
    { timestamp: iso(gat - 2), type: 'compacted', payload: { message: 'summary', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(pad) }] }] } },
    { timestamp: iso(gat - 1), type: 'event_msg', payload: { type: 'context_compacted' } },
    { timestamp: iso(gat), type: 'event_msg', payload: { type: 'task_started', turn_id: G, started_at: Math.floor(gat / 1000), model_context_window: 258400 } },
    { timestamp: iso(gat), type: 'turn_context', payload: { turn_id: G, model: 'gpt-test', effort: 'low', cwd: '/w' } },
    { timestamp: iso(gat + 2), type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<codex_internal_context source="goal">Make the export include archived rows</codex_internal_context>' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const rollout = (name, pad) => {
    const f = path.join(tmp(name), 'rollout.jsonl');
    fs.writeFileSync(f, fixture.rolloutLines({ id, cwd: '/w', turns: [done], startMs: t0 - 1000 }) + afterCompaction(pad));
    return files.rolloutState(f);
  };
  const short = rollout('compacted-short', 100), long = rollout('compacted-long', 100 * 1024);
  eq([short.working, short.context && short.context.used, short.lastUserMs > 0], [true, 79000, true],
    'after a short compaction line, the turn Codex starts has the last context and the user\'s last message');
  eq([long.working, long.turnId, long.context, long.tokens && long.tokens.total, long.lastUserMs],
    [true, G, short.context, short.tokens && short.tokens.total, short.lastUserMs], 'and so does one after a compaction line longer than the first tail read');
};
