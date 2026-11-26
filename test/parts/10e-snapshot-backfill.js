// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A snapshot says whether Codex had filled its state database from the rollouts (src/codex-worker.js snapshot), and it
 * reads that before the threads. The other way round, a pass that finished between the two reads would make threads not
 * yet marked archived look complete, and the session list's one import would take them as unarchived.
 */
const fixture = require('../fixture');

module.exports = ({ eq, tmp }) => {
  const files = require('../../src/codex-files');
  const worker = require('../../src/codex-worker');
  const home = tmp('home');
  fixture.codexHome(home, [{ title: 'Put away', cwd: home, archived: true, turns: [{}] }]);
  const calls = [];
  const { backfillDone, listThreads } = files;
  files.backfillDone = (...a) => { calls.push('backfill'); return backfillDone(...a); };
  files.listThreads = (...a) => { calls.push('threads'); return listThreads(...a); };
  let snap;
  try { snap = worker.ops.snapshot({ home, previous: '', extra: [] }); } finally { Object.assign(files, { backfillDone, listThreads }); }
  eq([calls.indexOf('backfill') >= 0 && calls.indexOf('backfill') < calls.indexOf('threads'), snap.backfilled, snap.threads.filter((t) => t.archived).length],
    [true, true, 1], 'a snapshot reads whether Codex has filled its database before it reads the threads, and says so beside them');
};
