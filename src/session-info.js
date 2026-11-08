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

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1 << 20) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

/** [{ label, value }] for thread `id`. */
function rows(id, { pid = appServerPid() } = {}) {
  const t = (files.listThreads() || []).find((x) => x.id === id) || { id, title: '', cwd: '', rollout: '' };
  const rollout = t.rollout || files.rolloutOf(id);
  let bytes = -1;
  try { bytes = fs.statSync(files.existingRollout(rollout) || rollout).size; } catch (_) { bytes = -1; }
  const st = rollout ? files.rolloutState(rollout) : null;
  const out = [
    { label: 'Thread id', value: id },
    { label: 'Title', value: t.title },
    { label: 'codex app-server pid (this window)', value: pid },
    { label: 'Starting directory', value: t.cwd },
    { label: 'Rollout', value: files.existingRollout(rollout) || rollout || '' },
    { label: 'Rollout size', value: bytes >= 0 ? size(bytes) : '' },
  ];
  if (st && st.model) out.push({ label: 'Model and effort', value: [st.model, st.effort].filter(Boolean).join(' ') });
  if (st && st.context && st.context.window) {
    out.push({ label: 'Context in use', value: `${st.context.used} of ${st.context.window} (${Math.round(100 * st.context.used / st.context.window)}%)` });
  }
  /* What this conversation has spent. Codex records no price and its rate-limit records carry no plan or quota here,
     so there is no figure for a share of an allowance or for money - only tokens. */
  if (st && st.tokens && st.tokens.total) {
    const k = st.tokens;
    out.push({ label: 'Tokens used by this conversation', value: `${k.total} (${k.input} in, ${k.output} out`
      + `${k.cached ? `, ${k.cached} cached` : ''}${k.reasoning ? `, ${k.reasoning} reasoning` : ''})` });
  }
  return out.filter((r) => r.value);
}

module.exports = { rows, appServerPid, size };
