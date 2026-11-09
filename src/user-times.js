// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The times at which the user's own messages in one conversation were sent, read from its rollout.
 *
 * The host reads them because Codex's page carries a sent time for a reply on an attribute of its own, while for one
 * of the user's own messages it carries one only as rendered text in a hover row with no stable name to select it by.
 * So the page tries that text first and asks for these as its second source (src/page/codex-extras-page.js).
 *
 * The times come back as a list in order, with nothing to tie an entry to a particular message, so the page uses them
 * only when it shows exactly as many user messages as there are times here, and shows none otherwise. No message text
 * is read.
 *
 * The same pass notes where Codex compacted the conversation's context, as the number of the user's messages that came
 * before each compaction, which places it in the page's list of those messages under the same condition.
 *
 * It also notes, per turn, the model and effort the turn ran with and how much of the context window its last model call
 * used, for the line under each reply. A token_count carries no turn id, so it belongs to the turn whose task_started or
 * turn_context came last before it. The page places these by the turn id Codex puts on each turn, not by position.
 *
 * A rollout is append-only, so a conversation is read once and then only its new bytes: the cache keeps the size the
 * file had, the offset of the first incomplete line and the times found so far. A file that shrank, or one whose first
 * read would be larger than MAX_BYTES, is read from the start or not at all.
 */
const fs = require('fs');
const files = require('./codex-files');

/* A rollout larger than this is not read: these times are a convenience, and the user's thread is shared. */
const MAX_BYTES = 64 << 20;
/* Past this many, the list costs more to send than the navigation strip showing it is worth. */
const MAX_TIMES = 20000;
const CHUNK = 1 << 20;
/* How many conversations' reads are remembered. */
const KEEP = 16;
/* Turns remembered per conversation, and how many of the newest are sent to a page. */
const TURNS_KEPT = 400;
const TURNS_SENT = 200;

/*
 * A user-role message Codex wrote itself rather than one the user typed: its whole text is one XML-ish block, as in
 * <environment_context>. Every one of the 40 rollouts read while this was written held exactly one such message and no
 * other, while whether the row carries a `metadata` key does not tell the two apart. A message the user really did
 * begin with such a tag is counted out here. The counts then differ, and the page shows no times at all.
 */
const INJECTED = /^\s*<[a-z][a-z0-9_]*>/;

const cache = new Map();

function textOf(payload) {
  const c = payload && payload.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let out = '';
  for (const part of c) if (part && typeof part.text === 'string') out += part.text;
  return out;
}

/** The complete lines of `text`, and the byte length of the part that was whole lines. */
function wholeLines(text) {
  const nl = text.lastIndexOf('\n');
  if (nl < 0) return { lines: [], bytes: 0 };
  const head = text.slice(0, nl + 1);
  return { lines: head.split('\n').filter((l) => l.trim()), bytes: Buffer.byteLength(head, 'utf8') };
}

/**
 * The times of the user's own messages among `lines`, appended to `into`. `broken` means a message of theirs carried
 * no readable time, which makes the list one short of what the page would count and so unusable as a whole.
 */
function timesIn(lines, into = [], compactions = [], turns = { byId: new Map(), current: '' }) {
  let broken = false;
  for (const line of lines) {
    /* Nearly every line of a rollout is a tool call; this spares those a JSON parse. */
    const compacted = line.includes('"compacted"');
    const turnish = line.includes('"token_count"') || line.includes('"turn_context"') || line.includes('"task_started"');
    if (!compacted && !turnish && !line.includes('"user"')) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    if (turnish && row) noteTurn(row, turns);
    if (row && row.type === 'compacted') {
      const at = Date.parse(row.timestamp);
      compactions.push({ after: into.length, at: Number.isFinite(at) ? at : 0 });
      continue;
    }
    const p = row && row.payload;
    if (!row || row.type !== 'response_item' || !p || p.type !== 'message' || p.role !== 'user') continue;
    if (INJECTED.test(textOf(p))) continue;
    const at = Date.parse(row.timestamp);
    if (Number.isFinite(at)) into.push(at); else broken = true;
  }
  return { times: into, compactions, turns, broken };
}

