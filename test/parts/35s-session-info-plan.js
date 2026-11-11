// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The information box's line on what the work plan has added to the conversation's context, read from a rollout
 * made for the test.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp, root }) => {
  const files = require(path.join(root, 'src', 'codex-files.js'));
  const info = require(path.join(root, 'src', 'session-info.js'));
  const home = tmp('info-plan-home');
  const id = '01a1b8e8-f7e2-7251-95a9-a95b65992111';
  const day = path.join(home, 'sessions', '2026', '11', '11');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-11-11T10-00-00-${id}.jsonl`);
  const t = (s) => `2026-11-11T10:00:${String(s).padStart(2, '0')}Z`;
  const plan = (n) => "This conversation's work plan (1 todo). " + 'r'.repeat(n);
  const dev = (s, ...texts) => ({ timestamp: t(s), type: 'response_item', payload: { type: 'message', role: 'developer',
    content: texts.map((text) => ({ type: 'input_text', text })) } });
  const tokens = (s, used) => ({ timestamp: t(s), type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: used }, model_context_window: 258400, total_token_usage: { total_tokens: used } } } });
  const started = (s) => ({ timestamp: t(s), type: 'event_msg', payload: { type: 'task_started', turn_id: `t${s}`, started_at: 1 } });
  const lines = [
    { timestamp: t(0), type: 'session_meta', payload: { id, cwd: home } },
    { timestamp: t(1), type: 'turn_context', payload: { model: 'm', effort: 'low' } },
    started(2), dev(3, plan(5000)), tokens(4, 90000),
    { timestamp: t(5), type: 'compacted', payload: { message: '', replacement_history: [dev(3, plan(5000)).payload] } },
    started(6), dev(7, plan(1000)), tokens(8, 20000),
    started(9), dev(10, plan(1960), 'The user is in Europe/Paris.'), tokens(11, 40000),
  ];
  const write = (rows) => fs.writeFileSync(rollout, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write(lines);
  files.setCodexHome(home);
  try {
    const got = info.planInjections(rollout);
    const chars = plan(1000).length + plan(1960).length;
    eq([got.count, got.chars, got.sinceCompaction], [2, chars, true],
      'only the injections after the latest compaction are counted, by the length of the work plan block alone');
    const row = (info.rows(id, { pid: '1' }).find((r) => r.label === 'Work plan') || {}).value;
    eq(row, `injected 2 times since the last compaction: ${chars} characters, about ${Math.round(chars / 4)} tokens, `
      + `${Math.round(100 * (chars / 4) / 40000)}% of the 40000 in context`, 'the information box says so in one line, against the newest token count');
    write(lines.slice(0, 5));
    eq((info.rows(id, { pid: '1' }).find((r) => r.label === 'Work plan') || {}).value,
      `injected 1 time since the conversation began: ${plan(5000).length} characters, about ${Math.round(plan(5000).length / 4)} tokens, `
        + `${Math.round(100 * (plan(5000).length / 4) / 90000)}% of the 90000 in context`, 'and says so from the start when nothing has been compacted');
    eq(info.planLine({ count: 1, chars: 103, sinceCompaction: false, whole: true }, 79000),
      'injected 1 time since the conversation began: 103 characters, about 26 tokens, under 1% of the 79000 in context',
      'a share that rounds to nothing is said as under 1%');
    write(lines.slice(0, 3));
    eq(info.rows(id, { pid: '1' }).some((r) => r.label === 'Work plan'), false, 'a conversation the plan was never injected into has no such line');
  } finally { files.setCodexHome(''); }
};
