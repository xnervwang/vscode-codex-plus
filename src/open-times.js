// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * How long Codex took to open one of its pages (the sidebar or a tab), read out of Codex's own log.
 *
 * Codex measures this itself. Each time one of its pages starts, it writes one `client.performance.span name=app_start`
 * line to `Codex.log` in its extension host's log folder: the whole time, the time each stage was reached (`marksMs`),
 * whether the page opened on a conversation or on its home page, and whether it gave up (`outcome=failure
 * reason=timeout`). So nothing is paired or timed here; the lines are found and read.
 *
 * Every window's Codex.log under VS Code's logs folder is read, since one window opens only a few pages. They are read
 * only when asked for (Show Status and the command), each from the offset it was read to the time before, with fs
 * promises so the extension host's thread is not held.
 */
const fs = require('fs');
const path = require('path');

/* `2026-11-08 21:01:08.567 [info] client.performance.span key=value ...`, in the extension host's local time. */
const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[\w+\] client\.performance\.span (.*)$/;
/* `marksMs` is compact JSON with no nested object; every other value has no space in it. */
const FIELD = /(\w+)=(\{[^}]*\}|\S+)/g;
/* The first read of a file takes at most its last this many bytes. */
const FIRST_READ_MAX = 8 << 20;
/* Spans kept per file. */
const KEEP = 200;

/* The stages a person can tell apart, in the order Codex reaches them. The last one is the page's content. */
const STAGES = [
  ['renderer_entry_evaluated', 'script run'],
  ['shell_visible', 'first screen'],
];
const CONTENT = { thread: 'thread_visible', home: 'home_visible' };

function num(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : null;
}

/** One app_start span from a log line, or null for any other line. `at` is when the page began to start. */
function parseSpan(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const f = {};
  for (const x of m[8].matchAll(FIELD)) f[x[1]] = x[2];
  if (f.name !== 'app_start') return null;
  let marks = {};
  try { marks = JSON.parse(f.marksMs || '{}') || {}; } catch (_) { marks = {}; }
  const logged = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
  const ms = num(f.durationMs);
  return {
    at: logged - (ms || 0),
    ms,
    surface: f.initialSurface || '',
    outcome: f.outcome || '',
    reason: f.reason && f.reason !== 'null' ? f.reason : '',
    background: num(f.backgroundDurationMs) || 0,
    marks: marks && typeof marks === 'object' ? marks : {},
  };
}

/** The spans in `text`, which holds whole lines. */
function spansIn(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.includes('name=app_start')) continue;
    const s = parseSpan(line);
    if (s) out.push(s);
  }
  return out;
}

/** This window's Codex.log and VS Code's logs folder, from this extension's own log folder; '' for either not known. */
function whereLogs(ourLogDir) {
  if (!ourLogDir) return { own: '', root: '' };
  const host = path.dirname(ourLogDir);
  return { own: path.join(host, 'openai.chatgpt', 'Codex.log'), root: path.dirname(path.dirname(host)) };
}

function createOpenTimes({ own = '', root = '' } = {}) {
  const files = new Map();

  async function listLogs() {
    const out = new Set(own ? [own] : []);
    let sessions = [];
    try { sessions = root ? await fs.promises.readdir(root) : []; } catch (_) { sessions = []; }
    for (const s of sessions) {
      let hosts = [];
      try { hosts = await fs.promises.readdir(path.join(root, s)); } catch (_) { continue; }
      for (const h of hosts) if (/^exthost\d+$/.test(h)) out.add(path.join(root, s, h, 'openai.chatgpt', 'Codex.log'));
    }
    return [...out];
  }

  async function readOne(file) {
    let st;
    try { st = await fs.promises.stat(file); } catch (_) { files.delete(file); return; }
    let have = files.get(file);
    if (have && (have.ino !== st.ino || st.size < have.size)) have = null;
    if (!have) have = { ino: st.ino, size: Math.max(0, st.size - FIRST_READ_MAX), spans: [], midLine: st.size > FIRST_READ_MAX };
    files.set(file, have);
    if (st.size <= have.size) return;
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
      const buf = Buffer.alloc(st.size - have.size);
      const { bytesRead } = await fh.read(buf, 0, buf.length, have.size);
      /* A line still being written is left for the next read. */
      const end = buf.lastIndexOf(0x0a, bytesRead - 1);
      if (end < 0) return;
      let text = buf.toString('utf8', 0, end + 1);
      if (have.midLine) { text = text.slice(text.indexOf('\n') + 1); have.midLine = false; }
      have.spans = have.spans.concat(spansIn(text)).slice(-KEEP);
      have.size += end + 1;
    } catch (_) { /* read again from the same offset next time */ } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  /** Every span found so far, oldest first, each marked `here` when it is from this window's log. */
  async function read() {
    const list = await listLogs();
    for (const f of list) await readOne(f);
    for (const f of [...files.keys()]) if (!list.includes(f)) files.delete(f);
    const all = [];
    for (const [file, e] of files) for (const s of e.spans) all.push({ ...s, here: file === own });
    return all.sort((a, b) => a.at - b.at);
  }

  return { read, listLogs };
}

