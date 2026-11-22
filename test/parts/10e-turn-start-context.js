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
};
