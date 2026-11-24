// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The approvals Codex is asking for wherever a conversation runs, from the marks the plugin's PermissionRequest hook
 * leaves (codex-plugin/agent-work-plan/hooks/mark-waiting.py): <plan dir>/waiting/<thread>.<key>.json, holding
 * { at, session, thread, turn, tool }. This window's app-server tells it only of its own requests (src/approvals.js); the
 * marks add those of the other windows and of Codex's terminal interface.
 *
 * The hook takes a mark away when the tool has run, the thread's turn ends or the next one starts. A denied call gets no
 * hook, and neither does an approval given in another window before its tool finishes, so counted() also ends a mark by
 * the rollout and by the requests this window saw answered.
 */
const fs = require('fs');
const path = require('path');

const WAITING_DIR = 'waiting';
const NAME = /^([0-9a-f][0-9a-f-]{7,})\.([0-9a-f]{16})\.json$/i;
/* A mark this old is of a Codex that never got to clear it (a crash, a killed terminal). */
const MAX_AGE_MS = 24 * 3600e3;

/* The marks under `planDir`, as thread -> [{ at, turn, tool, file }], oldest first. One older than MAX_AGE_MS is
   removed. */
function read(planDir, { now = Date.now() } = {}) {
  const dir = path.join(planDir, WAITING_DIR);
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m) continue;
    const file = path.join(dir, n);
    let d;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    const at = d && Number(d.at);
    if (!(at > 0)) continue;
    if (now - at > MAX_AGE_MS) { remove([file]); continue; }
    const thread = m[1].toLowerCase();
    if (!out.has(thread)) out.set(thread, []);
    out.get(thread).push({ at, turn: typeof d.turn === 'string' ? d.turn : '', tool: typeof d.tool === 'string' ? d.tool : '', file });
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
}

function remove(list) {
  for (const file of list) { try { fs.unlinkSync(file); } catch (_) { /* gone already */ } }
}

/* A string that differs whenever the marks differ; comparing it stands in for comparing the marks. */
const keyOf = (marks) => JSON.stringify([...marks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, l]) => [t, l.map((m) => m.at)]));

/*
 * Counts the marks in `list`, all of one thread, that stand for an approval still asked for, and lists those that are
 * over. `state` is the rollout state the reader has for the thread (src/codex-files.js); `askedHereAt` the last time
 * this window's app-server had an approval of the thread outstanding, 0 if never, and `askedHere` whether it has one
 * now.
 *
 * A mark is over once a turn of the thread ended or started after it was made, or once this window has seen its own
 * request for the thread answered: the mark of a request is written before Codex sends it, so it is older than the
 * moment this window saw it outstanding. A mark is counted only while the rollout shows its thread running; until then
 * it is kept but not counted. `tool` is the hook's tool_name on the oldest mark still counted, '' when there is none or
 * it names no tool.
 */
function counted(list, { state = null, askedHereAt = 0, askedHere = false } = {}) {
  let count = 0, tool = '';
  const over = [];
  for (const m of list || []) {
    if (!askedHere && askedHereAt && m.at <= askedHereAt) { over.push(m.file); continue; }
    if (state && (state.startedMs > m.at || (!state.working && state.endedMs > m.at))) { over.push(m.file); continue; }
    if (state && state.working && !(m.turn && state.turnId && m.turn !== state.turnId)) {
      if (!count) tool = m.tool || '';
      count++;
    }
  }
  return { count, over, tool };
}

module.exports = { read, remove, counted, keyOf, WAITING_DIR, MAX_AGE_MS };