/** The model, effort and context of the turn a row belongs to. */
function noteTurn(row, turns) {
  const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const start = (row.type === 'turn_context' || (row.type === 'event_msg' && p.type === 'task_started')) && p.turn_id;
  if (start) {
    turns.current = String(p.turn_id);
    const e = turns.byId.get(turns.current) || {};
    if (row.type === 'turn_context') { e.model = String(p.model || ''); e.effort = String(p.effort || p.reasoning_effort || ''); }
    turns.byId.delete(turns.current);
    turns.byId.set(turns.current, e);
    while (turns.byId.size > TURNS_KEPT) turns.byId.delete(turns.byId.keys().next().value);
    return;
  }
  if (row.type !== 'event_msg' || p.type !== 'token_count' || !p.info || !turns.current) return;
  const e = turns.byId.get(turns.current);
  const used = +((p.info.last_token_usage || {}).input_tokens) || 0;
  const window = +p.info.model_context_window || 0;
  if (e && used && window) { e.used = used; e.window = window; }
}

/** `ctx 33% · gpt-6.1-sol high` for one turn, or '' when nothing about it is known. */
function turnFigure(e) {
  const parts = [];
  if (e.used && e.window) parts.push(`ctx ${Math.round(100 * e.used / e.window)}%`);
  const model = [String(e.model || '').replace(/^openai\./, ''), e.effort].filter(Boolean).join(' ');
  if (model) parts.push(model);
  return parts.join(' · ');
}

/** The newest turns' figures, as { turnId: text }. */
function turnFigures(turns) {
  const out = {};
  const ids = [...turns.byId.keys()].slice(-TURNS_SENT);
  for (const id of ids) { const t = turnFigure(turns.byId.get(id)); if (t) out[id] = t; }
  return out;
}

function readRange(file, start, end) {
  if (end <= start) return '';
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  try {
    const want = end - start;
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buf, got, Math.min(CHUNK, want - got), start + got);
      if (!n) break;
      got += n;
    }
    return buf.slice(0, got).toString('utf8');
  } catch (_) { return null; } finally { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
}

/**
 * `{ times, compactions }` with the times oldest first, or null when the rollout cannot supply a complete list: it is
 * gone, compressed, too large, one of the messages carried no readable time, or there are more than any list would show.
 */
function rolloutMarks(rollout) {
  const file = files.existingRollout(rollout);
  /* A conversation untouched for a week: Codex has compressed it, and nobody is stamping its page right now. */
  if (!file || file.endsWith('.zst')) return null;
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return null; }
  let have = cache.get(file);
  const out = (e) => (e.broken ? { times: null, compactions: [], turns: turnFigures(e.turns) }
    : { times: e.times, compactions: e.compactions, turns: turnFigures(e.turns) });
  if (have && have.size === size) return out(have);
  /* A file smaller than it was is not the same file appended to. */
  if (!have || size < have.size) have = { size: 0, offset: 0, times: [], compactions: [], turns: { byId: new Map(), current: '' }, broken: false };
  if (!have.offset && size > MAX_BYTES) return null;
  const text = readRange(file, have.offset, size);
  if (text === null) return null;
  const { lines, bytes } = wholeLines(text);
  const found = timesIn(lines, have.times, have.compactions, have.turns);
  const entry = { size, offset: have.offset + bytes, times: found.times, compactions: found.compactions, turns: found.turns,
    broken: have.broken || found.broken || found.times.length > MAX_TIMES };
  cache.delete(file);
  cache.set(file, entry);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value);
  return out(entry);
}

/** Just the times of rolloutMarks(), or null. */
function userTimes(rollout) {
  const r = rolloutMarks(rollout);
  return r ? r.times : null;
}

function forget() { cache.clear(); }

module.exports = { MAX_BYTES, MAX_TIMES, TURNS_SENT, INJECTED, textOf, wholeLines, timesIn, turnFigures, userTimes, rolloutMarks, forget };
