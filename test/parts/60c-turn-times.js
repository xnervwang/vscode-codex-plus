// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Per-turn times, keyed by turn id: when each user message in the turn was sent, when each reply was written, and how
 * long the turn took. The host reads them from the rollout (src/user-times.js) and the page matches them by the turn id
 * Codex puts on the turn, so stamps show seconds in long conversations and on earlier days too, where matching all of
 * the conversation's messages by count fails. A turn's duration is added to its reply line only when Codex shows no
 * "Worked for" of its own.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('../fake-dom');

const T1 = '019a6a10-0000-7000-8000-0000000000a1';
const T2 = '019a6a10-0000-7000-8000-0000000000a2';
const T3 = '019a6a10-0000-7000-8000-0000000000a3';

function pageUnder(root, dom) {
  const posted = [];
  const listeners = {};
  const win = { acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }), addEventListener: (t, fn) => { listeners[t] = fn; },
    location: { pathname: '/index.html', hash: '' } };
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page', 'codex-extras-page.js'), 'utf8'), vm.createContext(Object.assign({ globalThis: win }, dom.sandbox)));
  return { posted, send(m) { listeners.message({ data: m }); } };
}

module.exports = async ({ eq, tmp, root }) => {
  /* ── the host: each turn's times, out of a rollout written as Codex writes one ── */
  const times = require('../../src/user-times');
  const day = new Date();
  day.setDate(day.getDate() - 1);
  const at = (h, m, s, ms = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s, ms).getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const ev = (ms, payload) => JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload });
  const msg = (ms, role, text) => JSON.stringify({ timestamp: iso(ms), type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
  const lines = [
    ev(at(22, 35, 0), { type: 'task_started', turn_id: T1, started_at: Math.floor(at(22, 35, 0) / 1000) }),
    JSON.stringify({ timestamp: iso(at(22, 35, 0, 1)), type: 'turn_context', payload: { turn_id: T1, model: 'gpt-x', effort: 'low' } }),
    msg(at(22, 35, 1, 250), 'user', '<environment_context>x</environment_context>'),
    msg(at(22, 35, 1, 250), 'user', 'first question'),
    JSON.stringify({ timestamp: iso(at(22, 35, 2)), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1' } }),
    msg(at(22, 35, 9, 400), 'assistant', 'first answer'),
    ev(at(22, 35, 9, 500), { type: 'task_complete', turn_id: T1, duration_ms: 9400, completed_at: Math.floor(at(22, 35, 9) / 1000) }),
    ev(at(22, 36, 0), { type: 'task_started', turn_id: T2, started_at: Math.floor(at(22, 36, 0) / 1000) }),
    msg(at(22, 36, 0, 900), 'user', 'second question'),
    msg(at(22, 36, 3), 'user', 'and one more thing'),
    msg(at(22, 36, 5, 100), 'assistant', 'second answer'),
    ev(at(22, 36, 5, 200), { type: 'task_complete', turn_id: T2, duration_ms: 5200, completed_at: Math.floor(at(22, 36, 5) / 1000) }),
    ev(at(22, 40, 0), { type: 'task_started', turn_id: T3, started_at: Math.floor(at(22, 40, 0) / 1000) }),
    msg(at(22, 40, 0, 500), 'user', 'still running'),
    '',
  ];
  const roll = path.join(tmp('turn-times'), 'rollout.jsonl');
  fs.writeFileSync(roll, lines.join('\n'));
  times.forget();
  const marks = times.rolloutMarks(roll);
  eq(marks.turnTimes, {
    [T1]: { u: [at(22, 35, 1, 250)], r: [at(22, 35, 9, 400)], d: 9400 },
    [T2]: { u: [at(22, 36, 0, 900), at(22, 36, 3)], r: [at(22, 36, 5, 100)], d: 5200 },
    [T3]: { u: [at(22, 40, 0, 500)], r: [] },
  }, 'each turn has the times of the messages the user typed in it, of its replies, and once it has ended how long it took');
  eq(marks.times.length, 4, 'and the whole conversation\'s list of the user\'s times is what it was');

  /* ── the page: a long conversation whose earlier days are not drawn, so no divider says which day it is ── */
  const dom = createDom();
  const { el } = dom;
  const userEl = (clock, words, steered) => el('div', { attrs: steered ? { 'data-content-search-unit-key': 'u' } : { 'data-local-conversation-user-anchor': '', 'data-content-search-unit-key': 'u' },
    kids: [el('div', { attrs: { 'data-user-message-bubble': '' }, kids: [el('p', { texts: [words] })] }),
      el('div', { kids: [el('span', { kids: clock ? [el('span', { texts: [clock] })] : [] })] })] });
  const replyEl = (clock) => el('div', { attrs: { 'data-response-annotation-target': '' }, kids: [
    el('h4', { attrs: { 'data-conversation-role': 'assistant' }, texts: ['Codex said'] }), el('p', { texts: ['an answer'] }),
    el('div', { kids: [el('span', { attrs: { 'data-assistant-message-sent-time': 'true' }, kids: [el('span', { texts: [clock] })] })] })] });
  /* Codex's own "Worked for": an expanding button in the turn, outside its messages. */
  const worked = () => el('div', { kids: [el('button', { attrs: { 'aria-expanded': 'false', type: 'button' }, kids: [el('span', { texts: ['Worked for 9s'] })] })] });
  const turnEl = (key, users, reply, withWorked) => el('div', { attrs: { 'data-turn-key': key }, kids: [el('div', { attrs: { 'data-content-search-turn-key': key },
    kids: [el('div', { kids: [...users, ...(withWorked ? [worked()] : []), el('div', { attrs: { 'data-local-conversation-final-assistant': '' }, kids: [reply] })] })] })] });
  const u1 = userEl('10:35 PM', 'first question'), r1 = replyEl('10:35 PM');
  const u2 = userEl('10:36 PM', 'second question'), u2b = userEl('', 'and one more thing', true), r2 = replyEl('10:36 PM');
  const u3 = userEl('10:40 PM', 'still running');
  dom.setBody(el('body', { kids: [el('div', { attrs: { 'data-app-action-timeline-scroll': '' }, rect: { top: 0, height: 600 }, kids: [
    turnEl(T1, [u1], r1, true), turnEl(T2, [u2, u2b], r2, false), turnEl(T3, [u3], el('div', {}), false)] })] }));
  const page = pageUnder(root, dom);
  const view = (over = {}) => page.send(Object.assign({ type: 'codex-extras-view', timestamps: true, navigation: true, userEdge: true }, over));
  view();
  const stamp = (host) => host.children.find((k) => k.getAttribute('data-codex-extras') === 'stamp') || null;
  const said = (host) => { const s = stamp(host); return s ? s.textContent : null; };
  const line = (host) => { const s = stamp(host); return s ? s.getAttribute('data-codex-extras-figures') : null; };
  eq([said(u1), said(r1)], ['22:35', '22:35'], 'with nothing from the host, a turn from a day the page does not show is read as today, to the minute');

  const md = `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`;
  const pre = day.getFullYear() === new Date().getFullYear() ? md : `${day.getFullYear()}/${md}`;
  page.send({ type: 'codex-extras-user-times', times: [1, 2, 3], compactions: [], turns: { [T2]: 'ctx 12% · gpt-x low' }, turnTimes: marks.turnTimes });
  eq([said(u1), said(r1), said(u2), said(u2b), said(r2), said(u3)],
    [`${pre} 22:35:01`, `${pre} 22:35:09`, `${pre} 22:36:00`, `${pre} 22:36:03`, `${pre} 22:36:05`, `${pre} 22:40:00`],
    'by turn id, every message and reply gets its own day and its seconds, though the conversation\'s counts do not line up (the host sent three times for four messages)');
  eq([line(r1), line(r2)], [null, ' 5s · ctx 12% · gpt-x low'],
    'a turn\'s duration goes after its reply\'s time where Codex shows no "Worked for" of its own, and nowhere it does');
  view({ replyDuration: false });
  eq(line(r2), ' · ctx 12% · gpt-x low', 'codexPlus.replyDuration off leaves it off');
  view();

  /* A turn whose count of messages differs from the rollout's is left to what the page itself shows. */
  page.send({ type: 'codex-extras-user-times', times: null, compactions: [], turns: {},
    turnTimes: { [T2]: { u: [at(22, 36, 0, 900)], r: [at(22, 36, 5, 100)], d: 5200 } } });
  eq([said(u2), said(u2b)], ['22:36', null], 'with one time for a turn that shows two messages, neither message takes it');
  /* A reply time that is not in the minute Codex shows on that reply is not taken for it. */
  page.send({ type: 'codex-extras-user-times', times: null, compactions: [], turns: {},
    turnTimes: { [T1]: { u: [at(22, 35, 1, 250)], r: [at(22, 34, 59)], d: 9400 } } });
  eq([said(u1), said(r1)], [`${pre} 22:35:01`, '22:35'], 'and a reply time a minute off what Codex shows on that reply is not used for it');
  eq(JSON.stringify(page.posted).includes('question'), false, 'nothing of the conversation is posted back');
};
