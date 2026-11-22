// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the end of a rollout says about the user's last message and the newest turn that ended, for `lastUserAt` and
 * `unseen` (src/codex-files.js rolloutState). The rows copy the shapes of a rollout from a window test, with made-up
 * words: a goal's messages to Codex, a Stop hook's prompt and Codex's environment block are on the user's side of the
 * rollout and are not the user's.
 */
const fake = require('../fake-vscode');
const fixture = require('../fixture');

module.exports = async ({ eq, tmp }) => {
  const { vscode } = fake.create();
  fake.install(vscode);
  const files = require('../../src/codex-files');
  const T1 = '01a2f1f1-0000-7000-8000-0000000000a1', T2 = '01a2f1f1-0000-7000-8000-0000000000a2', T3 = '01a2f1f1-0000-7000-8000-0000000000a3';
  const base = Date.UTC(2026, 10, 22, 3, 0, 0);
  const ms = (s) => base + s * 1000;
  const iso = (s) => new Date(ms(s)).toISOString();
  const ev = (s, payload) => JSON.stringify({ timestamp: iso(s), type: 'event_msg', payload });
  const ctx = (s, id) => JSON.stringify({ timestamp: iso(s), type: 'turn_context', payload: { turn_id: id, model: 'gpt-x', effort: 'low' } });
  const msg = (s, role, text) => JSON.stringify({ timestamp: iso(s), type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
  const internal = (source, text) => `<codex_internal_context source="${source}">\n${text}\n</codex_internal_context>`;
  const turn1 = [
    ev(0, { type: 'task_started', turn_id: T1, started_at: Math.floor(ms(0) / 1000) }),
    ctx(0, T1),
    msg(0.5, 'user', '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>'),
    msg(1, 'user', 'Read the whole build log.'),
    msg(2, 'assistant', 'Read it.'),
    ev(3, { type: 'task_complete', turn_id: T1, duration_ms: 3000, completed_at: Math.floor(ms(3) / 1000) }),
  ];
  /* A turn a goal started has no message the user typed. */
  const turn2 = [
    msg(10, 'user', internal('user_goal', 'User set the goal: "Make the export faster".')),
    ev(12, { type: 'task_started', turn_id: T2, started_at: Math.floor(ms(12) / 1000) }),
    ctx(12, T2),
    msg(12, 'user', internal('goal', 'Continue working toward the active thread goal.')),
    msg(16, 'assistant', 'Done.'),
    msg(16.5, 'user', '<hook_prompt hook_run_id="stop:10:/plugins/agent-work-plan">The summary was written before the context was compacted.</hook_prompt>'),
    msg(17, 'assistant', 'Done again.'),
    ev(20, { type: 'task_complete', turn_id: T2, duration_ms: 8000, completed_at: Math.floor(ms(20) / 1000) }),
  ];
  const turn3 = [
    ev(30, { type: 'task_started', turn_id: T3, started_at: Math.floor(ms(30) / 1000) }),
    ctx(30, T3),
    msg(30.2, 'user', '  Run the tests again, please.'),
    msg(32, 'assistant', 'Running them.'),
  ];
  /* rolloutState takes its lines newest first. */
  const state = (lines) => files.rolloutState('', lines.slice().reverse());

  let st = state([...turn1, ...turn2]);
  eq([st.working, st.lastUserMs, st.endedMs, st.lastEndedMs], [false, ms(1), ms(20), ms(20)],
    'the user\'s last message is the one they typed in the turn before, not the goal\'s messages, the hook\'s prompt or Codex\'s environment block');
  st = state([...turn1, ...turn2, ...turn3]);
  eq([st.working, st.lastUserMs, st.endedMs, st.lastEndedMs], [true, ms(30.2), 0, ms(20)],
    'while a turn runs, its own message is the last one, and the newest turn that ended is the one before it');
  st = state(turn1.slice(0, 4));
  eq([st.working, st.lastUserMs, st.lastEndedMs], [true, ms(1), 0], 'a first turn still running has no turn ended yet');
  st = state(turn2);
  eq([st.lastUserMs, st.lastEndedMs], [0, ms(20)], 'a rollout end that holds no message the user typed has none');

  /* ── through a whole rollout file, as the worker reads it ── */
  const home = tmp('home');
  const made = fixture.codexHome(home, [{ title: 'Two turns', cwd: home, turns: [{ prompt: 'First.' }, { prompt: 'Second.' }] },
    { title: 'Running', cwd: home, turns: [{ prompt: 'First.' }, { prompt: 'Second.', running: true }] }]);
  const read = (t) => files.rolloutState(t.rollout);
  /* The fixture writes completed_at in whole seconds, as Codex does. */
  const endOf = (turn) => Math.floor((turn.startMs + 5000) / 1000) * 1000;
  eq([read(made[0]).lastUserMs, read(made[0]).lastEndedMs], [made[0].turns[1].startMs + 1, endOf(made[0].turns[1])],
    'a rollout file read from its end gives the second message\'s time and the second turn\'s end');
  eq([read(made[1]).working, read(made[1]).lastUserMs, read(made[1]).lastEndedMs], [true, made[1].turns[1].startMs + 1, endOf(made[1].turns[0])],
    'and with the second turn running, the first turn\'s end');
};
