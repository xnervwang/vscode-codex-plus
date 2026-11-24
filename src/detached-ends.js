// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The notice sent to a conversation when a detached command it started stops.
 *
 * src/left-running.js lists each detached command at the top of its tree, with its pid and start time. Each window
 * remembers the ones its scans have listed. When one is missing from a later scan that could read /proc, the window
 * writes it down in DIR. A window that has the conversation loaded (thread/loaded/list) claims the files by renaming
 * them and queues one notice, as src/wakeup.js does for wake-ups, so Codex sends it once the conversation is idle.
 *
 * This extension did not start the process, so it cannot read its exit code.
 */
const fs = require('fs');
const path = require('path');
const { commandOf } = require('./left-running');

const DIR = 'detached-ends';
const KEEP_MS = 24 * 3600e3;
const BATCH_MS = 60e3;
/* A claim left by a window that went away mid-send is given back after this long. */
const CLAIM_STALE_MS = 5 * 60e3;
const ID_PREFIX = 'codex-plus-detached-';
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENDING = /\.\d+\.sending$/;
/* Launchers and interpreters: the program they run is the word after them. */
const LAUNCHERS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'timeout', 'nohup', 'setsid', 'env', 'nice', 'stdbuf',
  'python', 'python3', 'node', 'perl', 'ruby']);
/* The bytes read from the end of a rollout. */
const RAN_BYTES = 2 << 20;
/* The longest gap between a command and the detached process it starts. */
const RAN_BEFORE_MS = 30 * 60e3;
const RAN_SLACK_MS = 5000;

/*
 * Whether the conversation started a detached process: one of its commands from the half hour before the process
 * started names the program the process runs. One that a command's tool or a hook leaves detached carries the
 * conversation's id too, such as the uploader of usage data that Builder Toolbox starts on each run of brazil or ada.
 * `lines` are the last lines of the conversation's rollout, newest first; null when it has none yet. An empty list
 * means the rollout could not be read.
 */
function ranBy(lines, cmd, startMs = 0) {
  const words = String(cmd).split(/\s+/).filter((w) => w && !w.startsWith('-') && !/^\d+[smhd]?$/.test(w));
  const names = [];
  for (const w of words.slice(0, 4)) {
    const base = path.basename(w);
    if (base.length > 1) names.push(base);
    if (!LAUNCHERS.has(base)) break;
  }
  const own = names.filter((n) => !LAUNCHERS.has(n));
  if (!own.length) return true;
  if (!lines) return false;
  if (!lines.length) return true;
  for (const line of lines) {
    if (line.indexOf('"function_call"') === -1) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const at = Date.parse(row && row.timestamp);
    if (startMs > 0 && isFinite(at) && (at > startMs + RAN_SLACK_MS || at < startMs - RAN_BEFORE_MS)) continue;
    const p = row && row.payload;
    const c = p && p.type === 'function_call' ? commandOf(p.arguments) : '';
    if (c && own.some((n) => c.includes(n))) return true;
  }
  return false;
}

function readJson(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
}
const unlink = (file) => { try { fs.unlinkSync(file); } catch (_) { /* gone */ } };

const pad = (n) => String(n).padStart(2, '0');
const utc = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* The notice for `ends`, [{ pid, startMs, endMs, cmd }]: what it is, then one line for each command. */
function noticeText(ends) {
  const one = ends.length === 1;
  const head = one
    ? 'Codex Plus notice, not a message from the user: a command this conversation left running detached is no longer '
      + 'running. Its exit code cannot be known; look at its output if you need the result.'
    : `Codex Plus notice, not a message from the user: ${ends.length} commands this conversation left running detached are no `
      + 'longer running. Their exit codes cannot be known; look at their output if you need the results.';
  const lines = ends.map((e) => `- ${String(e.cmd || '').slice(0, 300)} (pid ${e.pid}, started ${e.startMs ? utc(e.startMs) : 'at an unknown time'}`
    + `${e.startMs && e.endMs ? `, ran for about ${span(e.endMs - e.startMs)}` : ''})`);
  return [head, ...lines].join('\n');
}

/*
 * `dir()` is the shared folder in the plugin's data folder, `ask(method, params)` a request on Codex's own connection
 * (src/patching.js hostRequest), `enabled()` whether notices are sent (codexPlus.detachedEndNotices through the token
 * mode), `ran(thread, cmd, startMs)` false for a process the conversation did not start (ranBy).
 */
