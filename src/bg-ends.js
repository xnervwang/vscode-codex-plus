// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Tells a conversation when a `claude --bg` session it started ends or stops to wait for an answer. Claude Code does not
 * tell it. Without this the conversation has to keep checking, or set a wake-up.
 *
 * The sessions a conversation started are the launches src/left-running.js reads from its rollout, and a session's
 * state is its record under ~/.claude/jobs. Every window compares those states with the ones last seen, kept in
 * SEEN_FILE in the folder the windows share. Each change worth reporting is written once, as its own file in ENDS_DIR
 * created with O_EXCL, and src/detached-ends.js deliver() sends the files to a conversation a window has loaded: an idle
 * conversation starts a turn.
 *
 * On the first look nothing is reported; the sessions that ended before then are only noted. Nor is a session the
 * conversation stopped itself.
 *
 * update() blocks; it runs in the worker thread (src/codex-worker.js), after each scan for work left running.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launches, commandOf } = require('./left-running');

const SEEN_FILE = 'background-seen.json';
const ENDS_DIR = 'background-ended';
/* How long a record may say "working" or "blocked" with no process behind it before the session counts as dead: the
   daemon writes the record and its process record separately. */
const DEAD_AFTER_MS = 2 * 60000;
/* A session that is already over when first found is reported only if it finished after the last look, give or take
   this much. */
const SEEN_SLACK_MS = 60000;
/* Longer fields are cut: the notice goes into the conversation's context. */
const NOTICE_TEXT = 300;
const WHO = 'Codex Plus';
const ENDED = new Set(['done', 'failed', 'stopped']);
const JOB_ID = /^[0-9a-f]{8}$/;
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* The end of a rollout searched for the command that stopped a session. */
const STOP_BYTES = 2 << 20;

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const time = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return isFinite(t) ? t : 0; };
const str = (v) => (typeof v === 'string' ? v : '');
const clip = (s, n = NOTICE_TEXT) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };

/* A session's record, read again only when the file has changed. */
const cache = new Map();
function stateOf(jobs, id) {
  const file = path.join(jobs, id, 'state.json');
  let st;
  try { st = fs.statSync(file); } catch (_) { cache.delete(file); return null; }
  const was = cache.get(file);
  if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) return was.entry;
  const d = readJson(file);
  if (!d || typeof d !== 'object') return was ? was.entry : null;
  const result = d.output && typeof d.output === 'object' ? d.output.result : d.output;
  const entry = { state: str(d.state), name: str(d.name), detail: str(d.detail), needs: str(d.needs), result: str(result),
    updatedAt: time(d.updatedAt), endedAt: time(d.lastTerminalAt) || time(d.firstTerminalAt), startedAt: time(d.createdAt) };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry });
  return entry;
}

/* A key for what to report about a session, '' for nothing. */
function signature(e, live, now) {
  if (ENDED.has(e.state)) return `${e.state}@${e.endedAt}`;
  if (live) return e.state === 'blocked' ? `blocked@${e.needs}` : '';
  return now - (e.updatedAt || 0) > DEAD_AFTER_MS ? `died@${e.startedAt}` : '';
}

/*
 * The job ids of the `claude --bg` sessions whose process is alive, from Claude Code's process records. Where `proc`
 * can be read, a record counts only if the process now holding its pid started at the time the record gives, as in
 * src/left-running.js readRecords; only the stat files of the pids the records name are read.
 */
function liveJobs(dir, proc = '/proc') {
  const out = new Set();
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return out; }
  const hasProc = fs.existsSync(proc);
  for (const n of names) {
    const d = readJson(path.join(dir, n));
    if (!d || d.kind !== 'bg' || typeof d.jobId !== 'string' || !JOB_ID.test(d.jobId) || !Number.isInteger(d.pid)) continue;
    let stat = null;
    try { stat = fs.readFileSync(path.join(proc, String(d.pid), 'stat'), 'latin1'); } catch (_) { stat = null; }
    if (stat) {
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (typeof d.procStart === 'string' && d.procStart && f[19] !== d.procStart) continue;
    } else if (hasProc) continue;
    else {
      try { process.kill(d.pid, 0); } catch (e) { if (!(e && e.code === 'EPERM')) continue; }
    }
    out.add(d.jobId);
  }
  return out;
}

/* Whether one of the conversation's commands stopped or removed session `id`. `lines` are the end of its rollout. */
function stoppedBy(lines, id) {
  const direct = new RegExp(`\\b(?:stop|rm)\\s+["']?${id}\\b`);
  const loop = new RegExp(`\\bfor\\s+(\\w+)\\s+in\\s+[^;\\n]*\\b${id}\\b[\\s\\S]*?\\b(?:stop|rm)\\s+["']?\\$\\{?\\1\\b`);
  for (const line of lines || []) {
    if (line.indexOf('"function_call"') === -1 || line.indexOf(id) === -1) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const p = row && row.payload;
    const c = p && p.type === 'function_call' ? commandOf(p.arguments) : '';
    if (c.includes(id) && (direct.test(c) || loop.test(c))) return true;
  }
  return false;
}

