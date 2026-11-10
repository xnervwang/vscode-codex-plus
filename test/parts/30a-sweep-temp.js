// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A hook writes <file>.<pid>.tmp and renames it over the file (write_atomic in plan_path.py). One that is killed in
 * between leaves the temporary file behind, and the sweep of the plan directory removes it once it is a day old, as it
 * does an abandoned lock.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp }) => {
  const { sweepOrphans, LOCK_STALE_MS } = require('../../src/workplan');
  const dir = tmp('sweep-temp');
  const PLAN = '01a1eeee-0000-7000-8000-000000000005';
  const old = (Date.now() - LOCK_STALE_MS - 60e3) / 1000;
  const put = (name, aged) => { const f = path.join(dir, name); fs.writeFileSync(f, '{}'); if (aged) fs.utimesSync(f, old, old); };
  put(`${PLAN}.json.4242.tmp`, true);
  put(`${PLAN}.turn.77.tmp`, true);
  put(`config.json.9.tmp`, true);
  put(`${PLAN}.json.4343.tmp`, false);
  put('notes.tmp', true);
  put(`${PLAN}.json.x1.tmp`, true);
  fs.mkdirSync(path.join(dir, `${PLAN}.json.5.tmp`));
  fs.utimesSync(path.join(dir, `${PLAN}.json.5.tmp`), old, old);
  fs.mkdirSync(path.join(dir, `${PLAN}.json.lock`));
  fs.utimesSync(path.join(dir, `${PLAN}.json.lock`), old, old);

  sweepOrphans({ dir, live: null });
  eq(fs.readdirSync(dir).sort(), [`${PLAN}.json.4343.tmp`, `${PLAN}.json.5.tmp`, `${PLAN}.json.x1.tmp`, 'notes.tmp'].sort(),
    'a day-old <file>.<pid>.tmp is removed with the abandoned lock, even when the rollouts could not be read; a newer one, '
    + 'a directory and a name of another shape stay');
};
