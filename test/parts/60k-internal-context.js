// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The user-role messages Codex writes for itself with attributes on their tag, such as a goal's
 * <codex_internal_context source="goal">, which Codex does not draw. Left out of the user's times, a turn a goal
 * started, whose only message on the user's side is a Stop hook's prompt, still lines up with the page.
 * The rows below copy the shape of a rollout from a window test, with made-up words.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp }) => {
  const times = require('../../src/user-times');
  const T1 = '01a20132-0000-7000-8000-0000000000c1', T2 = '01a20132-0000-7000-8000-0000000000c2';
  const base = Date.UTC(2026, 10, 22, 3, 0, 0);
  const iso = (s) => new Date(base + s * 1000).toISOString();
  const ev = (s, payload) => JSON.stringify({ timestamp: iso(s), type: 'event_msg', payload });
  const msg = (s, role, text) => JSON.stringify({ timestamp: iso(s), type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
  const internal = (source, text) => `<codex_internal_context source="${source}">\n${text}\n</codex_internal_context>`;
  const lines = [
    ev(0, { type: 'task_started', turn_id: T1 }),
    JSON.stringify({ timestamp: iso(0), type: 'turn_context', payload: { turn_id: T1, model: 'gpt-x', effort: 'low' } }),
    msg(1, 'user', 'Read the whole build log.'),
    msg(2, 'assistant', 'Read it.'),
    ev(3, { type: 'task_complete', turn_id: T1, duration_ms: 3000 }),
    msg(10, 'user', internal('user_goal', 'User set the goal: "Make the export faster".')),
    msg(11, 'user', internal('user_goal', 'User set goal status: "active".')),
    ev(12, { type: 'task_started', turn_id: T2 }),
    JSON.stringify({ timestamp: iso(12), type: 'turn_context', payload: { turn_id: T2, model: 'gpt-x', effort: 'low' } }),
    msg(12, 'user', internal('goal', 'Continue working toward the active thread goal.')),
    msg(15, 'user', internal('user_goal', 'User set goal status: "paused".')),
    msg(16, 'assistant', 'Done.'),
    msg(16.5, 'user', '<hook_prompt hook_run_id="stop:10:/plugins/agent-work-plan">The summary was written before the context was compacted.</hook_prompt>'),
    msg(17, 'assistant', 'Done again.'),
    ev(17.1, { type: 'task_complete', turn_id: T2, duration_ms: 5100 }),
    msg(18, 'user', internal('user_goal', 'User cleared the goal.')),
    '',
  ];
  const roll = path.join(tmp('internal-context'), 'rollout.jsonl');
  fs.writeFileSync(roll, lines.join('\n'));
  times.forget();
  const marks = times.rolloutMarks(roll);
  eq([marks.turnTimes[T1].u, marks.turnTimes[T2].u], [[base + 1000], [base + 16500]],
    'a goal\'s messages to Codex are not the user\'s; the Stop hook\'s prompt, which Codex draws on the user\'s side, is');
  eq(marks.times, [base + 1000, base + 16500], 'and the whole conversation\'s list of the user\'s times holds the same two');
};
