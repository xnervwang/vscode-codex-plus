// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Prints how many work plan rows on this machine are stale or incomplete, over the plans written in the last N days
 * (14 by default).
 *
 *   node build/plan-health.js [--days N] [--home <CODEX_HOME>] [--json]
 *
 * Run it before and after a change with the same --days. It counts, in the plans under
 * <CODEX_HOME>/plugins/data/agent-work-plan-codex-extras:
 *
 *   - `doing` rows in a conversation that is not running a turn right now, and how long they have said `doing`;
 *   - `waiting` rows that do not say who they wait on;
 *   - questions with more than one question mark.
 *
 * It is not part of the extension. It lives in build/, which build/pack.sh does not copy, so it stays out of the
 * .vsix.
 *
 * Whether a conversation is running a turn comes from Codex's own rollout, through src/codex-files.js and the same
 * two-hour cutoff the conversation list uses (STALE_WORKING_MS), rather than from a second copy of that rule: the
 * numbers printed here get compared against what the list shows, and a script with its own idea of "working" would
 * disagree with the list for reasons that have nothing to do with the plans.
 *
 * The claude-code-extras counterpart has to ask a 241 MB binary (`claude agents --json`) and leaves these counts out
 * when it is not there. Codex writes the same fact to a file, so the only conversation that cannot be judged here is
 * one whose rollout has been deleted, or compressed by a Codex older than this Node's zstd. Those are counted on
 * their own line rather than assumed idle.
 */
const fs = require('fs');
const path = require('path');
const files = require('../src/codex-files');
const { STALE_WORKING_MS } = require('../src/codex-source');
const { DATA_DIR } = require('../src/plugin-install');

const DEFAULT_DAYS = 14;
const QUESTION_MARKS = /[?？]/g;
const hours = (iso, now) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (now - t) / 3600e3 : null; };
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/* 'working', 'idle', or 'unknown' when the thread's rollout cannot be read at all. */
function turnState(session, home, threads, now) {
  const rollout = files.existingRollout(files.rolloutOf(session, home, threads));
  if (!rollout) return 'unknown';
  const st = files.rolloutState(rollout);
  if (!st || !st.lastActivityMs) return 'unknown';
  return st.working && now - st.lastActivityMs < STALE_WORKING_MS ? 'working' : 'idle';
}

function measure({ now = Date.now(), home = '', days = DEFAULT_DAYS } = {}) {
  const DAYS = Number(days) || DEFAULT_DAYS;
  if (home) files.setCodexHome(home);
  const root = files.codexHome();
  const dir = path.join(root, 'plugins', 'data', DATA_DIR);
  /* One query for every thread, rather than one directory walk per plan: rolloutOf falls back to walking
     <CODEX_HOME>/sessions when the list cannot be read, and that walk is the expensive part. */
  const threads = files.listThreads(root) || [];
  const out = { days: DAYS, home: root, plans: 0, rows: 0, doing: 0, doingWorking: 0, doingIdle: 0, doingUnknown: 0,
    doingIdleHours: [], waiting: 0, waitingNoWho: 0, userQuestions: 0, multiQuestion: 0, plansWithoutRollout: 0 };
  let names = [];
  /* Thread-id names only, which is also what leaves the hooks' own config.json and client-time-zone.json out. */
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && files.THREAD_ID.test(n.slice(0, -5))); } catch (_) { /* no plans */ }
  for (const name of names) {
    const file = path.join(dir, name);
    let plan;
    try {
      if (now - fs.statSync(file).mtimeMs > DAYS * 86400e3) continue;
      plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { continue; }
    out.plans++;
    const session = name.slice(0, -5);
    let running = null;
    const walk = (nodes) => {
      for (const n of Array.isArray(nodes) ? nodes : []) {
        if (!n || typeof n !== 'object') continue;
        out.rows++;
        if (n.state === 'doing') {
          out.doing++;
          // Asked for only once a plan turns out to have a `doing` row, and only once per plan: reading a rollout's
          // tail is the one costly step here, and most plans have no such row.
          if (running === null) {
            running = turnState(session, root, threads, now);
            if (running === 'unknown') out.plansWithoutRollout++;
          }
          if (running === 'working') out.doingWorking++;
          else if (running === 'unknown') out.doingUnknown++;
          else {
            out.doingIdle++;
            const h = hours(n.since, now);
            if (h !== null) out.doingIdleHours.push(h);
          }
        }
        if (n.state === 'waiting') {
          out.waiting++;
          if (!n.waitingOn) out.waitingNoWho++;
        }
        if (n.waitingOn === 'user' && typeof n.question === 'string' && n.question) {
          out.userQuestions++;
          if ((n.question.match(QUESTION_MARKS) || []).length > 1) out.multiQuestion++;
        }
        walk(n.children);
      }
    };
    walk(plan.nodes);
  }
  const h = out.doingIdleHours;
  out.doingIdleMedianHours = h.length ? Math.round(median(h) * 10) / 10 : null;
  out.doingIdleOverDay = h.filter((x) => x > 24).length;
  out.doingIdleOverWeek = h.filter((x) => x > 168).length;
  delete out.doingIdleHours;
  return out;
}

function report(r) {
  const lines = [`plans written to in the last ${r.days} days: ${r.plans} (${r.rows} rows) under ${r.home}`,
    `doing rows: ${r.doing}, of them in a conversation not running a turn now: ${r.doingIdle}`
    + ` (running a turn: ${r.doingWorking})`];
  /* The ages only exist for rows counted as idle; with none, a line of zeros and a null median reads as a measurement
     rather than as the absence of one. */
  if (r.doingIdle) {
    lines.push(`  of those, doing for more than a day: ${r.doingIdleOverDay}, more than a week: ${r.doingIdleOverWeek},`
      + ` median ${r.doingIdleMedianHours} hours`);
  }
  lines.push(`waiting rows: ${r.waiting}, not saying who they wait on: ${r.waitingNoWho}`,
    `rows waiting on the user with a question: ${r.userQuestions}, with more than one question mark: ${r.multiQuestion}`);
  if (r.doingUnknown) {
    lines.push(`doing rows whose conversation could not be judged: ${r.doingUnknown}`
      + ` (in ${r.plansWithoutRollout} plan(s) with no readable rollout)`);
  }
  return lines;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const r = measure({ home: String(opt('--home', '')).trim(), days: Number(opt('--days', String(DEFAULT_DAYS))) });
  console.log(args.includes('--json') ? JSON.stringify(r) : report(r).join('\n'));
}

module.exports = { measure, report, turnState, DEFAULT_DAYS };
