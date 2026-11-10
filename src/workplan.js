// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan: what each conversation still has to do, read from a file the conversation itself maintains.
 *
 * One file per conversation, in the data directory Codex gives the companion plugin:
 *
 *   $CODEX_HOME/plugins/data/agent-work-plan-codex-extras/<thread id>.json
 *
 * That location is not a choice of ours - it is what a plugin is given. A thread id is unique across every project on a
 * machine, so it is the whole name and no grouping directory is needed.
 *
 * The plugin's hooks write those files and Agent Plus reads and draws them; this file only deletes the ones whose
 * conversation is gone. The shape below is the whole contract between the plugin and Agent Plus:
 *
 *   { "title": "optional name for this conversation",
 *     "nodes": [ { "title": "...", "state": "discussing|todo|doing|waiting|parked|done|dropped",
 *                  "note": "optional, read in the dialog and the hover rather than on the row",
 *                  "detail": "optional, several lines; what the row cannot say in its width",
 *                  "opened": "optional ISO 8601; when this row was added",
 *                  "since": "optional ISO 8601; when it entered the state it is in",
 *                  "closed": "optional ISO 8601; when it reached done or dropped",
 *                  "waitingOn": "optional, on a waiting or discussing row: user|build|someone|session|other",
 *                  "question": "optional, with waitingOn user: the one question the user has to answer",
 *                  "asked": "optional ISO 8601; when that question was put",
 *                  "children": [ ... ] } ] }
 *
 * A child is something that has to be finished before its parent can be, whether that was planned or discovered on the
 * way. Nesting means exactly that and nothing else - not the order topics came up in.
 */
const fs = require('fs');
const path = require('path');
const files = require('./codex-files');
const install = require('./plugin-install');

const DATA_ROOT = () => path.join(files.codexHome(), 'plugins', 'data');
const PLAN_DIR = install.DATA_DIR;
const planDir = () => install.planDir(files.codexHome());

/*
 * Every thread id that still has a rollout, or null when that could not be established. Null rather than a partial set:
 * an unreadable state database would make every conversation look gone, and their plans would be deleted.
 *
 * A thread with no rollout path means the list came from session_index.jsonl, which listThreads falls back to when
 * the database cannot be read. That index holds only the conversations that have a name, so it is no list of the
 * living either.
 */
function liveSessions(home = files.codexHome()) {
  const threads = files.listThreads(home);
  if (!threads || !threads.length) return null;
  if (threads.some((t) => !t.rollout)) return null;
  const live = new Set();
  for (const t of threads) if (files.existingRollout(t.rollout)) live.add(t.id);
  return live.size ? live : null;
}

/*
 * Per-conversation files in the plan directory, deleted with their conversation: each is named by session id plus one
 * of these suffixes, and other files there are left alone.
 *
 *   .json        the plan itself
 *   .offered     the Stop hook offered once to start a plan where none existed; otherwise the only trace of a
 *                conversation that declined would accumulate for ever
 *   .nudged      the Stop hook has reminded the conversation to reconcile its plan, so it does not say it again
 *   .settled     which `doing` rows the Stop hook last asked to move on, so it does not ask about them again
 *   .turn        which turn the conversation is in and how far it has got, left by the injection hook
 *   .watermark   which context marks have asked it to bring the plan up to date before a compaction
 *   .tz          what the time-zone hook last told it
 *   .wakeup      the conversation's wake-up, set by the MCP tool set_wakeup (src/wakeup.js)
 *   .woke        when this extension last queued that wake-up, and whether it is paused
 */
const SIDE_SUFFIXES = ['.json', '.offered', '.nudged', '.settled', '.turn', '.watermark', '.tz', '.wakeup', '.woke'];
const SIDE_FILE = new RegExp('^[0-9a-f][0-9a-f-]{7,}(?:' + SIDE_SUFFIXES.map((s) => s.replace('.', '\\.')).join('|') + ')$', 'i');
const PLAN_FILE = /^[0-9a-f][0-9a-f-]{7,}\.json$/i;
/* Plan lock directories (<plan>.lock), made with mkdir around a read-change-write. Writers give up on one older than
   ten seconds (LOCK_STALE in plan_path.py), so the sweep can remove any older than LOCK_STALE_MS, a day. */
