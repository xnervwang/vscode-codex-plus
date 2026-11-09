// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A stand-in CODEX_HOME: a state database with the columns the extension reads, and rollouts written line by line the
 * way Codex writes them. The column list and the line shapes are copied from a real Codex 0.164 home.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA = `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL DEFAULT 'x', cwd TEXT NOT NULL,
  title TEXT NOT NULL, sandbox_policy TEXT NOT NULL DEFAULT '', approval_mode TEXT NOT NULL DEFAULT '',
  tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER, git_branch TEXT, cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '',
  model TEXT, reasoning_effort TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT,
  preview TEXT NOT NULL DEFAULT '', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, thread_section_id TEXT,
  originator TEXT);
CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL, appearance TEXT);
CREATE TABLE thread_read_receipts (thread_id TEXT PRIMARY KEY, first_unread_turn TEXT, revision TEXT NOT NULL,
  last_published_turn TEXT);`;

let seq = 0;
/** A thread id shaped like Codex's. */
function threadId() {
  seq++;
  const h = (n, w) => n.toString(16).padStart(w, '0').slice(-w);
  return `01a1${h(seq, 4)}-0000-7000-8000-${h(seq * 7919, 12)}`;
}

function iso(ms) { return new Date(ms).toISOString(); }

/*
 * The two rows Codex 0.164 in VS Code writes for one message the user sent: the response_item that carries it to the
 * model, then an item_completed event whose item is a UserMessage. Shaped after the 120 user messages in the 49
 * rollouts of a real home (keys and value kinds only); none of those rollouts held the older user_message event, which
 * Codex writes only for a thread in its legacy history mode.
 */
function userMessageRows({ at, threadId: thread, turnId, text = 'hi', item = 1 }) {
  return [
    { timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'user',
      id: `msg_${turnId}`, content: [{ type: 'input_text', text }] } },
    { timestamp: iso(at), type: 'event_msg', ordinal: item, payload: { type: 'item_completed', thread_id: thread,
      turn_id: turnId, item: { type: 'UserMessage', id: `item-${item}`, content: [{ type: 'text', text, text_elements: [] }] },
      completed_at_ms: at } },
  ];
}

/** Rollout lines for one thread: a session_meta and then each turn given. */
function rolloutLines({ id, cwd, source = 'vscode', turns = [], startMs }) {
  const out = [{ timestamp: iso(startMs), type: 'session_meta', payload: { id, session_id: id, cwd, source,
    originator: 'codex_vscode', cli_version: '0.164.0' } }];
  for (const t of turns) {
    const at = t.startMs;
    out.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: t.id,
      started_at: Math.floor(at / 1000), model_context_window: 258400 } });
    out.push({ timestamp: iso(at), type: 'turn_context', payload: { turn_id: t.id, model: t.model || 'gpt-test',
      effort: t.effort || 'low', cwd } });
    out.push(...userMessageRows({ at: at + 1, threadId: id, turnId: t.id, text: t.prompt || 'hi', item: out.length }));
    if (t.tool) {
      out.push({ timestamp: iso(at + 1000), type: 'response_item', payload: { type: 'function_call', name: t.tool,
        call_id: `call_${t.id}`, arguments: '{}' } });
      if (!t.toolRunning) out.push({ timestamp: iso(at + 3000), type: 'response_item', payload: {
        type: 'function_call_output', call_id: `call_${t.id}`, output: 'ok' } });
    }
    /* Shaped as Codex 0.164 writes it: the turn's own usage, the thread's total, and a rate_limits record whose
       quota fields are null, which is what every record on this machine holds. */
    out.push({ timestamp: iso(at + 4000), type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: t.context || 1000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 4,
        total_tokens: (t.context || 1000) + 10 },
      total_token_usage: { input_tokens: t.total || 2000, cached_input_tokens: 7, output_tokens: 20, reasoning_output_tokens: 9,
        total_tokens: (t.total || 2000) + 20 },
      model_context_window: 258400 },
    rate_limits: { limit_id: 'codex', limit_name: null, primary: null, secondary: null, credits: null, individual_limit: null,
      spend_control_reached: null, plan_type: null, rate_limit_reached_type: null } } });
    if (!t.running) {
      out.push({ timestamp: iso(at + 5000), type: 'event_msg', payload: { type: t.aborted ? 'turn_aborted' : 'task_complete',
        turn_id: t.id, duration_ms: 5000, completed_at: Math.floor((at + 5000) / 1000), last_agent_message: t.reply || 'done' } });
    }
  }
  return out.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/*
 * Build a CODEX_HOME in `dir` holding `threads`: [{ title, source, threadSource, cwd, turns, unread, archived, pinned,
 * section }]. Returns the threads with their ids and rollout paths filled in.
 */
function codexHome(dir, threads) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec(SCHEMA);
  const ins = db.prepare(`insert into threads (id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
    source, thread_source, cwd, title, name, archived, is_pinned, thread_section_id, model, reasoning_effort, originator,
    first_user_message) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const out = [];
  const now = Date.now();
  threads.forEach((t, i) => {
    const id = t.id || threadId();
    const startMs = t.startMs || now - (threads.length - i) * 3600e3;
    const day = new Date(startMs);
    const sub = path.join(dir, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'),
      String(day.getUTCDate()).padStart(2, '0'));
    fs.mkdirSync(sub, { recursive: true });
    const rollout = path.join(sub, `rollout-${day.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
    const turns = (t.turns || []).map((x, k) => ({ id: `${id.slice(0, 8)}-t${k}`, startMs: startMs + k * 60e3, ...x }));
    fs.writeFileSync(rollout, rolloutLines({ id, cwd: t.cwd || dir, source: t.source || 'vscode', turns, startMs }));
    const updated = turns.length ? turns[turns.length - 1].startMs + 5000 : startMs;
    ins.run(id, rollout, Math.floor(startMs / 1000), Math.floor(updated / 1000), startMs, updated, t.source || 'vscode',
      t.threadSource || 'user', t.cwd || dir, t.title || '', t.name || null, t.archived ? 1 : 0, t.pinned ? 1 : 0,
      t.section || null, 'gpt-test', 'low', 'codex_vscode', t.title || '');
    if (t.unread) db.prepare('insert into thread_read_receipts values (?,?,?,?)').run(id, turns.length ? turns[0].id : '', 'r', null);
    out.push({ ...t, id, rollout, turns });
  });
  db.prepare('insert into thread_sections values (?,?,?)').run('sec-1', 'Pinned', null);
  db.close();
  return out;
}

module.exports = { codexHome, threadId, rolloutLines, userMessageRows };
