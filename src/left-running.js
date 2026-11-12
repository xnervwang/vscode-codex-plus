// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Finds what a conversation started that is still running after its turn ended. It reads /proc, Claude Code's
 * session records, and the rollout of a conversation that launched a `claude --bg` session.
 * Every function here blocks; they run in the worker thread (src/codex-worker.js), at most once every 10 seconds
 * (LEFT_EVERY_MS).
 *
 * Codex sets CODEX_THREAD_ID to the thread's id in the environment of every command it runs, and /proc/<pid>/environ
 * keeps the environment a process started with. Whatever such a command starts inherits it, a `codex exec` or a
 * `claude -p` included, and passes it on to its own commands. The kinds, by where the process sits:
 *
 *   command       a child of a codex process: a command Codex still runs for the thread after its turn ended. Codex
 *                 kills these when its app-server exits, so one is never left over from a closed window.
 *   detached      outside every codex and claude process, and a shell or `timeout` by argv[0]: `setsid nohup bash -c`,
 *                 a script, `nohup … &` from a shell that has since exited.
 *   codexExec     a `codex exec` outside every codex and claude process.
 *   claudeWorker  a `claude -p` whose session record says it is not idle (an idle one waits for input).
 *   claudeBg      a `claude --bg` session whose record says busy (a turn) or shell (a command). It runs in a process
 *                 Claude Code's daemon started beforehand, so it inherits nothing from the launcher; the launch is
 *                 read instead from the output of the command that ran it, in the launcher's rollout.
 *
 * Only shells count among detached processes, because programs that detach themselves stay running long after the work
 * that started them: Brazil's Java server, the OpenTelemetry server `codex` starts, Xvfb, a database server, a
 * `tail -F` nobody stopped. mfns, which runs demo clusters in namespaces of their own, names its holder processes
 * mfns-holder, not bash.
 *
 * Without /proc only the claude --bg launches are found; src/codex-source.js then falls back on what the rollout says
 * of Codex's own background commands.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const THREAD_KEY = Buffer.from('CODEX_THREAD_ID=', 'latin1');
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTERS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'timeout']);
/* The kinds in the order a row's hover lists them. */
const KINDS = ['subagent', 'command', 'detached', 'codexExec', 'claudeWorker', 'claudeBg'];
/* The rate Claude Code Plus scans at for the same thing. */
const LEFT_EVERY_MS = 10000;
/* Ancestors walked at most, against a loop in a parent chain read while processes come and go. */
const MAX_DEPTH = 64;

