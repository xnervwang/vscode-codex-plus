// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Codex's own files, read without ever writing them.
 *
 * Every part of the extension that needs a fact about Codex conversations goes through here: where CODEX_HOME is,
 * which threads exist and where their rollouts are, which of them the user has not read, and what the end of a rollout
 * says about the turn now running. Kept in one place so that one reader honouring CODEX_HOME and another not, or one
 * treating a guardian review as a conversation and another not, cannot drift apart unnoticed.
 *
 * The thread list lives in a SQLite file Codex keeps open. It is opened read-only, through node:sqlite when the Node
 * running the extension has it, through the sqlite3 command when it does not, and as a last resort the list is rebuilt
 * from session_index.jsonl, which has ids and titles but no rollout paths or sources.
 *
 * Every function here blocks. In the extension they run in a worker thread (src/codex-worker.js) and the extension host
 * reads what src/codex-reader.js keeps of their results; only tests and the worker call them directly.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** A thread id as Codex writes it: hex with hyphens, UUID-shaped. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let override = '';
/** Point every lookup at another CODEX_HOME (the worker thread, and the tests). Empty restores the default. */
function setCodexHome(dir) { override = dir ? String(dir) : ''; closeAll(); }

/** CODEX_HOME as Codex resolves it: the environment variable when set, ~/.codex otherwise. */
function codexHome() {
  if (override) return override;
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/*
 * The state database. Codex numbers it by schema generation (state_5.sqlite today), so the highest number present is
 * the one in use; an older one left behind by a migration is never newer than the live one.
 */
function stateDbPath(home = codexHome()) {
  let names;
  try { names = fs.readdirSync(home); } catch (_) { return ''; }
  let best = '', bestN = -1;
  for (const n of names) {
    const m = /^state_(\d+)\.sqlite$/.exec(n);
    if (m && +m[1] > bestN) { bestN = +m[1]; best = n; }
  }
  return best ? path.join(home, best) : '';
}

let sqlite = undefined;
function nodeSqlite() {
  if (sqlite !== undefined) return sqlite;
  try {
    // node:sqlite prints an ExperimentalWarning on first load in some Node versions; it is not ours to surface.
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    try { sqlite = require('node:sqlite'); } finally { process.emitWarning = emit; }
  } catch (_) { sqlite = null; }
  return sqlite;
}

const open = new Map();
function closeAll() {
  for (const db of open.values()) { try { db.close(); } catch (_) { /* already closed */ } }
  open.clear();
}

/*
 * Rows for one query, or null when the database cannot be read at all. `sql` takes no parameters: every value the
 * extension filters on is applied afterwards, so nothing from outside is ever spliced into the text.
 */
function query(sql, home = codexHome()) {
  const file = stateDbPath(home);
  if (!file) return null;
  const lib = nodeSqlite();
  if (lib && lib.DatabaseSync) {
    try {
      let db = open.get(file);
      if (!db) { db = new lib.DatabaseSync(file, { readOnly: true }); open.set(file, db); }
      return db.prepare(sql).all().map((r) => ({ ...r }));
    } catch (_) {
      const db = open.get(file);
      open.delete(file);
      try { if (db) db.close(); } catch (_) { /* nothing to close */ }
    }
  }
  try {
    const out = cp.execFileSync('sqlite3', ['-readonly', '-json', file, sql],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    return out.trim() ? JSON.parse(out) : [];
  } catch (_) { return null; }
}

/*
 * Where a thread came from. Codex writes `source` either as a plain word (vscode, cli, exec, ...) for a thread a person
 * started, or as JSON for one Codex started itself: a sub-agent ({"subagent":{"thread_spawn":{...}}}) or a review of
 * an approval request ({"subagent":{"other":"guardian"}}).
 */
function sourceKind(source, threadSource) {
  if (threadSource === 'guardian_review') return { kind: 'guardian' };
  if (threadSource === 'subagent') {
    let spawn = null;
    try { spawn = JSON.parse(source).subagent.thread_spawn || null; } catch (_) { /* not JSON */ }
    return { kind: 'subagent', parent: spawn && spawn.parent_thread_id || '', nickname: spawn && spawn.agent_nickname || '' };
  }
  const s = String(source || '');
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j && j.subagent) {
        if (j.subagent.other === 'guardian') return { kind: 'guardian' };
        const spawn = j.subagent.thread_spawn || {};
        return { kind: 'subagent', parent: spawn.parent_thread_id || '', nickname: spawn.agent_nickname || '' };
      }
    } catch (_) { /* fall through */ }
    return { kind: 'other' };
  }
  // `exec` is `codex exec`: a run nobody watches, the counterpart of `claude -p`.
  if (s === 'exec') return { kind: 'background', origin: s };
  return { kind: 'user', origin: s };
}