function secs(ms) {
  if (ms == null) return '?';
  return ms >= 100000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** `2026-11-08 13:01` in `zone`, or in UTC with the zone named when `zone` is not one this Node knows. */
function clock(ms, zone) {
  const d = new Date(ms);
  if (zone) {
    try { return d.toLocaleString('sv-SE', { timeZone: zone, hour12: false }).slice(0, 16); } catch (_) { /* below */ }
  }
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One open on one line: when, which surface, the whole time and the stages. */
function describe(s, zone) {
  const stages = STAGES.filter(([k]) => num(s.marks[k]) != null).map(([k, label]) => `${label} ${secs(num(s.marks[k]))}`);
  const content = CONTENT[s.surface];
  if (s.outcome === 'success' && content && num(s.marks[content]) != null) stages.push(`${s.surface} shown ${secs(num(s.marks[content]))}`);
  const resumed = num(s.marks.resume_finished) != null && num(s.marks.resume_started) != null
    ? num(s.marks.resume_finished) - num(s.marks.resume_started) : null;
  if (resumed != null) stages.push(`restoring the conversation ${secs(resumed)}`);
  if (s.outcome !== 'success') {
    const reached = Object.keys(s.marks).filter((k) => num(s.marks[k]) != null).sort((a, b) => s.marks[a] - s.marks[b]).pop();
    if (reached) stages.push(`last stage reached: ${reached}`);
  }
  if (s.background) stages.push(`${secs(s.background)} of it with the window in the background`);
  const head = s.outcome === 'success' ? secs(s.ms) : `${(s.reason || s.outcome || 'unknown').toUpperCase()} after ${secs(s.ms)}`;
  return `${clock(s.at, zone)}  ${(s.surface || '?').padEnd(6)}  ${head}${stages.length ? `  (${stages.join(', ')})` : ''}${s.here ? '  [this window]' : ''}`;
}

/** Per surface: how many opened, the median and slowest of those that did, and how many gave up. */
function summaryLines(spans) {
  const by = new Map();
  for (const s of spans) {
    const k = s.surface || '?';
    if (!by.has(k)) by.set(k, { ok: [], failed: 0 });
    if (s.outcome === 'success' && s.ms != null) by.get(k).ok.push(s.ms); else by.get(k).failed++;
  }
  const out = [];
  for (const [k, v] of [...by].sort()) {
    const ok = v.ok.sort((a, b) => a - b);
    out.push(`  ${k}: ${ok.length + v.failed} opened, median ${secs(median(ok))}, slowest ${secs(ok[ok.length - 1])}`
      + `${v.failed ? `, ${v.failed} gave up` : ''}`);
  }
  return out;
}

/** The lines for Show Status (`last` opens) or for the command of its own (more of them). */
function reportLines(spans, { zone = '', last = 5 } = {}) {
  if (!spans.length) {
    return ['Opening a Codex page: no timings in Codex\'s logs (Codex logs one line each time its sidebar or a tab starts)'];
  }
  const shown = spans.slice(-last);
  return [
    `Opening a Codex page, as Codex's own log times it (${spans.length} found; times in ${zone || 'UTC'}):`,
    ...summaryLines(spans),
    `  the last ${shown.length}, newest last; "script run" is when Codex's page script had loaded and run:`,
    ...shown.map((s) => `    ${describe(s, zone)}`),
  ];
}

module.exports = { parseSpan, spansIn, whereLogs, createOpenTimes, reportLines, describe, FIRST_READ_MAX };