/* The `claude --bg` CLI's own words, at the start of a line: `backgrounded · <id>`, then hints naming the id again. */
const ID_AFTER = /^[ \t]*backgrounded · (?:\x1b\[[0-9;]*m)*([0-9a-f]{8})(?![0-9a-f])/gm;
const HINTS = ['open in this terminal', 'show recent output', 'stop this session'];
const ID_IN_HINT = new RegExp('^(?:\\x1b\\[[0-9;]*m)*[ \\t]*claude (?:attach|logs|stop) ([0-9a-f]{8})[ \\t]+(?:'
  + HINTS.join('|') + ')', 'gm');
const BG_CMD = /\bclaude\b[^\n|;&]*?\s--bg(?=[\s"'=]|$)/;
const JOB_ID = /^[0-9a-f]{8}$/;
/* The first read of a rollout for launches covers this many bytes of its end; later reads, only what was appended. */
const LAUNCH_TAIL = 8 << 20;
/* Per rollout: the claude --bg calls remembered until their output is read, and the job ids kept. */
const MAX_CALLS = 500;
const MAX_JOBS = 20;

const read = (file, enc) => { try { return fs.readFileSync(file, enc); } catch (_) { return null; } };

/* pid -> { comm, state, ppid, start } for every process whose stat can be read; start is in clock ticks since boot. */
function processes(proc = '/proc') {
  const out = new Map();
  let names;
  try { names = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch (_) { return out; }
  for (const n of names) {
    const s = read(path.join(proc, n, 'stat'), 'latin1');
    if (!s) continue;
    const open = s.indexOf('('), close = s.lastIndexOf(')');
    if (open < 0 || close < open) continue;
    const f = s.slice(close + 2).split(' ');
    out.set(Number(n), { comm: s.slice(open + 1, close), state: f[0], ppid: Number(f[1]), start: f[19] });
  }
  return out;
}

/* The value of `key` in an environment block, or ''. */
function envValue(env, key) {
  if (!env) return '';
  for (let at = env.indexOf(key); at !== -1; at = env.indexOf(key, at + 1)) {
    if (at > 0 && env[at - 1] !== 0) continue;
    const end = env.indexOf(0, at);
    return env.toString('latin1', at + key.length, end === -1 ? env.length : end);
  }
  return '';
}

/*
 * Claude Code's records of its running processes, the ~/.claude/sessions/<pid>.json files `claude agents` lists, for
 * the processes still alive. With /proc, a record counts only if the process now holding its pid started at the time
 * the record gives, because pids are reused.
 */
function readRecords(dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions'),
  { proc = '/proc', procs = null } = {}) {
  const live = procs || processes(proc);
  const out = [];
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return out; }
  for (const n of names) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    if (!d || !Number.isInteger(d.pid)) continue;
    if (live.size) {
      const p = live.get(d.pid);
      if (!p || (typeof d.procStart === 'string' && d.procStart && p.start !== d.procStart)) continue;
    } else {
      try { process.kill(d.pid, 0); } catch (e) { if (!(e && e.code === 'EPERM')) continue; }
    }
    out.push(d);
  }
  return out;
}

/* A `claude -p` worker's record names an entrypoint starting sdk-; an idle one is waiting for input. */
const isWorker = (d) => /^sdk-/.test(d.entrypoint || '') && d.kind !== 'bg' && d.status !== 'idle';

/* The job ids of `claude --bg` sessions with a turn or a command running. */
function busyJobs(records) {
  return new Set(records.filter((d) => d.kind === 'bg' && (d.status === 'busy' || d.status === 'shell')
    && typeof d.jobId === 'string' && JOB_ID.test(d.jobId)).map((d) => d.jobId));
}

/* Whether argv names the exec subcommand (alias e) of a codex program, past any options before it. */
function isCodexExec(argv) {
  if (path.basename(argv[0] || '') !== 'codex') return false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config' || a === '-p' || a === '--profile' || a === '-C' || a === '--cd') { i++; continue; }
    if (a.startsWith('-')) continue;
    return a === 'exec' || a === 'e';
  }
  return false;
}

/*
 * thread id -> Set of kinds, from /proc and the live records (readRecords). `available` is false where /proc could
 * not be read.
 */
function snapshot({ proc = '/proc', records = [], procs = null } = {}) {
  const threads = new Map();
  const all = procs || processes(proc);
  if (!all.size) return { available: false, threads };
  const add = (id, kind) => {
    const key = id.toLowerCase();
    if (!threads.has(key)) threads.set(key, new Set());
    threads.get(key).add(kind);
  };
  const recordPids = new Set(records.map((r) => r.pid));
  const comm = (pid) => (all.get(pid) || {}).comm;
  const isAgent = (pid) => recordPids.has(pid) || comm(pid) === 'codex' || comm(pid) === 'claude';
  const memo = new Map();
  /* Whether a codex or claude process is among the ancestors of `pid`, not counting itself. */
  const under = (pid) => {
    const trail = [];
    let found = false;
    for (let p = (all.get(pid) || {}).ppid, hops = 0; p > 1 && hops < MAX_DEPTH; hops++) {
      if (memo.has(p)) { found = memo.get(p); break; }
      trail.push(p);
      if (isAgent(p)) { found = true; break; }
      const info = all.get(p);
      if (!info) break;
      p = info.ppid;
    }
    for (const p of trail) memo.set(p, found);
    return found;
  };
  const envs = new Map();
  const threadOf = (pid) => {
    if (!envs.has(pid)) envs.set(pid, envValue(read(path.join(proc, String(pid), 'environ')), THREAD_KEY));
    return envs.get(pid);
  };
  const argvOf = (pid) => { const a = read(path.join(proc, String(pid), 'cmdline'), 'latin1'); return a ? a.split('\0') : []; };
  for (const [pid, p] of all) {
    if (p.state === 'Z' || p.state === 'X') continue;
    const self = isAgent(pid);
    const childOfCodex = comm(p.ppid) === 'codex';
    let kind = '';
    if (childOfCodex && !self) kind = 'command';
    else if (!under(pid)) kind = self ? (comm(pid) === 'codex' ? 'codexExec' : '') : 'detached';
    if (!kind) continue;
    const id = threadOf(pid);
    if (!THREAD_ID.test(id)) continue;
    /* A process whose codex parent carries the same id got it from that codex, a `codex exec` worker: a helper. */
    if (kind === 'command' && threadOf(p.ppid).toLowerCase() === id.toLowerCase()) continue;
    if (kind === 'detached' && !STARTERS.has(path.basename(argvOf(pid)[0] || ''))) continue;
    if (kind === 'codexExec' && !isCodexExec(argvOf(pid))) continue;
    add(id, kind);
  }
  for (const r of records) {
    if (!isWorker(r)) continue;
    const id = threadOf(r.pid);
    if (THREAD_ID.test(id)) add(id, 'claudeWorker');
  }
  return { available: true, threads };
}

/* The text of a tool output as a rollout stores it: a string, or { content } with a string or a list of parts. */
function outputText(o) {
  if (typeof o === 'string') return o;
  const c = o && o.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : '';
}
function commandOf(argsText) {
  let a;
  try { a = JSON.parse(argsText); } catch (_) { return ''; }
  if (!a || typeof a !== 'object') return '';
  if (typeof a.cmd === 'string') return a.cmd;
  if (Array.isArray(a.command)) return a.command.join(' ');
  return typeof a.command === 'string' ? a.command : '';
}

/*
 * The job ids of the `claude --bg` sessions the commands in a rollout launched, read on from where the last call left
 * off (`cache`, by file). A launch counts only in the output of a command that ran `claude … --bg`: a command that
 * printed an older launch back, a grep of a log say, leaves the very same line.
 */
function launches(file, cache) {
  let st;
  try { st = fs.statSync(file); } catch (_) { cache.delete(file); return new Set(); }
  let c = cache.get(file);
  if (!c || st.size < c.pos) {
    c = { pos: Math.max(0, st.size - LAUNCH_TAIL), calls: new Set(), jobs: new Set(), mid: st.size > LAUNCH_TAIL };
    cache.set(file, c);
  }
  if (st.size - c.pos > LAUNCH_TAIL) { c.pos = st.size - LAUNCH_TAIL; c.mid = true; }
  if (st.size <= c.pos) return c.jobs;
  let buf;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(st.size - c.pos);
    fs.readSync(fd, buf, 0, buf.length, c.pos);
  } catch (_) { return c.jobs; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* closed */ } } }
  let from = 0;
  if (c.mid) { from = buf.indexOf(0x0a) + 1; c.mid = false; if (from === 0) return c.jobs; }
  const end = buf.lastIndexOf(0x0a);
  if (end < from) return c.jobs;
  c.pos += end + 1;
  for (const line of buf.toString('utf8', from, end).split('\n')) {
    const call = line.includes('"function_call"') && line.includes('--bg');
    const out = !call && line.includes('function_call_output') && (line.includes('backgrounded') || line.includes('claude attach')
      || line.includes('claude logs') || line.includes('claude stop'));
    if (!call && !out) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const p = row && row.payload;
    if (!p || !p.call_id) continue;
    if (call && p.type === 'function_call' && BG_CMD.test(commandOf(p.arguments))) {
      c.calls.add(p.call_id);
      if (c.calls.size > MAX_CALLS) c.calls.delete(c.calls.values().next().value);
    } else if (out && p.type === 'function_call_output' && c.calls.has(p.call_id)) {
      const text = outputText(p.output);
      for (const re of [ID_AFTER, ID_IN_HINT]) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) c.jobs.add(m[1]);
      }
      while (c.jobs.size > MAX_JOBS) c.jobs.delete(c.jobs.values().next().value);
    }
  }
  return c.jobs;
}