const THREAD_COLUMNS = ['id', 'rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'source',
  'thread_source', 'cwd', 'title', 'name', 'preview', 'first_user_message', 'tokens_used', 'model', 'reasoning_effort',
  'archived', 'archived_at', 'is_pinned', 'thread_section_id', 'git_branch', 'cli_version', 'originator'];

/*
 * Every thread, newest first, each with `kind` added (see sourceKind) and times in milliseconds. Null when neither the
 * database nor the index could be read. Columns a given Codex build lacks are left out of the query rather than
 * failing it.
 */
function listThreads(home = codexHome()) {
  const info = query("select name from pragma_table_info('threads')", home);
  if (info && info.length) {
    const have = new Set(info.map((r) => r.name));
    const cols = THREAD_COLUMNS.filter((c) => have.has(c));
    const rows = query(`select ${cols.join(', ')} from threads`, home);
    if (rows) return rows.map(normalizeThread).sort((a, b) => b.updatedMs - a.updatedMs);
  }
  return threadsFromIndex(home);
}

function normalizeThread(r) {
  const ms = (msv, sec) => (Number.isFinite(+msv) && +msv > 0 ? +msv : Number.isFinite(+sec) ? +sec * 1000 : 0);
  const k = sourceKind(r.source, r.thread_source);
  return {
    id: String(r.id || ''),
    rollout: r.rollout_path ? String(r.rollout_path) : '',
    createdMs: ms(r.created_at_ms, r.created_at),
    updatedMs: ms(r.updated_at_ms, r.updated_at),
    source: String(r.source || ''),
    kind: k.kind,
    parent: k.parent || '',
    nickname: k.nickname || '',
    cwd: String(r.cwd || ''),
    title: titleOf(r),
    tokens: +r.tokens_used || 0,
    model: r.model || '',
    effort: r.reasoning_effort || '',
    archived: !!+r.archived,
    pinned: !!+r.is_pinned,
    section: r.thread_section_id || '',
    branch: r.git_branch || '',
    originator: r.originator || '',
  };
}

/* The title Codex shows: a name the user gave, else the generated title, else the start of the first message. */
function titleOf(r) {
  for (const k of ['name', 'title', 'preview', 'first_user_message']) {
    const v = String(r[k] || '').replace(/\s+/g, ' ').trim();
    if (v) return v.length > 120 ? v.slice(0, 119) + '…' : v;
  }
  return '';
}

function threadsFromIndex(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8'); } catch (_) { return null; }
  const byId = new Map();
  for (const line of text.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !THREAD_ID.test(String(r.id || ''))) continue;
    const t = Date.parse(r.updated_at) || 0;
    byId.set(r.id, { id: r.id, rollout: '', createdMs: t, updatedMs: t, source: '', kind: 'user', parent: '',
      nickname: '', cwd: '', title: String(r.thread_name || ''), tokens: 0, model: '', effort: '', archived: false,
      pinned: false, section: '', branch: '', originator: '' });
  }
  return [...byId.values()].sort((a, b) => b.updatedMs - a.updatedMs);
}

/** Sections the user sorted threads into: id -> name. */
function sections(home = codexHome()) {
  const rows = query('select id, name from thread_sections', home) || [];
  return new Map(rows.map((r) => [String(r.id), String(r.name || '')]));
}

/** Threads with something the user has not read: thread id -> first unread turn id ('' for the whole thread). */
function unreadThreads(home = codexHome()) {
  const rows = query('select thread_id, first_unread_turn from thread_read_receipts where first_unread_turn is not null', home);
  return new Map((rows || []).map((r) => [String(r.thread_id), String(r.first_unread_turn || '')]));
}

/*
 * Reading the end of a rollout. Rollouts are append-only and can reach hundreds of megabytes, and what the extension
 * needs is near the end, so a read goes backwards in windows that grow fourfold, up to TAIL_MAX.
 */
const TAIL_START = 64 * 1024;
const TAIL_MAX = 4 * 1024 * 1024;

