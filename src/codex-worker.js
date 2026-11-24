// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Everything that reads Codex's files, run in a worker thread so that a slow SQLite read, a sqlite3 child process or a
 * rollout being decompressed never holds up the extension host's own thread, which every other extension and every
 * window of this host shares. src/codex-reader.js starts it and keeps what it returns.
 *
 * Each operation takes the Codex home explicitly. `ops` is exported so the reader can run the same code in its own
 * thread when a worker cannot be started.
 */
const fs = require('fs');
const path = require('path');
const files = require('./codex-files');
const install = require('./plugin-install');

/* Only threads touched this recently have their rollout's end read: a turn silent for longer is not running anyway
   (STALE_WORKING_MS in src/codex-source.js), and a list of every thread a person ever had would read thousands. */
const STATE_WINDOW_MS = 2 * 24 * 3600e3;
const STAMP_WINDOW_MS = 24 * 3600e3;
/* Sub-agents updated this recently are read as well, so that their conversation can show one of them still running.
   A turn silent for longer does not count as running anyway (STALE_WORKING_MS in src/codex-source.js is also two
   hours). */
const SUBAGENT_WINDOW_MS = 2 * 3600e3;
/* How far src/left-running.js has read each rollout for claude --bg launches, and what it found, kept between scans;
   and the launcher id each process's environ named. */
const launchCache = new Map();
const environs = new Map();
/* The state of each rollout a snapshot read, kept while the file is unchanged (src/codex-files.js cachedRolloutState). */
const states = new Map();
/* When each plan last asked the user something, kept while its file is the same one, of the same size and time. */
const asks = new Map();

let home = '';
function at(h) {
  if (h && h !== home) { home = h; files.setCodexHome(h); }
  return files.codexHome();
}

/* Cheap: the state database's and its write-ahead log's sizes and times, session_index.jsonl's, which is the whole list
   when the database cannot be read and whose threads name no rollout, and the size of every rollout touched in the
   last day. Only when that moves is the rest read again. */
function stampOf(dir, threads) {
  const db = files.stateDbPath(dir), goals = files.goalsDbPath(dir);
  const parts = [];
  for (const f of [db, db && db + '-wal', path.join(dir, 'session_index.jsonl'), goals, goals && goals + '-wal']) {
    try { const s = fs.statSync(f); parts.push(s.size, s.mtimeMs); } catch (_) { parts.push(0); }
  }
  try { const s = fs.statSync(install.planDir(dir)); parts.push(s.mtimeMs); } catch (_) { parts.push(0); }
  const day = Date.now() - STAMP_WINDOW_MS, subs = Date.now() - SUBAGENT_WINDOW_MS;
  for (const t of threads || []) {
    if (!t.rollout || !(t.kind === 'user' ? t.updatedMs >= day : t.kind === 'subagent' && t.updatedMs >= subs)) continue;
    try { const s = fs.statSync(files.existingRollout(t.rollout) || t.rollout); parts.push(t.id.slice(-6), s.size); } catch (_) { /* gone */ }
    /* A plan rewritten in place leaves its folder's time alone. */
    if (t.kind === 'user') { try { parts.push(fs.statSync(path.join(install.planDir(dir), `${t.id}.json`)).mtimeMs); } catch (_) { /* no plan */ } }
  }
  return parts.join(',');
}

/* [id, ms] of each of `ids` whose plan asks the user something (src/workplan.js latestQuestionAt). Only conversations
   whose rollout was read are looked up: without its last user message a question is not taken to be new anyway. */
function askedOf(dir, ids) {
  const out = [];
  for (const id of ids) {
    const file = path.join(install.planDir(dir), `${id}.json`);
    let s;
    try { s = fs.statSync(file); } catch (_) { asks.delete(file); continue; }
    const key = `${s.ino}.${s.size}.${s.mtimeMs}`;
    let had = asks.get(file);
    if (!had || had.key !== key) { had = { key, at: require('./workplan').latestQuestionAt(file) }; asks.set(file, had); }
    if (had.at) out.push([id, had.at]);
  }
  return out;
}

/* The recent conversations and sub-agents with their rollouts. A rollout that exists only compressed (.zst) is given
   as '' and is not read. */
function recentRollouts(dir) {
  const since = Date.now() - STATE_WINDOW_MS;
  return (files.listThreads(dir) || []).filter((t) => (t.kind === 'user' || t.kind === 'subagent') && t.updatedMs >= since && t.rollout)
    .map((t) => { const real = files.existingRollout(t.rollout); return { id: t.id, rollout: real && !real.endsWith('.zst') ? real : '' }; });
}

