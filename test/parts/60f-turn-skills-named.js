// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The skill search's block (route-skills.py) comes in two forms: every skill in full, or an order line that names some
 * skills given in full earlier in the conversation. The line under a reply must list the turn's skills from either
 * form. The test also checks that the hook and src/user-times.js use the same words for the order line.
 */
const fs = require('fs');
const path = require('path');

const T1 = '019a6a10-0000-7000-8000-0000000000c1';
const T2 = '019a6a10-0000-7000-8000-0000000000c2';
const T3 = '019a6a10-0000-7000-8000-0000000000c3';

module.exports = async ({ eq, tmp, root }) => {
  const times = require('../../src/user-times');
  const hook = fs.readFileSync(path.join(root, 'codex-plugin', 'agent-work-plan', 'hooks', 'route-skills.py'), 'utf8');
  const constant = (name) => { const m = new RegExp(`^${name} = "([^"]*)"`, 'm').exec(hook); return m ? m[1] : null; };
  const end = /^ORDER_END = \("([^"]*)"/m.exec(hook);
  eq([constant('ORDER_LINE'), constant('GIVEN_EARLIER'), !!end && end[1].startsWith(times.ORDER_END)], [times.ORDER_LINE, times.GIVEN_EARLIER, true],
    'the order line is read with the words the hook writes it with');

  const iso = (s) => new Date(Date.UTC(2026, 10, 15, 10, 0, s)).toISOString();
  const row = (s, type, payload) => JSON.stringify({ timestamp: iso(s), type, payload });
  const dev = (s, turn, text) => row(s, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['hooks.additional_context'] } });
  const head = `${times.ROUTE_MARK}, found by searching every installed skill for it. Judge whether one really fits.`;
  const full = (n) => `- ${n}: what it does. Use when it fits (file: /skills/${n.split(':').pop()}/SKILL.md)`;
  const order = (items) => `${times.ORDER_LINE}${items.map(([n, earlier]) => n + (earlier ? times.GIVEN_EARLIER : '')).join(', ')}`
    + '. Those given earlier had their description and file given in full earlier in this conversation and are not repeated here.';
  const lines = [
    row(0, 'turn_context', { turn_id: T1, model: 'gpt-x', effort: 'low' }),
    dev(1, T1, [head, full('Tools-all:disk-cleanup'), full('web-fetching'), full('git-identity')].join('\n')),
    row(2, 'turn_context', { turn_id: T2, model: 'gpt-x', effort: 'low' }),
    dev(3, T2, [head, order([['Tools-all:disk-cleanup', true], ['periodic-wakeup', false], ['web-fetching', true]]), full('periodic-wakeup')].join('\n')),
    row(4, 'turn_context', { turn_id: T3, model: 'gpt-x', effort: 'low' }),
    dev(5, T3, [head, order([['web-fetching', true], ['Tools-all:disk-cleanup', true]])].join('\n')),
    '',
  ];
  const roll = path.join(tmp('turn-skills-named'), 'rollout.jsonl');
  fs.writeFileSync(roll, lines.join('\n'));
  times.forget();
  const turns = times.rolloutMarks(roll).turns;
  eq(turns[T1], 'gpt-x low · skills disk-cleanup, web-fetching, git-identity', 'a block giving every skill in full lists them as before');
  eq(turns[T2], 'gpt-x low · skills disk-cleanup, periodic-wakeup, web-fetching',
    'one naming some of them lists every skill once, in the order of fit the line gives, the new one among them');
  eq(turns[T3], 'gpt-x low · skills web-fetching, disk-cleanup', 'and one that only names them lists them all');

  const workplan = require('../../src/workplan');
  const plans = tmp('plans');
  const [gone, orphan] = [T1, T2];
  for (const id of [gone, orphan]) fs.writeFileSync(path.join(plans, `${id}.routed`), '{}');
  const old = Date.now() / 1000 - 30 * 24 * 3600;
  fs.utimesSync(path.join(plans, `${orphan}.routed`), old, old);
  workplan.removeSideFiles(plans, [gone]);
  workplan.sweepOrphans({ dir: plans, live: new Set(), home: tmp('no-codex-home') });
  eq(fs.readdirSync(plans), [], 'the skill search\'s record is deleted with its conversation, and swept once its conversation is gone');
};
