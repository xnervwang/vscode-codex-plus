// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A made-up CODEX_HOME: a config.toml and one conversation's rollout, in the shape Codex's app-server reads
 * (history_mode legacy, where it builds each turn from the user_message and agent_message events). Every word is
 * invented here; nothing is read from the user's own Codex home.
 */
const fs = require('fs');
const path = require('path');

const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const CWD = '/home/demo/projects/inventory-service';
const MODEL = 'gpt-6.1-sol';
const WINDOW = 400000;

const FOUR = [
  { user: 'Can you find where the retry delay for the inventory sync is set?',
    reply: ['The retry delay lives in `src/sync/retry.ts`. It starts at 250 ms and doubles up to a cap of 8 s.',
      'The cap comes from `MAX_BACKOFF_MS`, which is also read by the health check.'] },
  { user: 'Make the cap configurable and keep 8 s as the default.',
    reply: ['Done. `MAX_BACKOFF_MS` now reads `SYNC_MAX_BACKOFF_MS` from the environment and falls back to 8000.',
      '| File | Change |\n| --- | --- |\n| src/sync/retry.ts | read the cap from the environment |\n| src/health.ts | use the same constant |\n| test/retry.test.ts | two new cases |'] },
  { user: 'Run the tests.', reply: ['All 48 tests pass. The two new cases cover the default and an override of 2000 ms.'] },
  { user: 'Write a one-line summary for the commit message.',
    reply: ['Make the inventory sync backoff cap configurable through SYNC_MAX_BACKOFF_MS.'] },
];

const TOPICS = ['the retry delay', 'the health check', 'the cache key', 'the batch size', 'the warehouse filter', 'the log level',
  'the import job', 'the price rounding', 'the stock alert', 'the CSV export', 'the timeout', 'the sort order', 'the schema check'];

/* `count` made-up turns, for a conversation long enough that Codex's turn list keeps only part of it mounted. */
function manyTurns(count) {
  return Array.from({ length: count }, (_, i) => {
    const topic = TOPICS[i % TOPICS.length];
    return { user: `Step ${i + 1}: look at ${topic} in the inventory service and tell me what it does now.`,
      reply: [`Step ${i + 1}. ${topic[0].toUpperCase()}${topic.slice(1)} is read once at start-up from the service config and kept for the life of the process.`,
        `Changing it needs a restart. Nothing else in the service reads it, so a change is local to this one module.`] };
  });
}

const iso = (ms) => new Date(ms).toISOString();
const turnId = (i) => `0199a1b2-0000-7000-8000-${String(i + 1).padStart(12, '0')}`;

/* The page is run in this zone (run.js), so it is the one whose "today" the schedule is laid out in. */
const ZONE = 'America/Los_Angeles';
const zoneHour = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', hour: 'numeric' }).format(ms));
const zoneDate = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric' })
  .formatToParts(ms).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
/* `hour`:02:11 in the zone, `ago` days before the zone's date of `now`. */
function inZone(now, ago, hour) {
  const d = zoneDate(now);
  const guess = Date.UTC(d.year, d.month - 1, d.day - ago, hour + 8, 2, 11);
  return guess - (zoneHour(guess) - hour) * 3600000;
}

/*
 * When each turn's message was sent. `days` is a list of [days before today, turns that day]; a day's turns start at
 * 09:02 in the zone and are about two minutes apart, closer together when today has not had room for them yet, so
 * that every one of today's is before `now` and after the zone's midnight.
 */
function schedule(days, now = Date.now()) {
  const out = [];
  for (const [ago, n] of days) {
    let start = inZone(now, ago, 9), step = 126000;
    if (ago === 0 && start + n * step > now - 60000) {
      const midnight = inZone(now, 0, 0) - 131000;
      start = Math.max(midnight + 60000, now - 60000 - n * step);
      step = Math.max(1000, Math.floor((now - 60000 - start) / n));
    }
    for (let i = 0; i < n; i++) out.push(start + i * step);
  }
  return out;
}