/*
 * One scan of `threads`, the recent threads the worker passes in, as [{ id, rollout }].
 * Returns { available, threads: { [thread id]: [kinds] } }. `cache` keeps how far each rollout has been read for
 * launches; rollouts no longer passed in are dropped from it.
 */
function leftRunning({ threads = [], proc = '/proc', sessionsDir, cache = new Map() } = {}) {
  const procs = processes(proc);
  const records = readRecords(sessionsDir, { procs });
  const snap = snapshot({ proc, records, procs });
  const out = {};
  for (const [id, kinds] of snap.threads) out[id] = [...kinds];
  const jobs = busyJobs(records);
  const keep = new Set();
  if (jobs.size) {
    for (const t of threads) {
      if (!t || !t.rollout || !THREAD_ID.test(String(t.id || ''))) continue;
      keep.add(t.rollout);
      if (![...launches(t.rollout, cache)].some((j) => jobs.has(j))) continue;
      const id = t.id.toLowerCase();
      out[id] = [...new Set([...(out[id] || []), 'claudeBg'])];
    }
  }
  for (const f of [...cache.keys()]) if (!keep.has(f) && jobs.size) cache.delete(f);
  return { available: snap.available, threads: out };
}

module.exports = { snapshot, processes, readRecords, busyJobs, launches, leftRunning, isCodexExec, envValue, STARTERS, KINDS,
  LEFT_EVERY_MS, LAUNCH_TAIL };
