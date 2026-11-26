// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Finds what a conversation started that is still running after its turn ended. It reads /proc, Claude Code's
 * session records, and the rollout of a conversation that launched a `claude --bg` session.
 * Every function here blocks; they run in the worker thread (src/codex-worker.js), at most once every 10 seconds
 * (LEFT_EVERY_MS), and the windows on this machine share one reading of /proc between them (scan()).
 *
 * Codex sets CODEX_THREAD_ID to the thread's id in the environment of every command it runs, and /proc/<pid>/environ
 * keeps the environment a process started with. Whatever such a command starts inherits it, a `codex exec` or a
 * `claude -p` included, and passes it on to its own commands. The kinds, by where the process sits:
 *
 *   command       a child of a codex process: a command Codex still runs for the thread after its turn ended. Codex
 *                 kills these when its app-server exits, so one is never left over from a closed window.
 *   detached      outside every codex and claude process, and either a shell or `timeout` by argv[0] (`nohup … &` from a
 *                 shell that has since exited, a script) or the leader of a session of its own (`setsid <program>`;
 *                 bash given one command with -c replaces itself with it, so `setsid bash -c '<command>'` is one too).
 *   codexExec     a `codex exec` outside every codex and claude process.
 *   claudeWorker  a `claude -p` whose session record says it is not idle (an idle one waits for input).
 *   claudeBg      a `claude --bg` session whose record says busy (a turn) or shell (a command). It runs in a process
 *                 Claude Code's daemon started beforehand, so it inherits nothing from the launcher; the launch is
 *                 read instead from the output of the command that ran it, in the launcher's rollout.
 *
 * Programs that detach themselves under their parent's session stay running long after the work that started them:
 * Brazil's Java server, the OpenTelemetry server `codex` starts, Xvfb, a `tail -F` nobody stopped. Running a command
 * under `setsid` is asking for a separate job. mfns, which runs demo clusters in namespaces of their own, names its
 * holder processes mfns-holder, not bash.
 *
 * The top process of each detached tree is also listed (`detached` in the scan), and so is every other process counted
 * and every busy claude --bg session (`running`). The Agent map shows both lists, and src/detached-ends.js tells the
 * conversation when a detached one is gone.
 *
 * The same scan lists the processes holding conversations open through Codex's writer locks (src/writer-locks.js),
 * which Agent Plus's session list shows as where else a conversation is open.
 *
 * Without /proc only the claude --bg launches are found; src/codex-source.js then falls back on what the rollout says
 * of Codex's own background commands.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const writerLocks = require('./writer-locks');

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
/* What exec_command answers when its command is still running after yield_time_ms. Later write_stdin calls on that
   session id read the rest of its output. */
const STILL_RUNNING = /Process running with session ID (\d+)/g;
const MAX_SESSIONS = 200;

const read = (file, enc) => { try { return fs.readFileSync(file, enc); } catch (_) { return null; } };

/*
 * Reads a stat file with one read call into a shared buffer. readFileSync needs a second call to find the end of a file
 * that /proc reports as empty. A stat line is a few hundred bytes; one that fills the buffer is read again with
 * readFileSync.
 */
const STAT_BUF = Buffer.alloc(4096);
function readStat(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  let n;
  try { n = fs.readSync(fd, STAT_BUF, 0, STAT_BUF.length, null); } catch (_) { return null; } finally {
    try { fs.closeSync(fd); } catch (_) { /* closed */ }
  }
  return n < STAT_BUF.length ? STAT_BUF.toString('latin1', 0, n) : read(file, 'latin1');
}

/* pid -> { comm, state, ppid, sid, start } for every process whose stat can be read; sid is its session, start is in
   clock ticks since boot. */