function rollout(turns, sent) {
  const rows = [];
  const row = (ms, type, payload) => rows.push({ timestamp: iso(ms), type, payload });
  const t0 = sent[0] - 1000;
  row(t0, 'session_meta', { session_id: THREAD, id: THREAD, timestamp: iso(t0), cwd: CWD, runtime_workspace_roots: [CWD],
    originator: 'codex_vscode', cli_version: '0.164.0-alpha.11', source: 'vscode', thread_source: 'user', model_provider: 'openai',
    base_instructions: { text: 'You are a coding agent.', provenance: { type: 'model', model: MODEL } }, history_mode: 'legacy' });
  turns.forEach((turn, i) => {
    const id = turnId(i);
    const t = sent[i];
    row(t, 'event_msg', { type: 'task_started', turn_id: id, root_turn_id: id, started_at: Math.floor(t / 1000), model_context_window: WINDOW, collaboration_mode_kind: 'default' });
    row(t, 'turn_context', { turn_id: id, root_turn_id: id, cwd: CWD, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' },
      model: MODEL, effort: i % 2 ? 'medium' : 'high', summary: 'auto' });
    if (i === 0) row(t, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${CWD}</cwd>\n</environment_context>` }] });
    row(t, 'response_item', { type: 'message', id: `msg_u${i}`, role: 'user', content: [{ type: 'input_text', text: turn.user }],
      internal_chat_message_metadata_passthrough: { turn_id: id, create_time: t / 1000 } });
    row(t, 'event_msg', { type: 'user_message', message: turn.user, images: [], local_images: [], text_elements: [] });
    const done = t + 9000 + (i % 4) * 4000;
    row(done - 200, 'response_item', { type: 'message', status: 'completed', id: `msg_a${i}`, role: 'assistant',
      content: [{ type: 'output_text', text: turn.reply.join('\n\n'), annotations: [], logprobs: [] }], phase: 'final_answer',
      internal_chat_message_metadata_passthrough: { turn_id: id } });
    row(done - 200, 'event_msg', { type: 'agent_message', message: turn.reply.join('\n\n'), phase: 'final_answer' });
    const used = Math.min(WINDOW - 8000, 52000 + i * 9000);
    const usage = { input_tokens: used, cached_input_tokens: 0, output_tokens: 900, reasoning_output_tokens: 300, total_tokens: used + 900 };
    row(done - 100, 'event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: WINDOW }, rate_limits: null });
    row(done, 'event_msg', { type: 'task_complete', turn_id: id, root_turn_id: id, last_agent_message: turn.reply[turn.reply.length - 1],
      started_at: Math.floor(t / 1000), completed_at: Math.floor(done / 1000), duration_ms: done - t });
  });
  return rows;
}

/*
 * Write the home under `dir` and return what the page script's host would send for it: the user's message times and
 * each turn's line of figures, keyed by turn id.
 */
function write(dir, { turns = FOUR, days = [[0, turns.length]], now = Date.now() } = {}) {
  const sent = schedule(days, now);
  if (sent.length !== turns.length) throw new Error(`the schedule has ${sent.length} turns and the conversation ${turns.length}`);
  const home = path.join(dir, 'codex-home');
  const d = new Date(sent[0] - 1000);
  const day = path.join(home, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "${MODEL}"\nmodel_reasoning_effort = "high"\n[analytics]\nenabled = false\n`);
  const stamp = iso(sent[0] - 1000).slice(0, 19).replace(/:/g, '-');
  fs.writeFileSync(path.join(day, `rollout-${stamp}-${THREAD}.jsonl`), rollout(turns, sent).map((r) => JSON.stringify(r)).join('\n') + '\n');
  const fakeHome = path.join(dir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const figures = {};
  turns.forEach((_, i) => {
    figures[turnId(i)] = `ctx ${Math.round(100 * Math.min(WINDOW - 8000, 52000 + i * 9000) / WINDOW)}% · ${MODEL} ${i % 2 ? 'medium' : 'high'}`;
  });
  return { codexHome: home, home: fakeHome, times: sent, figures };
}

module.exports = { write, manyTurns, FOUR, THREAD, CWD, MODEL, turnId };