const tailOf = (rollout) => require('./codex-files').tailLines(rollout, STOP_BYTES);

/*
 * Records the changes since SEEN_FILE in `dir` was written and returns them. `threads` are the recent conversations as
 * [{ id, rollout }], `cache` the launches read so far (src/left-running.js launches). `claim` is false while the
 * notices are off: nothing is recorded then, so turning them on does not report what happened in the meantime.
 */
function update({ dir, threads = [], cache: launched = new Map(), jobs = path.join(claudeHome(), 'jobs'),
  sessions = path.join(claudeHome(), 'sessions'), proc = '/proc', now = Date.now(), claim = true, tail = tailOf }) {
  if (!dir || !fs.existsSync(dir)) return [];
  let known = [];
  try { known = fs.readdirSync(jobs).filter((n) => JOB_ID.test(n)); } catch (_) { known = []; }
  const ids = new Set(known);
  const seenFile = path.join(dir, SEEN_FILE);
  const was = readJson(seenFile);
  const before = was && was.jobs && typeof was.jobs === 'object' ? was.jobs : null;
  const cur = {}, found = [];
  /* With no session records at all no rollout is read, so a machine without Claude Code reads none. */
  const live = ids.size ? liveJobs(sessions, proc) : new Set();
  for (const t of ids.size ? threads : []) {
    if (!t || !t.rollout || !THREAD.test(String(t.id || ''))) continue;
    const thread = String(t.id).toLowerCase();
    for (const id of launches(t.rollout, launched)) {
      if (!ids.has(id) || id in cur) continue;
      const e = stateOf(jobs, id);
      if (!e) continue;
      const sig = signature(e, live.has(id), now);
      cur[id] = sig || e.state;
      if (sig) found.push({ thread, rollout: t.rollout, id, sig, e });
    }
  }
  const recorded = [];
  if (claim && before) {
    for (const { thread, rollout, id, sig, e } of found) {
      if (before[id] === sig) continue;
      if (before[id] === undefined && ENDED.has(e.state) && e.endedAt < (Number(was.at) || 0) - SEEN_SLACK_MS) continue;
      if (e.state === 'stopped' && stoppedBy(tail(rollout), id)) continue;
      const end = { thread, job: id, kind: sig.slice(0, sig.indexOf('@')), name: e.name, detail: e.detail, needs: e.needs,
        result: e.result, endedAt: e.endedAt, goneAt: now, endMs: now };
      const key = Buffer.from(sig).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(-24);
      try {
        fs.mkdirSync(path.join(dir, ENDS_DIR), { recursive: true });
        fs.writeFileSync(path.join(dir, ENDS_DIR, `${thread}.${id}.${key}.json`), JSON.stringify(end) + '\n', { flag: 'wx' });
        recorded.push(end);
      } catch (_) { /* recorded already, by this window or another */ }
    }
  }
  const sorted = (o) => JSON.stringify(Object.keys(o).sort().reduce((x, k) => { x[k] = o[k]; return x; }, {}));
  if (!before || sorted(before) !== sorted(cur)) {
    const tmp = `${seenFile}.${process.pid}.${require('worker_threads').threadId}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify({ at: now, jobs: JSON.parse(sorted(cur)) }) + '\n'); fs.renameSync(tmp, seenFile); }
    catch (_) { try { fs.unlinkSync(tmp); } catch (e) { /* never written */ } }
  }
  return recorded;
}

const pad = (n) => String(n).padStart(2, '0');
const when = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

function line(e) {
  const at = e.endedAt > 0 ? ` at ${when(e.endedAt)}` : '';
  const what = e.kind === 'done' ? `finished${at}${e.result ? '. Its result: ' + clip(e.result) : ''}`
    : e.kind === 'failed' ? `failed${at}${e.detail ? ': ' + clip(e.detail) : ''}`
      : e.kind === 'stopped' ? `was stopped${at}`
        : e.kind === 'blocked' ? `is waiting for an answer${e.needs ? ': ' + clip(e.needs) : ''}`
          : 'stopped running before it finished: its process is gone';
  return `- ${e.name ? `"${clip(e.name, 80)}" ` : ''}(${e.job}) ${what}`;
}

/* The opening line says it is not from the user, since a queued message reads as the user's. */
function noticeText(ends, { who = WHO } = {}) {
  const one = ends.length === 1;
  const lines = ends.slice().sort((a, b) => (a.goneAt - b.goneAt) || String(a.job).localeCompare(String(b.job))).map(line);
  return `${who} notice, not a message from the user: news of ${one ? 'a `claude --bg` session' : '`claude --bg` sessions'} `
    + `this conversation started.\n${lines.join('\n')}\n\`claude logs <id>\` shows a session's output, and \`claude attach <id>\` `
    + 'answers one that is waiting.';
}

module.exports = { update, noticeText, signature, liveJobs, stoppedBy, SEEN_FILE, ENDS_DIR, DEAD_AFTER_MS, SEEN_SLACK_MS };