const LOCK = /\.lock$/i;
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;
/* A hook writes <plan>.<pid>.tmp and renames it over the plan (plan_path.py). One a day old belongs to a hook that was
   killed in between. */
const TEMP = /\.\d+\.tmp$/i;
/* The same list as STATES in the plugin's plan_path.py, in the same order; test/check.js holds them together. */
const STATES = ['discussing', 'todo', 'doing', 'waiting', 'parked', 'done', 'dropped'];
/* Who a held-up row waits on: the same list as WAITING_ON in plan_path.py, held together by test/check.js. */
const WAITING_ON = ['user', 'build', 'someone', 'session', 'other'];
const MAX_QUESTION_CHARS = 200;
/* The longest description a row may have: the same numbers as MAX_DETAIL_LINES and MAX_DETAIL_CHARS in plan_path.py. */
const MAX_DETAIL_LINES = 12;
const MAX_DETAIL_CHARS = 900;

/* A plan younger than this is left alone whatever the rollouts say. Its real job is not to wait longer - a rollout
   survives months of silence - but to be certain that nothing still being written is ever
   touched, whatever went wrong with the reading of the rollouts. */
const SETTLED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete the plans of conversations that no longer exist. Returns a summary for the log and `live`, the conversations
 * that still have a rollout, which is null when that is unknown and nothing was deleted.
 *
 * A conversation whose rollout is gone can never be resumed, so its plan is a file nothing can reach: not Agent Plus,
 * which reads only the conversation in front of the user, and not Codex. Left alone they only accumulate - at the
 * rate this machine starts conversations, thousands within a year.
 *
 * It deletes rather than moving them aside. An archive was the first shape of this and it was the wrong one: it has no
 * bound, so the files it saves from deletion are the same files somebody has to deal with later.
 */
function sweepOrphans(opts = {}) {
  const now = opts.now || Date.now();
  const dir = opts.dir || planDir();
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { names = null; }
  /* Abandoned locks are removed regardless of the rollouts, since each one delays every writer of that plan until it
     times out. rmdir only removes an empty directory. */
  for (const name of names || []) {
    const lock = LOCK.test(name), temp = !lock && TEMP.test(name);
    if (!lock && !temp) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (now - st.mtimeMs <= LOCK_STALE_MS) continue;
      if (lock && st.isDirectory()) fs.rmdirSync(file);
      else if (temp && st.isFile()) fs.unlinkSync(file);
    } catch (_) { /* released meanwhile, or not empty */ }
  }
  const live = opts.live !== undefined ? opts.live : liveSessions(opts.home);
  if (!live) return { deleted: 0, kept: 0, live: null, why: 'the rollouts could not all be read, so nothing was treated as abandoned' };
  if (!names) return { deleted: 0, kept: 0, live, why: '' };
  let deleted = 0, kept = 0;
  for (const name of names) {
    if (!SIDE_FILE.test(name)) continue;
    // The session id is the name without its last extension, whichever of the side files it is.
    if (live.has(name.replace(/\.[^.]+$/, ''))) { kept++; continue; }
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (now - st.mtimeMs < SETTLED_MS) { kept++; continue; }
    /* The last word before a delete is the folders themselves: a rollout the database has lost track of, or one moved
       by archiving, still means the conversation can be resumed. */
    if (files.rolloutExists(name.replace(/\.[^.]+$/, ''), opts.home || files.codexHome())) { kept++; continue; }
    // Already gone means another window got here first, which is the ordinary outcome of two of them starting on one
    // day rather than a fault: several extension hosts share this directory and nothing locks it.
    try { fs.unlinkSync(file); deleted++; }
    catch (e) { if (e.code !== 'ENOENT') kept++; }
  }
  return { deleted, kept, live, why: '' };
}

/** The states that mean a row still needs something done to it. */
const OPEN_STATES = ['discussing', 'todo', 'doing', 'waiting', 'parked'];

module.exports = {
  planDir, liveSessions, sweepOrphans,
  DATA_ROOT, PLAN_DIR, PLAN_FILE, SIDE_SUFFIXES, SETTLED_MS, LOCK_STALE_MS, OPEN_STATES,
  STATES, MAX_DETAIL_LINES, MAX_DETAIL_CHARS, WAITING_ON, MAX_QUESTION_CHARS,
};