function processes(proc = '/proc') {
  const out = new Map();
  let names;
  try { names = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch (_) { return out; }
  for (const n of names) {
    const s = readStat(path.join(proc, n, 'stat'));
    if (!s) continue;
    const open = s.indexOf('('), close = s.lastIndexOf(')');
    if (open < 0 || close < open) continue;
    const f = s.slice(close + 2).split(' ');
    out.set(Number(n), { comm: s.slice(open + 1, close), state: f[0], ppid: Number(f[1]), sid: Number(f[3]), start: f[19] });
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
const sessionsHome = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
function readRecords(dir = sessionsHome(), { proc = '/proc', procs = null } = {}) {
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

const recordName = (d) => (typeof d.name === 'string' ? d.name.slice(0, NAME_MAX) : '');
const recordSession = (d) => (typeof d.sessionId === 'string' && THREAD_ID.test(d.sessionId) ? d.sessionId : '');
const NAME_MAX = 200;

/* The `claude --bg` sessions with a turn or a command running, as [{ job, pid, start, startMs, name, session }]. */
function busyBg(records, all, boot) {
  return records.filter((d) => d.kind === 'bg' && (d.status === 'busy' || d.status === 'shell')
    && typeof d.jobId === 'string' && JOB_ID.test(d.jobId)).map((d) => {
    const p = all.get(d.pid);
    return { job: d.jobId, pid: d.pid, start: p ? String(p.start) : '', startMs: startMsOf(p, boot) || (+d.startedAt > 0 ? +d.startedAt : 0),
      name: recordName(d), session: recordSession(d) };
  });
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
 *
 * `environs`, kept by the caller from one scan to the next, maps each pid to the launcher id read from its environ,
 * with the start time and comm the process had then. /proc/<pid>/environ does not change until the process execs, and
 * an exec changes its comm; a reused pid has a different start time.
 */
function snapshot({ proc = '/proc', records = [], procs = null, environs = null } = {}) {
  const threads = new Map();
  const all = procs || processes(proc);
  if (!all.size) return { available: false, threads, detached: [] };
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
    if (envs.has(pid)) return envs.get(pid);
    const p = all.get(pid);
    const kept = environs && p ? environs.get(pid) : null;
    let id;
    if (kept && kept.start === p.start && kept.comm === p.comm) id = kept.id;
    else {
      id = envValue(read(path.join(proc, String(pid), 'environ')), THREAD_KEY);
      if (environs && p) environs.set(pid, { start: p.start, comm: p.comm, id });
    }
    envs.set(pid, id);
    return id;
  };
  const argvOf = (pid) => { const a = read(path.join(proc, String(pid), 'cmdline'), 'latin1'); return a ? a.split('\0') : []; };
  /* `counted`: pid -> thread id for the detached processes. `others`: [pid, thread id, kind, claude -p record or null]
     for the rest. */
  const counted = new Map();
  const others = [];
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
    if (kind === 'detached' && p.sid !== pid && !STARTERS.has(path.basename(argvOf(pid)[0] || ''))) continue;
    if (kind === 'codexExec' && !isCodexExec(argvOf(pid))) continue;
    add(id, kind);
    if (kind === 'detached') counted.set(pid, id.toLowerCase()); else others.push([pid, id.toLowerCase(), kind, null]);
  }
  for (const r of records) {
    if (!isWorker(r)) continue;
    const id = threadOf(r.pid);
    if (!THREAD_ID.test(id)) continue;
    add(id, 'claudeWorker');
    if (all.has(r.pid)) others.push([r.pid, id.toLowerCase(), 'claudeWorker', r]);
  }
  if (environs) {
    for (const [pid, kept] of environs) {
      const p = all.get(pid);
      if (!p || p.start !== kept.start || p.comm !== kept.comm) environs.delete(pid);
    }
  }
  const boot = bootMs(proc);
  const running = others.map(([pid, id, kind, r]) => ({ thread: id, kind, ...describe(pid, all, boot, argvOf),
    name: r ? recordName(r) : '', session: r ? recordSession(r) : '', job: '' }));
  return { available: true, threads, detached: topsOf(counted, all, boot, argvOf), running: running.sort(byStart) };
}

/* /proc's clock ticks per second (USER_HZ), the unit of a stat file's start time. */
const TICKS = 100;
/* When the machine booted, in ms, from /proc/stat's btime, or 0. */
function bootMs(proc) {
  const m = /^btime (\d+)$/m.exec(read(path.join(proc, 'stat'), 'latin1') || '');
  return m ? Number(m[1]) * 1000 : 0;
}
/* Command lines are cut to this length when a process is listed; the Agent map shows less. */
const CMD_MAX = 1000;
const startMsOf = (p, boot) => (boot && p ? Math.round(boot + (Number(p.start) / TICKS) * 1000) : 0);
/* A process listed: its pid, its start from the stat file and in ms, and its command line. The start goes with the pid
   because pids are reused. */
function describe(pid, all, boot, argvOf) {
  const p = all.get(pid);
  return { pid, start: String(p.start), startMs: startMsOf(p, boot),
    cmd: argvOf(pid).filter((a, i, list) => a || i < list.length - 1).join(' ').slice(0, CMD_MAX) };
}
const byStart = (a, b) => (a.startMs - b.startMs) || (a.pid - b.pid);
/*
 * The detached processes of `counted` (pid -> thread id) that have no counted ancestor of the same conversation, the
 * top of each tree, as [{ thread, pid, start, startMs, cmd }], sorted by pid.
 */
function topsOf(counted, all, boot, argvOf) {
  const out = [];
  for (const [pid, id] of counted) {
    let top = true;
    for (let q = (all.get(pid) || {}).ppid, hops = 0; q > 1 && hops < MAX_DEPTH; hops++) {
      if (counted.get(q) === id) { top = false; break; }
      const info = all.get(q);
      if (!info) break;
      q = info.ppid;
    }
    if (!top) continue;
    out.push({ thread: id, ...describe(pid, all, boot, argvOf) });
  }
  return out.sort((a, b) => a.pid - b.pid);
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
 * printed an older launch back, a grep of a log say, leaves the very same line. When such a command is still running as
 * exec_command answers, a launch in its later write_stdin output counts as well.
 */
function launches(file, cache) {
  let st;
  try { st = fs.statSync(file); } catch (_) { cache.delete(file); return new Set(); }
  let c = cache.get(file);
  if (!c || st.size < c.pos) {
    c = { pos: Math.max(0, st.size - LAUNCH_TAIL), calls: new Set(), sessions: new Set(), jobs: new Set(), mid: st.size > LAUNCH_TAIL };
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
    const poll = !call && c.sessions.size > 0 && line.includes('"function_call"') && line.includes('write_stdin');
    const out = !call && !poll && line.includes('function_call_output') && (line.includes('backgrounded') || line.includes('claude attach')
      || line.includes('claude logs') || line.includes('claude stop') || line.includes('Process running with session ID'));
    if (!call && !poll && !out) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const p = row && row.payload;
    if (!p || !p.call_id) continue;
    if (call && p.type === 'function_call' && BG_CMD.test(commandOf(p.arguments))) {
      c.calls.add(p.call_id);
      if (c.calls.size > MAX_CALLS) c.calls.delete(c.calls.values().next().value);
    } else if (poll && p.type === 'function_call' && p.name === 'write_stdin') {
      let a = null;
      try { a = JSON.parse(p.arguments); } catch (_) { /* not ours */ }
      if (a && c.sessions.has(String(a.session_id))) {
        c.calls.add(p.call_id);
        if (c.calls.size > MAX_CALLS) c.calls.delete(c.calls.values().next().value);
      }
    } else if (out && p.type === 'function_call_output' && c.calls.has(p.call_id)) {
      const text = outputText(p.output);
      STILL_RUNNING.lastIndex = 0;
      for (const m of text.matchAll(STILL_RUNNING)) c.sessions.add(m[1]);
      while (c.sessions.size > MAX_SESSIONS) c.sessions.delete(c.sessions.values().next().value);
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
 * All windows on this machine, in any editor, would read the same /proc and get the same answer, so they share one scan
 * through SHARE_FILE in `share`, a folder in the plan directory. A window uses a scan written less than SHARE_MS ago;
 * otherwise it scans and writes its result over the file, through a temporary file renamed into place. The file has a
 * folder of its own because the plan directory's time is part of the snapshot's stamp (src/codex-worker.js stampOf),
 * and Agent Plus's watcher and the copy made before an uninstall take every *.json at the top of that directory for a
 * plan. A build that does not know the file scans for itself. The claude --bg launches are not in it: each window
 * reads them from where it left off in the rollouts.
 */
const SHARE_DIR = 'shared';
const SHARE_FILE = 'left-running.json';
/* Format 1 listed only the detached commands, format 2 had no holders of Codex's writer locks; a window that reads an
   older one scans for itself. */
const SHARE_FORMAT = 3;
const SHARE_MS = 9000;
const SCANNED_KINDS = new Set(['command', 'detached', 'codexExec', 'claudeWorker']);
const LISTED_KINDS = new Set(['command', 'codexExec', 'claudeWorker']);

function sharedOf(text, { proc, sessions, codex, now }) {
  let d;
  try { d = JSON.parse(text); } catch (_) { return null; }
  if (!d || d.format !== SHARE_FORMAT || d.proc !== proc || d.sessions !== sessions || d.codex !== codex || typeof d.available !== 'boolean') return null;
  if (typeof d.at !== 'number' || !(d.at <= now) || now - d.at >= SHARE_MS) return null;
  if (!d.threads || typeof d.threads !== 'object' || Array.isArray(d.threads)) return null;
  for (const [id, kinds] of Object.entries(d.threads)) {
    if (!THREAD_ID.test(id) || !Array.isArray(kinds) || !kinds.every((k) => SCANNED_KINDS.has(k))) return null;
  }
  if (!Array.isArray(d.bg) || !d.bg.every(isBgEntry)) return null;
  if (!Array.isArray(d.detached) || !d.detached.every(isDetachedEntry)) return null;
  if (!Array.isArray(d.running) || !d.running.every(isRunningEntry)) return null;
  if (!Array.isArray(d.holders) || !d.holders.every(writerLocks.isHolder)) return null;
  return { available: d.available, threads: d.threads, bg: d.bg, detached: d.detached, running: d.running, holders: d.holders };
}
const isProcessEntry = (e) => !!e && Number.isInteger(e.pid) && e.pid > 0 && typeof e.start === 'string' && Number.isFinite(e.startMs);
const isDetachedEntry = (e) => isProcessEntry(e) && THREAD_ID.test(e.thread) && typeof e.cmd === 'string';
const isRunningEntry = (e) => isDetachedEntry(e) && LISTED_KINDS.has(e.kind) && typeof e.name === 'string' && typeof e.session === 'string'
  && typeof e.job === 'string';
const isBgEntry = (e) => isProcessEntry(e) && typeof e.job === 'string' && JOB_ID.test(e.job) && typeof e.name === 'string'
  && typeof e.session === 'string';

function writeShared(file, text) {
  const tmp = `${file}.${process.pid}.${require('worker_threads').threadId}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
  }
}

/*
 * The /proc part of a scan, { available, threads: { [thread id]: [kinds] }, bg, detached, running, holders }, where bg
 * is busyBg()'s list, detached and running are snapshot()'s, and holders the processes holding conversations of
 * `codexHome` open (src/writer-locks.js). It is another window's scan when `share` holds one written less than
 * SHARE_MS before `now`.
 */
function scan({ proc = '/proc', sessionsDir, share = '', environs = null, now = Date.now(), codexHome = '' } = {}) {
  const sessions = path.resolve(sessionsDir || sessionsHome());
  const codex = codexHome ? path.resolve(codexHome) : '';
  const file = share ? path.join(share, SHARE_FILE) : '';
  if (file) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { text = null; }
    const got = text === null ? null : sharedOf(text, { proc, sessions, codex, now });
    if (got) return got;
  }
  const procs = processes(proc);
  const records = readRecords(sessionsDir, { procs });
  const snap = snapshot({ proc, records, procs, environs });
  const threads = {};
  for (const [id, kinds] of snap.threads) threads[id] = [...kinds];
  const argvOf = (pid) => { const a = read(path.join(proc, String(pid), 'cmdline'), 'latin1'); return a ? a.split('\0') : []; };
  const out = { available: snap.available, threads, bg: busyBg(records, procs, bootMs(proc)), detached: snap.detached || [],
    running: snap.running || [], holders: writerLocks.holders({ codexHome: codex, proc, all: procs, argvOf, isExec: isCodexExec }) };
  if (file) {
    /* Made only inside a plan directory that is there: without one the plugin is not installed. */
    try { fs.mkdirSync(share); } catch (_) { /* there already, or no plan directory */ }
    writeShared(file, JSON.stringify({ format: SHARE_FORMAT, at: Date.now(), proc, sessions, codex, ...out }) + '\n');
  }
  return out;
}

/*
 * One scan of `threads`, the recent threads the worker passes in, as [{ id, rollout }].
 * Returns the scan without `bg`: each busy claude --bg session is added under the conversation that launched it, as
 * the kind claudeBg and as an entry of `running`. `cache` keeps how far each rollout has been read for launches;
 * rollouts no longer passed in are dropped from it.
 */
function leftRunning({ threads = [], proc = '/proc', sessionsDir, cache = new Map(), environs = null, share = '', now = Date.now(), codexHome = '' } = {}) {
  const found = scan({ proc, sessionsDir, share, environs, now, codexHome });
  const out = {};
  for (const [id, kinds] of Object.entries(found.threads)) out[id] = [...kinds];
  const jobs = new Map((found.bg || []).map((b) => [b.job, b]));
  const running = (found.running || []).slice();
  const keep = new Set();
  if (jobs.size) {
    for (const t of threads) {
      if (!t || !t.rollout || !THREAD_ID.test(String(t.id || ''))) continue;
      keep.add(t.rollout);
      const mine = [...launches(t.rollout, cache)].filter((j) => jobs.has(j));
      if (!mine.length) continue;
      const id = t.id.toLowerCase();
      out[id] = [...new Set([...(out[id] || []), 'claudeBg'])];
      for (const j of mine) {
        const b = jobs.get(j);
        running.push({ thread: id, kind: 'claudeBg', pid: b.pid, start: b.start, startMs: b.startMs, cmd: '', name: b.name, session: b.session, job: j });
      }
    }
  }
  for (const f of [...cache.keys()]) if (!keep.has(f) && jobs.size) cache.delete(f);
  return { available: found.available, threads: out, detached: found.detached || [], running: running.sort(byStart), holders: found.holders || [] };
}

module.exports = { snapshot, processes, readRecords, busyBg, launches, scan, leftRunning, isCodexExec, envValue, commandOf, STARTERS, KINDS,
  LEFT_EVERY_MS, LAUNCH_TAIL, SHARE_DIR, SHARE_FILE, SHARE_FORMAT, SHARE_MS };
