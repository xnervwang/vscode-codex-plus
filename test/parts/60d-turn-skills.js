// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which skills a turn was given by the work plan plugin's skill search (codex-plugin/agent-work-plan/hooks/
 * route-skills.py), shown after that turn's figures on the line under its reply. Codex records each hook's injected text
 * in the rollout as a developer message carrying the turn's id, and the host reads the skill names out of the block that
 * begins with the plugin's fixed first words (src/user-times.js ROUTE_MARK).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const T1 = '019a6a10-0000-7000-8000-0000000000b1';
const T2 = '019a6a10-0000-7000-8000-0000000000b2';
const T3 = '019a6a10-0000-7000-8000-0000000000b3';
const T4 = '019a6a10-0000-7000-8000-0000000000b4';

module.exports = async ({ eq, tmp, root }) => {
  const times = require('../../src/user-times');
  const iso = (s) => new Date(Date.UTC(2026, 10, 9, 10, 0, s)).toISOString();
  const row = (s, type, payload) => JSON.stringify({ timestamp: iso(s), type, payload });
  const dev = (s, turn, parts) => row(s, 'response_item', { type: 'message', role: 'developer',
    content: parts.map((text) => ({ type: 'input_text', text })),
    internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: parts.map(() => 'hooks.additional_context') } });
  const route = (names) => [`${times.ROUTE_MARK}, found by searching every installed skill for it. Judge whether one really fits.`,
    ...names.map((n) => `- ${n}: what it does. Use when it fits (file: /skills/${n.split(':').pop()}/SKILL.md)`)].join('\n');
  const lines = [
    row(0, 'turn_context', { turn_id: T1, model: 'gpt-x', effort: 'low' }),
    dev(1, T1, ['The user is in a time zone.', route(['Tools-all:disk-cleanup', 'web-fetching'])]),
    row(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the disk is full' }] }),
    row(3, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 2000 }, model_context_window: 10000 } }),
    row(4, 'turn_context', { turn_id: T2, model: 'gpt-x', effort: 'low' }),
    dev(5, T2, [`${times.ROUTE_MARK}, but nothing follows it`]),
    row(6, 'turn_context', { turn_id: T3, model: 'gpt-x', effort: 'low' }),
    dev(7, T3, ['This conversation\'s work plan (1 doing).\n- a row that looks like a skill: but is not']),
    row(8, 'turn_context', { turn_id: T4, model: 'gpt-x', effort: 'low' }),
    dev(9, 'some-other-turn', [route(['periodic-wakeup'])]),
    dev(10, T4, [route(Array.from({ length: 10 }, (_, i) => `Plugin-all:a-rather-long-skill-name-number-${i}`))]),
    '',
  ];
  const roll = path.join(tmp('turn-skills'), 'rollout.jsonl');
  fs.writeFileSync(roll, lines.join('\n'));
  times.forget();
  const turns = times.rolloutMarks(roll).turns;
  eq(turns[T1], 'ctx 20% · gpt-x low · skills disk-cleanup, web-fetching',
    'a turn given skills shows their names after its figures, without the plugin prefix');
  eq([turns[T2], turns[T3]], ['gpt-x low', 'gpt-x low'],
    'a block with the first words and no skill under them, and another hook\'s block with rows of its own, add nothing');
  eq(turns['some-other-turn'], undefined, 'a block is credited to the turn its own id names, not to the turn last begun');
  eq(/^gpt-x low · skills a-rather-long-skill-name-number-0, .* a-rather-long-skill-name-number-9$/.test(turns[T4] || ''), true,
    'ten long names are all shown');

  const plain = path.join(tmp('turn-skills-old'), 'rollout.jsonl');
  fs.writeFileSync(plain, [row(0, 'turn_context', { turn_id: T1, model: 'gpt-x', effort: 'low' }),
    row(1, 'response_item', { type: 'message', role: 'developer', content: 'not a list of parts' }),
    row(2, 'response_item', { type: 'message', role: 'developer' }), '{"type":"response_item","payload":{"role":"developer", Skills that may', ''].join('\n'));
  times.forget();
  eq(times.rolloutMarks(plain).turns, { [T1]: 'gpt-x low' }, 'a conversation from before the skill search, and broken rows, show no skills');

  /* The page takes a figures line that long: ten skill names run to about 400 characters. */
  const dom = createDom();
  const { el } = dom;
  const reply = el('div', { attrs: { 'data-response-annotation-target': '' }, kids: [
    el('h4', { attrs: { 'data-conversation-role': 'assistant' }, texts: ['Codex said'] }), el('p', { texts: ['an answer'] }),
    el('div', { kids: [el('span', { attrs: { 'data-assistant-message-sent-time': 'true' }, kids: [el('span', { texts: ['10:00 AM'] })] })] })] });
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [
    el('div', { attrs: { 'data-turn-key': T4 }, kids: [el('div', { attrs: { 'data-content-search-turn-key': T4 },
      kids: [el('div', { kids: [el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [reply] })] })] })] })] })] }));
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: () => {} }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' } };
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  listeners.message({ data: { type: 'codex-extras-view', timestamps: true, navigation: true } });
  const long = `ctx 9% · gpt-x low · skills ${Array.from({ length: 10 }, (_, i) => `a-rather-long-skill-name-number-${i}`).join(', ')}`;
  listeners.message({ data: { type: 'codex-extras-user-times', times: null, compactions: [], turns: { [T4]: long }, turnTimes: {} } });
  const stamp = reply.children.find((k) => k.getAttribute('data-codex-extras') === 'stamp');
  eq(stamp ? stamp.getAttribute('data-codex-extras-figures') : null, ` · ${long}`, `the page draws the whole line under the reply (${long.length} characters)`);
};
