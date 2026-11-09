// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * build/plan-health.js, the developer's count of stale and incomplete work plan rows.
 *
 * It is checked against a stand-in CODEX_HOME holding one plan per case, since each number it prints depends on a
 * conversation's state, which the plan file alone does not give. The cases are the three ways a `doing` row can
 * stand, with its conversation running a turn, not running one, or its rollout gone so that nothing can be said,
 * plus the one that is easiest to get wrong: a conversation whose rollout says a turn started and then went quiet
 * for hours, which the conversation list calls idle and so must this.
 *
 * There is also a check that the script stays out of the .vsix, since it reads a person's plans and belongs only on
 * a machine this repository is worked on.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fixture = require('../fixture');

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/* A plan file as the hooks write it. */
const plan = (nodes) => JSON.stringify({ nodes });
const row = (state, extra = {}) => ({ title: 't', state, ...extra });

module.exports = async ({ ok, bad, eq, tmp, root }) => {
  const health = require('../../build/plan-health');
  const { DATA_DIR } = require('../../src/plugin-install');
  const files = require('../../src/codex-files');
  const now = Date.now();

  const home = tmp('codex-home');
  /* Four conversations: running a turn; a turn that finished; a turn that started and went quiet for five hours; and
     one that has a plan but whose rollout is never written. */
  const [busy, done, quiet] = fixture.codexHome(home, [
    { title: 'busy', startMs: now - 2 * 60e3, turns: [{ running: true }] },
    { title: 'done', startMs: now - 3 * HOUR, turns: [{}] },
    { title: 'quiet', startMs: now - 5 * HOUR, turns: [{ running: true }] },
  ]);
  const ghost = fixture.threadId();

  const dir = path.join(home, 'plugins', 'data', DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, body, ageMs = 0) => {
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, body);
    if (ageMs) fs.utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
    return file;
  };

  write(busy.id, plan([row('doing', { since: new Date(now - 2 * HOUR).toISOString() })]));
  write(done.id, plan([
    row('doing', { since: new Date(now - 3 * DAY).toISOString() }),
    row('waiting', { waitingOn: 'build' }),
    row('waiting'),
    row('waiting', { waitingOn: 'user', question: 'Do we drop it, or keep it behind a setting?' }),
    row('todo', { children: [
      row('doing', { since: new Date(now - 9 * DAY).toISOString() }),
      row('waiting', { waitingOn: 'user', question: 'Which one? And when?' }),
    ] }),
  ]));
  write(quiet.id, plan([row('doing', { since: new Date(now - 40 * HOUR).toISOString() })]));
  write(ghost, plan([row('doing', { since: new Date(now - 2 * HOUR).toISOString() })]));
  /* Past the window, so none of its rows are counted. */
  write(fixture.threadId(), plan([row('doing'), row('waiting')]), 30 * DAY);
  /* The hooks' own files live in the same directory and are not plans. */
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ enabled: true, question: 'is this counted??' }));
  fs.writeFileSync(path.join(dir, 'client-time-zone.json'), JSON.stringify({ timeZone: 'Europe/Berlin' }));

  const r = health.measure({ now, home, days: 14 });
  eq([r.plans, r.rows], [4, 10], 'only the plans written to inside the window are read, and every row in them is counted');
  eq([r.doing, r.doingWorking, r.doingIdle, r.doingUnknown],
    [5, 1, 3, 1], 'a doing row is put against its conversation: one running a turn, three not, one that cannot be judged');
  eq([r.doingIdleOverDay, r.doingIdleOverWeek, r.plansWithoutRollout],
    [3, 1, 1], 'the idle ones are aged from `since`, and the plan with no rollout is named rather than counted as idle');
  /* The three idle rows are 40, 72 and 216 hours old, so the middle one is 72. */
  eq(r.doingIdleMedianHours, 72, 'the median age of an idle doing row is in hours, to one decimal');
  eq([r.waiting, r.waitingNoWho], [4, 1], 'waiting rows are counted, and so are the ones not saying who they wait on');
  eq([r.userQuestions, r.multiQuestion], [2, 1],
    'and a question put to the user counts once, with the ones carrying more than one question mark counted apart');
  eq(r.home, home, 'the measurement says which CODEX_HOME it read');

  /*
   * The quiet conversation is the case where the plan and the rollout disagree about what is happening.
   *
   * An empty thread list is passed on purpose: that is what a Node without node:sqlite leaves, and it sends rolloutOf
   * down its other path, walking CODEX_HOME for the rollout instead of reading its recorded location. So these four
   * answers are also the only check that that path finds the same files.
   */
  eq([health.turnState(busy.id, home, [], now), health.turnState(done.id, home, [], now),
    health.turnState(quiet.id, home, [], now), health.turnState(ghost, home, [], now)],
  ['working', 'idle', 'idle', 'unknown'],
  'a turn that started and then went quiet past the cutoff counts as idle, the same way the conversation list reads it');

  const text = health.report(r).join('\n');
  eq([/plans written to in the last 14 days: 4 \(10 rows\)/.test(text), /doing rows: 5/.test(text),
    /more than a week: 1/.test(text), /with more than one question mark: 1/.test(text),
    /could not be judged: 1/.test(text)],
  [true, true, true, true, true], 'the printed report carries each of those counts');
  const empty = health.report(health.measure({ now, home: tmp('empty-home'), days: 14 }));
  eq([empty.join('\n').includes('plans written to in the last 14 days: 0'), /median/.test(empty.join('\n'))],
    [true, false], 'with nothing to measure it says so, and prints no median over an empty set');

  /* Run as a program, the way it is meant to be used. */
  const out = execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings',
    path.join(root, 'build', 'plan-health.js'), '--home', home, '--days', '14', '--json'], { encoding: 'utf8' });
  const asProgram = JSON.parse(out);
  eq([asProgram.days, asProgram.plans, asProgram.doing, asProgram.home], [14, 4, 5, home],
    'and run from the command line with --home, --days and --json it reports the same thing');

  /* Not in the package: build/ is both outside what pack.sh copies and named in .vscodeignore. */
  const packed = fs.readFileSync(path.join(root, 'build', 'pack.sh'), 'utf8');
  const copied = (/^cp -r ([^\n]*) "\$stage\/extension\/"$/m.exec(packed) || [])[1] || '';
  eq([copied.includes('build'), /^build\/\*\*$/m.test(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'))],
    [false, true], 'pack.sh copies no build/ directory into the package, and .vscodeignore excludes it too');

  files.setCodexHome('');
};
