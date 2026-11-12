// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Deletes the conversations that have been archived for codexPlus.deleteArchivedAfterDays days or more.
 *
 * For a conversation archived without Codex's archived_at, the days count from when a pass here first saw it
 * archived, a time kept in the state file. The rollout's modification time is no help, since archiving moves the file
 * and leaves that time as it was.
 *
 * Each window tries once, a minute after it starts, and then again whenever a day has passed since its last try; that
 * check is made on the source's poll rather than by a timer of its own. The lock folder beside the state file
 * (the way src/wakeup.js keeps two windows from both acting) lets only one pass run at a time, and the state file records
 * when the last pass ended, so another window that starts later the same day leaves the work alone.
 *
 * The caller supplies which conversations are open or running (`hold`) and how to delete them (`remove`). The pass
 * itself reads only the snapshot already in memory and its own small state file.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 3600e3;
/* When a pass could not run (another window held the lock, or which conversations are open was not known), the next
   try is this much later. */
const RETRY_MS = 3600e3;
/* A lock folder this old was left by a window that died during a pass. A pass sends one request per conversation, each
   bounded by the app-server's own time limit. */
const LOCK_STALE_MS = 15 * 60e3;

function archivedTime(t, seen = {}) {
  if (+t.archivedMs > 0) return +t.archivedMs;
  return +seen[t.id] > 0 ? +seen[t.id] : 0;
}

/*
 * The threads archived `days` days or more before `now`. A sub-agent whose parent is due is left out, as Codex deletes
 * it together with that parent.
 */
function dueThreads(threads, { days, now, seen = {} }) {
  if (!(days > 0)) return [];
  const cut = now - days * DAY_MS;
  const aged = (threads || []).filter((t) => t && t.id && t.archived && archivedTime(t, seen) > 0 && archivedTime(t, seen) <= cut);
  const agedIds = new Set(aged.map((t) => t.id));
  return aged.filter((t) => !(t.parent && agedIds.has(t.parent)));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const named = (list) => list.map((t) => `"${t.title || '(untitled)'}" (${t.id})`).join(', ');

/*
 * `dir()` is the folder for the state file and the lock, shared by every window of this extension; `home()` is
 * CODEX_HOME, whose name keys both files so that windows using another Codex home do not share them. `days()` is the
 * setting. `threads()` is the snapshot's thread list, or null before there is one. `check()` returns '' when this
 * window may delete, otherwise why not. `hold(ids)` resolves to the set of those ids to leave alone because they or a
 * sub-agent are open or running, or to null when this window cannot tell which are open. `remove(threads)` deletes
 * them and resolves to { deleted: [{ id, title }], failed: [line] }.
 */
function createArchiveSweep({ dir, home, days, threads, check, hold, remove, log = () => {}, now = Date.now }) {
  const key = () => crypto.createHash('sha256').update(String(home() || '')).digest('hex').slice(0, 12);
  const stateFile = () => path.join(dir(), `archive-sweep-${key()}.json`);
  const lockDir = () => path.join(dir(), `archive-sweep-${key()}.lock`);
  let seen = {};
  let next = 0;
  let running = null;

  function readState() {
    try {
      const v = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      return { lastRunMs: +v.lastRunMs || 0, seen: v.seen && typeof v.seen === 'object' ? v.seen : {} };
    } catch (_) { return { lastRunMs: 0, seen: {} }; }
  }
  function writeState(st) {
    const file = stateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, file); } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
      log(`could not record the pass over archived conversations: ${e.message}`);
    }
  }
  function lock() {
    const p = lockDir();
    const held = () => () => { try { fs.rmdirSync(p); } catch (_) { /* gone */ } };
    try { fs.mkdirSync(dir(), { recursive: true }); } catch (_) { /* the mkdir below says */ }
    try { fs.mkdirSync(p); return held(); } catch (_) { /* taken */ }
    try {
      if (now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(p); fs.mkdirSync(p); return held(); }
    } catch (_) { /* another window took it first */ }
    return null;
  }

  async function pass() {
    const why = check();
    if (why) return { ran: false, why };
    const d = Math.floor(+days());
    if (!(d > 0)) return { ran: false, why: 'off' };
    const list = threads();
    if (!list) return { ran: false, why: 'no snapshot', retry: true };
    const release = lock();
    if (!release) return { ran: false, why: 'another window is on it', retry: true };
    try {
      const st = readState();
      if (now() - st.lastRunMs < DAY_MS) { seen = st.seen; return { ran: false, why: 'done today', at: st.lastRunMs }; }
      const at = now();
      const kept = {};
      for (const t of list) if (t && t.archived && t.id && !(+t.archivedMs > 0)) kept[t.id] = +st.seen[t.id] > 0 ? +st.seen[t.id] : at;
      seen = kept;
      const due = dueThreads(list, { days: d, now: at, seen });
      const left = due.length ? await hold(due.map((t) => t.id)) : new Set();
      if (!left) {
        writeState({ lastRunMs: st.lastRunMs, seen });
        log('archived conversations were not deleted: this window could not tell which conversations are open');
        return { ran: false, why: 'open not known', retry: true };
      }
      const go = due.filter((t) => !left.has(t.id));
      const stay = due.filter((t) => left.has(t.id));
      const done = go.length ? await remove(go) : { deleted: [], failed: [] };
      for (const t of done.deleted) delete seen[t.id];
      writeState({ lastRunMs: at, seen });
      if (done.deleted.length) log(`deleted ${plural(done.deleted.length, 'conversation')} archived ${d} or more days ago: ${named(done.deleted)}`);
      if (stay.length) log(`left alone ${plural(stay.length, 'conversation')} archived ${d} or more days ago, as open or running: ${named(stay)}`);
      if (done.failed.length) log(`could not delete ${plural(done.failed.length, 'archived conversation')}:\n  ${done.failed.join('\n  ')}`);
      return { ran: true, deleted: done.deleted, left: stay, failed: done.failed };
    } finally { release(); }
  }

  function run() {
    if (running) return running;
    running = pass().catch((e) => { log(`deleting archived conversations: ${e.message}`); return { ran: false, why: e.message, retry: true }; })
      .then((r) => {
        next = r.retry ? now() + RETRY_MS : (r.at || now()) + DAY_MS;
        return r;
      }).finally(() => { running = null; });
    return running;
  }

  return {
    run,
    start() { next = now(); return run(); },
    /* Called on every poll. */
    tick() { if (next && now() >= next && !running) run(); },
    seenAt(id) { return +seen[id] || 0; },
  };
}

module.exports = { createArchiveSweep, dueThreads, archivedTime, DAY_MS, RETRY_MS, LOCK_STALE_MS };