/*
 * Codex compresses a rollout untouched for a week into <name>.jsonl.zst and removes the plain file, while the state
 * database keeps naming the plain one. So a rollout exists if either does, and a compressed one is read whole through
 * zstd when this Node has it (Node 22.15 and later; VS Code's is newer), up to COMPRESSED_MAX.
 */
const COMPRESSED_MAX = 64 << 20;
/* What one compressed rollout may grow to when read. zstd compresses these files tenfold or more, so the input limit
   alone does not bound the memory a read takes. */
const DECOMPRESSED_MAX = 256 << 20;
function existingRollout(file) {
  if (!file) return '';
  if (fs.existsSync(file)) return file;
  if (fs.existsSync(file + '.zst')) return file + '.zst';
  return '';
}
function compressedLines(file, limit) {
  const zlib = require('zlib');
  if (typeof zlib.zstdDecompressSync !== 'function') return [];
  try {
    if (fs.statSync(file).size > COMPRESSED_MAX) return [];
    const text = zlib.zstdDecompressSync(fs.readFileSync(file), { maxOutputLength: DECOMPRESSED_MAX }).toString('utf8');
    const cut = Math.max(0, text.length - limit);
    const tail = cut ? text.slice(text.indexOf('\n', cut) + 1) : text;
    return tail.split('\n').filter((l) => l.trim()).reverse();
  } catch (_) { return []; }
}

/** The complete lines in the last `limit` bytes of `file`, newest first. A line that starts before that point is left out. */
function tailLines(file, limit = TAIL_START) {
  const real = existingRollout(file);
  if (real && real.endsWith('.zst')) return compressedLines(real, limit);
  if (real) file = real;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, limit);
    const start = size - want;
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    return text.split('\n').filter((l) => l.trim()).reverse();
  } catch (_) { return []; } finally { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
}

function fileSize(file) { try { return fs.statSync(existingRollout(file) || file).size; } catch (_) { return 0; } }

/** The first line of a rollout: session_meta, with the thread's source, cwd and originator. */
function sessionMeta(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const row = JSON.parse(nl >= 0 ? text.slice(0, nl) : text);
    return row && row.type === 'session_meta' ? row.payload || null : null;
  } catch (_) { return null; } finally { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
}

/*
 * What the end of a rollout says about its thread: whether a turn is running, and the figures of the turn that ran
 * last. Read newest first; each fact is taken from the newest line that carries it, and the walk stops once the start
 * of the latest turn has been seen, because nothing before it changes the answer.
 *
 *   working        a task_started with no task_complete or turn_aborted after it
 *   turnId, startedMs, endedMs, durationMs
 *   context        { used, window } from the newest token_count
 *   tokens         what the whole thread has spent, from the same record
 *   model, effort  from the newest turn_context
 *   lastTool       { name, startedMs, endedMs } of the newest tool call, for the working line
 *   error          the newest task_complete's error, if it failed
 *   askedMs        when the latest turn asked the user something with request_user_input_async, 0 if it did not: that
 *                  question has no app-server request, and its answer is the next user message, which opens a turn
 */
/* Codex's question that does not wait: the tool returns at once and the card stays on the page. */
const ASYNC_QUESTION = 'request_user_input_async';

