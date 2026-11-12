// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What can be said about one conversation from outside Codex: its thread id, the codex app-server process this window
 * runs it in, where it started, and where its rollout is and how large. Each value is offered for copying.
 *
 * Every VS Code window runs one `codex app-server`, started by Codex's extension inside this same extension host, so
 * the process to name is the app-server child of this process.
 */
const cp = require('child_process');
const fs = require('fs');
const files = require('./codex-files');

/** The pid of the codex app-server this extension host started, or '' (not found, or not on a system with ps). */
function appServerPid(hostPid = process.pid) {
  if (process.platform === 'win32') return '';
  let out = '';
  try { out = cp.execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 3000 }); } catch (_) { return ''; }
  const rows = out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], args: m[3] }));
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  // Codex may start it through a wrapper, so look a few levels down.
  const queue = [hostPid];
  for (let depth = 0; depth < 4 && queue.length; depth++) {
    const next = [];
    for (const p of queue) for (const k of kids.get(p) || []) {
      if (/\bcodex\b/.test(k.args) && /\bapp-server\b/.test(k.args)) return String(k.pid);
      next.push(k.pid);
    }
    queue.splice(0, queue.length, ...next);
  }
  return '';
}

/*
 * What the work plan's injection hook has added to this conversation's context: how many times, and how many
 * characters, since the latest compaction. Codex records each hook's added context as its own input_text item of a
 * developer message, and the work plan's item starts with PLAN_PREFIX in all three of its forms. A compaction is a row
 * of type `compacted`; the history it carries over is in that row, and is not counted.
 *
 * Read backwards like the rest of the rollout, in windows that grow fourfold up to INJECTED_MAX. A rollout with no
 * compaction in that much of its end gives a count that is short by whatever is earlier, and says so (`whole` false).
 */
const PLAN_PREFIX = "This conversation's work plan";
const INJECTED_START = 256 * 1024;
const INJECTED_MAX = 64 << 20;
/* Characters to a token, for the share of the context: about four for the English this block is written in. */
const CHARS_PER_TOKEN = 4;

function planInjections(file) {
  let bytes = 0;
  try { bytes = fs.statSync(files.existingRollout(file) || file).size; } catch (_) { return { count: 0, chars: 0, sinceCompaction: false, whole: true }; }
  for (let limit = INJECTED_START; ; limit *= 4) {
    const out = { count: 0, chars: 0, sinceCompaction: false, whole: false };
    for (const line of files.tailLines(file, limit)) {
      if (line.includes('"compacted"')) {
        let row = null;
        try { row = JSON.parse(line); } catch (_) { /* not a row */ }
        if (row && row.type === 'compacted') { out.sinceCompaction = true; break; }
      }
      if (!line.includes('"developer"') || !line.includes(PLAN_PREFIX)) continue;
      let row = null;
      try { row = JSON.parse(line); } catch (_) { continue; }
      const p = row && row.type === 'response_item' && row.payload;
      if (!p || p.type !== 'message' || p.role !== 'developer' || !Array.isArray(p.content)) continue;
      for (const item of p.content) {
        const text = item && typeof item.text === 'string' ? item.text : '';
        if (text.startsWith(PLAN_PREFIX)) { out.count++; out.chars += text.length; }
      }
    }
    if (out.sinceCompaction || limit >= bytes) return Object.assign(out, { whole: true });
    if (limit >= INJECTED_MAX) return out;
  }
}

/** The work plan line for planInjections, with its share of the `used` tokens in context; '' if none was injected. */
function planLine(got, used) {
  if (!got.count) return '';
  const tokens = Math.round(got.chars / CHARS_PER_TOKEN);
  const since = got.sinceCompaction ? 'since the last compaction' : got.whole ? 'since the conversation began' : 'in the last 64 MB of the rollout';
  const pct = used ? Math.round(100 * tokens / used) : 0;
  const share = used ? `, ${pct ? `${pct}%` : 'under 1%'} of the ${used} in context` : '';
  return `injected ${got.count} time${got.count === 1 ? '' : 's'} ${since}: ${got.chars} characters, about ${tokens} tokens${share}`;
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1 << 20) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

/** [{ label, value }] for thread `id`, each named in a word or two as Claude Code Plus names its rows. */
function rows(id, { pid = appServerPid() } = {}) {
  const t = (files.listThreads() || []).find((x) => x.id === id) || { id, title: '', cwd: '', rollout: '' };
  const rollout = t.rollout || files.rolloutOf(id);
  let bytes = -1;
  try { bytes = fs.statSync(files.existingRollout(rollout) || rollout).size; } catch (_) { bytes = -1; }
  const st = rollout ? files.rolloutState(rollout) : null;
  const out = [
    { label: 'Thread', value: id },
    { label: 'Title', value: t.title },
    { label: 'Process', value: pid },
    { label: 'Folder', value: t.cwd },
    { label: 'Rollout', value: files.existingRollout(rollout) || rollout || '' },
    { label: 'On disk', value: bytes >= 0 ? size(bytes) : '' },
  ];
  if (st && st.model) out.push({ label: 'Model', value: [st.model, st.effort].filter(Boolean).join(' ') });
  if (st && st.context && st.context.window) {
    out.push({ label: 'Context', value: `${st.context.used} of ${st.context.window} (${Math.round(100 * st.context.used / st.context.window)}%)` });
  }
  /* What this conversation has spent. Codex records no price and its rate-limit records carry no plan or quota here,
     so there is no figure for a share of an allowance or for money - only tokens. */
  if (st && st.tokens && st.tokens.total) {
    const k = st.tokens;
    out.push({ label: 'Tokens', value: `${k.total} (${k.input} in, ${k.output} out`
      + `${k.cached ? `, ${k.cached} cached` : ''}${k.reasoning ? `, ${k.reasoning} reasoning` : ''})` });
  }
  return out.filter((r) => r.value);
}

/* The work plan line for thread `id`, shown on the context meter's hover (src/page/codex-extras-page.js). */
function planText(id) {
  const t = (files.listThreads() || []).find((x) => x.id === id) || { rollout: '' };
  const rollout = t.rollout || files.rolloutOf(id);
  if (!rollout || !files.existingRollout(rollout)) return '';
  const st = files.rolloutState(rollout);
  return planLine(planInjections(rollout), st && st.context ? st.context.used : 0);
}

module.exports = { rows, appServerPid, size, planInjections, planLine, planText, PLAN_PREFIX };