function createDetachedEnds({ dir, ask, now = Date.now, enabled = () => true, ran = () => true, log = () => {} }) {
  const seen = new Map();
  const folder = () => path.join(dir(), DIR);
  const keyOf = (e) => `${String(e.thread).toLowerCase()}.${e.pid}.${e.start}`;

  /** A scan's detached list: the ones listed before and missing now are written down. Returns how many were. */
  function observe(scan) {
    if (!scan || scan.available !== true || !Array.isArray(scan.detached)) return 0;
    const live = new Map(scan.detached.filter((e) => e && THREAD.test(String(e.thread))).map((e) => [keyOf(e), e]));
    let ended = 0;
    for (const [k, e] of seen) {
      if (live.has(k)) continue;
      seen.delete(k);
      if (!enabled() || !ran(String(e.thread).toLowerCase(), String(e.cmd || ''), +e.startMs || 0)) continue;
      try {
        if (!fs.existsSync(dir())) continue;
        fs.mkdirSync(folder(), { recursive: true });
        fs.writeFileSync(path.join(folder(), `${k}.json`), JSON.stringify({ thread: String(e.thread).toLowerCase(), pid: e.pid,
          start: e.start, startMs: e.startMs, cmd: e.cmd, endMs: now() }), { flag: 'wx' });
        ended++;
      } catch (_) { /* another window wrote it, or there is nowhere to write */ }
    }
    for (const [k, e] of live) if (!seen.has(k)) seen.set(k, e);
    return ended;
  }

  /** Sends the recorded ends to their conversations that this window has loaded, and returns how many notices it
      sent. `sub` and `text` give the folder in `dir()` and the notice text for another kind
      of end, such as the claude --bg sessions (src/bg-ends.js). */
  async function deliver({ sub = DIR, text = noticeText } = {}) {
    const here = path.join(dir(), sub);
    let names;
    try { names = fs.readdirSync(here); } catch (_) { return 0; }
    const byThread = new Map();
    for (const n of names) {
      const file = path.join(here, n);
      if (SENDING.test(n)) {
        let st = null;
        try { st = fs.statSync(file); } catch (_) { /* gone */ }
        if (st && now() - st.mtimeMs > CLAIM_STALE_MS) { try { fs.renameSync(file, file.replace(SENDING, '')); } catch (_) { /* taken */ } }
        continue;
      }
      if (n.endsWith('.sent')) {
        if (now() - (+(readJson(file) || {}).at || 0) > KEEP_MS) unlink(file);
        continue;
      }
      if (!n.endsWith('.json')) continue;
      const e = readJson(file);
      if (!e || !THREAD.test(String(e.thread)) || !(now() - (+e.endMs || 0) <= KEEP_MS) || !enabled()) { unlink(file); continue; }
      if (!byThread.has(e.thread)) byThread.set(e.thread, []);
      byThread.get(e.thread).push(file);
    }
    if (!byThread.size) return 0;
    const r = await ask('thread/loaded/list', {});
    const loaded = new Set(r && r.outcome === 'done' && r.result && Array.isArray(r.result.data) ? r.result.data.map((x) => String(x).toLowerCase()) : []);
    let sent = 0;
    for (const [thread, files] of byThread) {
      if (!loaded.has(thread)) continue;
      const mark = path.join(here, `${thread}.sent`);
      if (now() - (+(readJson(mark) || {}).at || 0) < BATCH_MS) continue;
      const claimed = [];
      for (const f of files) {
        const to = `${f}.${process.pid}.sending`;
        try { fs.renameSync(f, to); claimed.push(to); } catch (_) { /* another window took it */ }
      }
      const ends = claimed.map(readJson).filter(Boolean).sort((a, b) => (a.startMs - b.startMs) || (a.pid - b.pid));
      if (!ends.length) { for (const c of claimed) unlink(c); continue; }
      const q = await ask('thread/queue/add', { threadId: thread, clientUserMessageId: `${ID_PREFIX}${now()}`,
        input: [{ type: 'text', text: text(ends), text_elements: [] }] });
      if (q && (q.outcome === 'done' || q.outcome === 'sent')) {
        for (const c of claimed) unlink(c);
        try { fs.writeFileSync(mark, JSON.stringify({ at: now() })); } catch (_) { /* the next one is not held back */ }
        sent++;
      } else {
        for (const c of claimed) { try { fs.renameSync(c, c.replace(SENDING, '')); } catch (_) { /* gone */ } }
        log(`detached command notice for ${thread}: ${(q && q.reason) || (q && q.outcome) || 'not sent'}`);
      }
    }
    return sent;
  }

  return { observe, deliver, _seen: seen };
}

module.exports = { createDetachedEnds, noticeText, ranBy, DIR, KEEP_MS, BATCH_MS, ID_PREFIX, RAN_BYTES, RAN_BEFORE_MS };