const ops = {
  /*
   * What the extension shows of Codex: { stamp, same } when nothing moved since `previous`, otherwise every thread with
   * `present` (its rollout exists), the unread and section tables, the rollout state of the recent and the `extra`
   * threads, and which threads have a plan file.
   */
  snapshot({ home: h, previous = '', extra = [] }) {
    const dir = at(h);
    const threads = files.listThreads(dir);
    const stamp = stampOf(dir, threads);
    if (previous && stamp === previous) return { stamp, same: true };
    const want = new Set(Array.isArray(extra) ? extra : []);
    const since = Date.now() - STATE_WINDOW_MS, subs = Date.now() - SUBAGENT_WINDOW_MS;
    const found = {};
    for (const t of threads || []) {
      t.present = !t.rollout || !!files.existingRollout(t.rollout);
      /* An older sub-agent's state only when asked for: the extension asks for those of the conversations open in a
         window. */
      if (t.rollout && t.present && (want.has(t.id) || (t.kind === 'user' && t.updatedMs >= since)
        || (t.kind === 'subagent' && t.updatedMs >= subs))) {
        try { found[t.id] = files.cachedRolloutState(t.rollout, states); } catch (_) { /* left out */ }
      }
    }
    let plans = [];
    try { plans = fs.readdirSync(install.planDir(dir)).filter((n) => /\.json$/.test(n) && files.THREAD_ID.test(n.slice(0, -5))).map((n) => n.slice(0, -5)); } catch (_) { plans = []; }
    /* The wake-ups are in the plans' folder, whose time is in the stamp, so they are read only when it moved. */
    let wakeups = [];
    try { wakeups = require('./wakeup').planned(install.planDir(dir)); } catch (_) { wakeups = []; }
    return {
      stamp, same: false, readable: !!threads, threads: threads || [],
      unread: [...files.unreadThreads(dir)], sections: [...files.sections(dir)], goals: [...files.goals(dir)], states: found, plans, wakeups,
      asks: askedOf(dir, plans.filter((id) => found[id])),
    };
  },
  /* The rows of Session Information for one thread. A worker thread shares the extension host's process id, which is
     what the app-server lookup needs. */
  info({ home: h, id }) {
    at(h);
    return require('./session-info').rows(id);
  },
  /* The work plan line for one thread, shown on the context meter's hover. */
  plan({ home: h, id }) {
    at(h);
    return require('./session-info').planText(id);
  },
  /* Whether a thread still has a rollout, searching sessions/ when the database does not know it. */
  rolloutExists({ home: h, id }) {
    return !!files.rolloutOf(id, at(h));
  },
  /* When the user's own messages of one conversation were sent, for the stamps its page draws on them. A whole rollout
     is read the first time and only its new bytes after that (src/user-times.js), which is why this is in here. */
  userTimes({ home: h, id }) {
    const rollout = files.rolloutOf(id, at(h));
    const r = rollout ? require('./user-times').rolloutMarks(rollout) : null;
    return { times: r ? r.times : null, compactions: r ? r.compactions : [], turns: r ? r.turns : {}, turnTimes: r ? r.turnTimes : {} };
  },
  /* What the recent conversations and sub-agents still have running after their turn ended (src/left-running.js).
     `share` is the folder the windows share a scan through, '' for none. */
  leftRunning({ home: h, proc = '/proc', sessionsDir, share = '' }) {
    const threads = recentRollouts(at(h));
    return require('./left-running').leftRunning({ threads, proc, sessionsDir, cache: launchCache, environs, share });
  },
  /* Writes down in `dir` what changed in the claude --bg sessions those conversations launched, for
     src/detached-ends.js to send. */
  bgEnds({ home: h, dir, proc = '/proc', sessionsDir, jobsDir, claim = true }) {
    const threads = recentRollouts(at(h));
    return require('./bg-ends').update({ dir, threads, cache: launchCache, proc, claim,
      ...(sessionsDir ? { sessions: sessionsDir } : {}), ...(jobsDir ? { jobs: jobsDir } : {}) });
  },
  /* Plans of conversations that are gone (src/workplan.js). */
  sweep({ home: h }) {
    const dir = at(h);
    const r = require('./workplan').sweepOrphans({ home: dir, dir: install.planDir(dir) });
    return { deleted: r.deleted, kept: r.kept, why: r.why };
  },
};

let parent = null;
try { const wt = require('worker_threads'); if (!wt.isMainThread) parent = wt.parentPort; } catch (_) { parent = null; }
if (parent) {
  parent.on('message', (m) => {
    const fn = m && ops[m.op];
    let reply;
    try { reply = fn ? { id: m.id, result: fn(m.args || {}) } : { id: m && m.id, error: `no operation ${m && m.op}` }; }
    catch (e) { reply = { id: m.id, error: String((e && e.message) || e) }; }
    parent.postMessage(reply);
  });
}

module.exports = { ops, stampOf, STATE_WINDOW_MS, SUBAGENT_WINDOW_MS };
