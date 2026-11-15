// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which state and goals database is the newest is read from the Codex home's listing again only once the home has had a
 * file added, removed or renamed, which moves its change time. The times stat gives for the home are pinned, relative to
 * the clock now, so the test does not rest on clock ticks or wait for one.
 */
const fs = require('fs');
const path = require('path');
const files = require('../../src/codex-files');

module.exports = ({ ok, bad, eq, tmp }) => {
  const home = tmp('home');
  for (const n of ['state_4.sqlite', 'state_5.sqlite', 'goals_1.sqlite', 'logs_2.sqlite']) fs.writeFileSync(path.join(home, n), '');
  let times = null;
  const watched = (fn) => {
    let listed = 0;
    const { statSync, readdirSync } = fs;
    fs.statSync = function (p, ...a) { const s = statSync.call(this, p, ...a); return String(p) === home && times ? { ...s, ...times } : s; };
    fs.readdirSync = function (p, ...a) { if (String(p) === home) listed++; return readdirSync.call(this, p, ...a); };
    try { return { out: fn(), listed }; } finally { Object.assign(fs, { statSync, readdirSync }); }
  };
  const both = () => [path.basename(files.stateDbPath(home)), path.basename(files.goalsDbPath(home))];
  try {
    const settled = Date.now() - 60e3;
    times = { mtimeMs: settled, ctimeMs: settled };
    eq(watched(both).out, ['state_5.sqlite', 'goals_1.sqlite'], 'the highest generation of each database is found');
    eq(watched(both), { out: ['state_5.sqlite', 'goals_1.sqlite'], listed: 0 }, 'and asked again with the home unchanged, the home is not listed');

    fs.writeFileSync(path.join(home, 'state_6.sqlite'), '');
    times = { mtimeMs: settled + 1, ctimeMs: settled + 1 };
    const moved = watched(both);
    eq([moved.out, moved.listed], [['state_6.sqlite', 'goals_1.sqlite'], 2], 'a database added since is found, the home being listed again');

    fs.renameSync(path.join(home, 'state_6.sqlite'), path.join(home, 'state_6.sqlite-old'));
    times = { mtimeMs: settled + 1, ctimeMs: settled + 2 };
    eq(watched(both).out, ['state_5.sqlite', 'goals_1.sqlite'], 'one renamed away is no longer taken, the change time alone having moved');

    const young = Date.now() + 60e3;
    times = { mtimeMs: young, ctimeMs: young };
    watched(both);
    eq(watched(both).listed, 2, 'a home whose change time is less than SETTLED_MS old is listed again every time');
    times = null;
    eq(files.stateDbPath(path.join(home, 'missing')), '', 'a home that is not there has no database');
  } catch (e) { bad(`the newest database kept: ${(e && e.stack) || e}`); }
  ok('the newest database kept between calls is checked');
};
