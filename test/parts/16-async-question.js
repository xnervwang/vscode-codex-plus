// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's asynchronous question (the request_user_input_async tool): the card stays on the page while the tool returns
 * at once and the turn goes on to finish, and the answer arrives as the next user message. No app-server request
 * stands for it, so it is read from the rollout. The lines below have the shape Codex 26.1021 writes them in: the
 * call, its { accepted } output, the turn's end, and the answer opening a turn of its own. In Codex 26.1117 the card's
 * answer is sent into the turn while it still runs, as a user message holding a <send_user_message_question_reply>
 * block, and the turn finishes after it.
 */
const fs = require('fs');
const path = require('path');

const line = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
const turn = (ts, id) => [
  line(ts, 'event_msg', { type: 'task_started', turn_id: id, started_at: Date.parse(ts) / 1000 }),
  line(ts, 'turn_context', { model: 'gpt-test', effort: 'high' }),
];
const asked = (ts) => [
  line(ts, 'response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'call_q',
    arguments: JSON.stringify({ questions: [{ title: 'Which one?', options: ['a', 'b'] }] }) }),
  line(ts, 'response_item', { type: 'function_call_output', call_id: 'call_q', output: JSON.stringify({ accepted: true }) }),
];
const ended = (ts, id) => [line(ts, 'event_msg', { type: 'task_complete', turn_id: id, completed_at: Date.parse(ts) / 1000, duration_ms: 3000 })];
const answered = (ts) => [line(ts, 'event_msg', { type: 'user_message', message: 'b' })];
const userSays = (ts, text) => [line(ts, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })];
const reply = (ts) => userSays(ts, '<send_user_message_question_reply>\n'
  + JSON.stringify([{ questionItemId: 'q1', question: 'Which one?', answer: 'b' }]) + '\n</send_user_message_question_reply>');
const said = (ts) => [line(ts, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] })];

module.exports = async ({ eq, tmp, root }) => {
  const files = require(path.join(root, 'src', 'codex-files'));
  const { conversationOf } = require(path.join(root, 'src', 'codex-source'));
  const patching = require(path.join(root, 'src', 'patching'));
  const write = (name, lines) => { const f = path.join(tmp('async-q'), name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

  const waiting = files.rolloutState(write('waiting.jsonl', [
    ...turn('2026-02-11T05:51:53.211Z', 't1'), ...asked('2026-02-11T05:51:58.759Z'), ...ended('2026-02-11T05:52:01.842Z', 't1')]));
  eq([waiting.working, waiting.askedMs > 0], [false, true], 'a question asked in the last turn, which has ended, is waiting for the user');

  const running = files.rolloutState(write('running.jsonl', [
    ...turn('2026-02-11T05:51:53.211Z', 't1'), ...asked('2026-02-11T05:51:58.759Z')]));
  eq([running.working, running.askedMs > 0], [true, true], 'while its turn still runs, the rollout says both');

  const answer = files.rolloutState(write('answered.jsonl', [
    ...turn('2026-02-11T05:51:53.211Z', 't1'), ...asked('2026-02-11T05:51:58.759Z'), ...ended('2026-02-11T05:52:01.842Z', 't1'),
    ...turn('2026-02-11T05:59:26.709Z', 't2'), ...answered('2026-02-11T05:59:26.756Z'), ...ended('2026-02-11T06:00:03.200Z', 't2')]));
  eq(answer.askedMs, 0, 'a question from an earlier turn has been answered by the turn that followed it');

  const inTurn = files.rolloutState(write('answered-in-turn.jsonl', [
    ...turn('2026-02-19T01:01:22.211Z', 't1'), ...asked('2026-02-19T01:40:41.211Z'), ...reply('2026-02-19T01:44:03.211Z'),
    ...asked('2026-02-19T02:58:04.211Z'), ...reply('2026-02-19T03:06:03.211Z'), ...said('2026-02-19T03:50:43.211Z'),
    ...ended('2026-02-19T03:50:57.211Z', 't1')]));
  eq([inTurn.working, inTurn.askedMs], [false, 0], 'questions the card answered while their turn still ran are not waiting once that turn has ended');
  const typed = files.rolloutState(write('typed-in-turn.jsonl', [
    ...turn('2026-02-19T01:01:22.211Z', 't1'), ...asked('2026-02-19T01:40:41.211Z'), ...userSays('2026-02-19T01:48:29.211Z', 'take b'),
    ...ended('2026-02-19T01:57:13.211Z', 't1')]));
  eq(typed.askedMs, 0, 'nor one the user answered by typing into the turn');
  const second = files.rolloutState(write('answered-first.jsonl', [
    ...turn('2026-02-19T01:01:22.211Z', 't1'), ...asked('2026-02-19T01:40:41.211Z'), ...reply('2026-02-19T01:44:03.211Z'),
    ...asked('2026-02-19T02:58:04.211Z'), ...ended('2026-02-19T03:50:57.211Z', 't1')]));
  eq(second.askedMs, Date.parse('2026-02-19T02:58:04.211Z'), 'a second question asked after the first was answered still waits');

  const thread = { id: '01a1c2dd-39e8-7142-b569-2ed9ec1f23cc', title: 't', cwd: '/', updatedMs: Date.now() };
  const as = (st) => conversationOf(thread, { unread: new Set([thread.id]), openHere: new Set(), state: { ...st, lastActivityMs: Date.now() } });
  eq([as(waiting).state, as(waiting).asking], ['prompt', true], 'a conversation waiting on its question is shown as waiting for the user, over unread');
  eq([as(running).state, as(running).asking], ['working', false], 'not while the turn that asked is still running');
  eq([as(answer).state, as(answer).asking], ['unread', false], 'and not once answered');
  eq([as(inTurn).state, as(inTurn).asking, as(inTurn).activity], ['unread', false, 'stopped'],
    'a conversation whose questions were answered inside the turn has no red dot: it is unread and stopped, not waiting');

  eq([patching.turnEndChime({ working: false, asking: true }), patching.turnEndChime({ working: false, asking: false })],
    ['question', 'done'], 'a turn that ends on a question rings the question chime instead of the finished one');
};
