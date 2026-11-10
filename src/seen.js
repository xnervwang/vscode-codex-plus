// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * When the user last had each Codex conversation in front of them, which is what "replied and unread" is measured
 * against: a turn that ended after that moment has a reply they have not looked at.
 *
 * Codex's own read receipts (thread_read_receipts in its state database) cannot answer this inside VS Code. The server
 * opens a receipt as unread whenever a turn ends and clears it only on thread/readState/update, and nothing in the VS
 * Code extension or its pages sends that request, so there every receipt stays unread for good. Codex's page keeps its
 * own read state instead, which it does not hand out.
 *
 * Kept in the extension's global state, which every window of the same profile shares, so a conversation read in one
 * window stops counting as unread in the others. Before the first time it is used there is no record of anything, so
 * every turn that ended before then counts as read rather than every old conversation turning up unread at once.
 */
/* The moment before which every reply counts as read: when the record was started, raised whenever entries are dropped
   to keep it bounded. */
const SINCE_KEY = 'codexPlus.seenSince';
const SEEN_KEY = 'codexPlus.seen';
const UNREAD_KEY = 'codexPlus.markedUnread';
/* Enough for every conversation anyone keeps open or comes back to. The entries dropped are the ones looked at
   longest ago, and the start time is raised to the newest of them, so dropping one can only make a reply count as read,
   never bring back as unread one the user had already looked at. */
const KEEP = 400;
const WRITE_MS = 5000;

function memoryState() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); } };
}

function createSeen(state = memoryState(), { now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const first = now();
  if (!Number(state.get(SINCE_KEY, 0))) state.update(SINCE_KEY, first);
  /* Read on every question rather than kept: another window may have raised it, or written a later mark. Marks made
     here and not written yet are merged with what is stored, neither replacing the other. */
  const since = () => Number(state.get(SINCE_KEY, 0)) || first;
  const pending = new Map();
  let timer = null;

  const stored = () => {
    const v = state.get(SEEN_KEY, null);
    return v && typeof v === 'object' ? v : {};
  };
  const at = (id) => Math.max(since(), Number(stored()[id]) || 0, pending.get(id) || 0);

  function write() {
    timer = null;
    if (!pending.size) return;
    const all = { ...stored() };
    for (const [id, ms] of pending) if (!(Number(all[id]) >= ms)) all[id] = ms;
    pending.clear();
    const sorted = Object.entries(all).sort((a, b) => b[1] - a[1]);
    const dropped = sorted.slice(KEEP);
    if (dropped.length && dropped[0][1] > since()) state.update(SINCE_KEY, dropped[0][1]);
    state.update(SEEN_KEY, Object.fromEntries(sorted.slice(0, KEEP)));
  }

  /*
   * Conversations the user marked as unread. They stay unread until the user looks at them again. The marks are stored
   * with the rest, so every window sees them. A conversation marked while it is in front in this window would count as
   * looked at on the very next pass, so it is held until the user has switched away from it once (left()).
   */
  const flagged = () => { const v = state.get(UNREAD_KEY, null); return v && typeof v === 'object' ? v : {}; };
  const held = new Set();
  const setFlag = (id, on) => {
    const all = { ...flagged() };
    if (on) all[id] = true; else delete all[id];
    state.update(UNREAD_KEY, all);
  };

  return {
    /* The user has `id` in front of them now. */
    mark(id) {
      if (!id) return;
      if (flagged()[id] && !held.has(id)) setFlag(id, false);
      pending.set(id, now());
      if (!timer) timer = setTimer(write, WRITE_MS);
    },
    /* Whether a turn that ended at `endedMs` ended after the user last looked at `id`, or the user marked it unread. */
    unread(id, endedMs) {
      if (id && flagged()[id]) return true;
      return !!(id && endedMs && endedMs > at(id));
    },
    /* Mark `id` as unread; `inFront` when the user has it in front now. */
    markUnread(id, inFront) {
      if (!id) return;
      if (inFront) held.add(id); else held.delete(id);
      setFlag(id, true);
    },
    /* `id` is no longer in front. */
    left(id) { held.delete(id); },
    flush() {
      if (timer) { clearTimer(timer); timer = null; }
      write();
    },
    _at: at,
  };
}

module.exports = { createSeen, SINCE_KEY, SEEN_KEY, UNREAD_KEY, KEEP };
