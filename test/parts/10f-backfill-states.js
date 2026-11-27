// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Whether Codex has filled its state database (src/codex-files.js backfillDone), checked after each step Codex takes
 * to build it: the session list's one import waits for it, so a database read while Codex is still creating it must
 * not count as filled.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ eq, tmp }) => {
  const files = require('../../src/codex-files');
  const { DatabaseSync } = require('node:sqlite');
  const home = tmp('home');
  const states = [];
  const seen = () => states.push(files.backfillDone(home));
  seen();
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('create table threads (id text primary key)');
  seen();
  db.exec('create table backfill_state (id integer primary key, status text not null, last_watermark text, last_success_at integer, updated_at integer)');
  seen();
  db.exec("insert into backfill_state values (1, 'running', null, null, 0)");
  seen();
  db.exec("update backfill_state set status = 'complete'");
  seen();
  db.close();
  eq(states, [false, false, false, false, true],
    'filled only once the backfill_state row says complete');
  fs.rmSync(home, { recursive: true, force: true });
};