function rolloutState(file, lines = null) {
  if (!lines) {
    const size = fileSize(file);
    for (let limit = TAIL_START; ; limit *= 4) {
      const st = rolloutState(file, tailLines(file, limit));
      if ((st.startedMs && st.model) || limit >= size || limit >= TAIL_MAX) return st;
    }
  }
  const st = { working: false, turnId: '', startedMs: 0, endedMs: 0, durationMs: 0, context: null, tokens: null, model: '', effort: '',
    lastTool: null, error: '', lastActivityMs: 0, aborted: false, askedMs: 0 };
  let sawEnd = false;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    if (!row || typeof row !== 'object') continue;
    const at = Date.parse(row.timestamp) || 0;
    if (!st.lastActivityMs && at) st.lastActivityMs = at;
    const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (row.type === 'turn_context' && !st.model) {
      st.model = String(p.model || '');
      st.effort = String(p.effort || p.reasoning_effort || '');
    } else if (row.type === 'event_msg') {
      if (p.type === 'token_count' && !st.context && p.info) {
        const last = p.info.last_token_usage || {};
        const used = +last.input_tokens || 0;
        if (used) st.context = { used, window: +p.info.model_context_window || 0 };
        // The same record carries what the whole thread has spent, so it costs nothing more to keep.
        const total = p.info.total_token_usage || {};
        if (!st.tokens && +total.total_tokens) {
          st.tokens = { total: +total.total_tokens || 0, input: +total.input_tokens || 0, output: +total.output_tokens || 0,
            cached: +total.cached_input_tokens || 0, reasoning: +total.reasoning_output_tokens || 0 };
        }
      } else if ((p.type === 'task_complete' || p.type === 'turn_aborted') && !sawEnd) {
        sawEnd = true;
        st.turnId = String(p.turn_id || '');
        st.endedMs = p.completed_at ? p.completed_at * 1000 : at;
        st.durationMs = +p.duration_ms || 0;
        st.aborted = p.type === 'turn_aborted';
        if (p.error) st.error = typeof p.error === 'string' ? p.error : JSON.stringify(p.error);
      } else if (p.type === 'task_started') {
        st.startedMs = p.started_at ? p.started_at * 1000 : at;
        if (!sawEnd) { st.working = true; st.turnId = String(p.turn_id || ''); }
        if (st.model) break;
      }
    }
    if (row.type === 'response_item' && p.type === 'function_call' && p.name === ASYNC_QUESTION && !st.startedMs && !st.askedMs) {
      st.askedMs = at;
    }
    if (row.type === 'response_item' && !st.lastTool) {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'web_search_call') {
        st.lastTool = { name: String(p.name || p.type), startedMs: at, endedMs: 0, callId: String(p.call_id || '') };
      }
    }
  }
  if (st.lastTool && st.lastTool.callId) {
    for (const line of lines) {
      if (!line.includes(st.lastTool.callId) || !line.includes('_output')) continue;
      try {
        const row = JSON.parse(line);
        if (row.payload && /_output$/.test(row.payload.type || '')) { st.lastTool.endedMs = Date.parse(row.timestamp) || 0; break; }
      } catch (_) { /* skip */ }
    }
  }
  return st;
}

/** The rollout of one thread: from the database when it knows, else by searching sessions/ for the id. */
function rolloutOf(id, home = codexHome(), threads = null) {
  if (!THREAD_ID.test(String(id || ''))) return '';
  const list = threads || listThreads(home) || [];
  const t = list.find((x) => x.id === id);
  if (t && t.rollout && existingRollout(t.rollout)) return t.rollout;
  return findRollout(id, home);
}

function findRollout(id, home) {
  const root = path.join(home, 'sessions');
  const walk = (dir, depth) => {
    let names;
    try { names = fs.readdirSync(dir).sort().reverse(); } catch (_) { return ''; }
    for (const n of names) {
      const p = path.join(dir, n);
      if (depth === 3) { if (n.endsWith(id + '.jsonl')) return p; if (n.endsWith(id + '.jsonl.zst')) return p.slice(0, -4); continue; }
      const hit = walk(p, depth + 1);
      if (hit) return hit;
    }
    return '';
  };
  return walk(root, 0);
}

/*
 * Whether any file under the folders Codex keeps rollouts in still carries this thread's id in its name: sessions/,
 * and archived_sessions/, where archiving moves one. Asked before anything of a conversation's is deleted, and so it
 * looks by name rather than at the path the state database holds, which can lag a move, and it counts every form a
 * rollout takes (plain, compressed, or paginated) as the conversation still being there. A folder that is there and
 * cannot be read counts the same way, since it may hold the rollout; only a folder that is not there holds none.
 */
function rolloutExists(id, home = codexHome()) {
  if (!THREAD_ID.test(String(id || ''))) return false;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return !!e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; }
    for (const e of entries) {
      if (e.name.includes(id)) return true;
      if (e.isDirectory() && depth < 5 && walk(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(path.join(home, 'sessions'), 0) || walk(path.join(home, 'archived_sessions'), 0);
}

module.exports = {
  existingRollout, THREAD_ID, THREAD_COLUMNS, COMPRESSED_MAX, DECOMPRESSED_MAX, codexHome, setCodexHome, stateDbPath, query, listThreads, sourceKind, sections, unreadThreads, tailLines,
  sessionMeta, rolloutState, rolloutOf, rolloutExists, closeAll, ASYNC_QUESTION,
};
