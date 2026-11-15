// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The thread list is read from the state database once for as long as nothing has been committed to it, by this
 * process or another: the snapshot's poll, the user's message times and the scan for work left running all get the
 * list the last query returned, and a commit anywhere makes the next call query again. The database is in WAL mode, as
 * Codex keeps it.
 */
const cp = require('child_process');
const path = require('path');
const fixture = require('../fixture');

module.exports = ({ ok, bad, eq, note, tmp }) => {
  let lib;
  try { lib = require('node:sqlite'); } catch (_) { lib = null; }
  if (!lib || !lib.DatabaseSync) { note('no node:sqlite here, so the thread list is queried every time and nothing is kept'); return; }
  const files = require('../../src/codex-files');
  const worker = require('../../src/codex-worker');
  const home = tmp('home');
  const now = Date.now();
  const made = fixture.codexHome(home, [{ title: 'First', startMs: now - 600e3, turns: [{}] }, { title: 'Second', startMs: now - 500e3, turns: [{}] }]);
  const dbFile = path.join(home, 'state_5.sqlite');
  const writer = new lib.DatabaseSync(dbFile);
  writer.exec('pragma journal_mode = wal');

  /* The queries of the threads table run while fn() does. */
  const queried = (fn) => {
    const seen = [];
    const prepare = lib.DatabaseSync.prototype.prepare;
    lib.DatabaseSync.prototype.prepare = function (sql) { if (/\bfrom threads\b/.test(sql)) seen.push(sql); return prepare.call(this, sql); };
    try { return { out: fn(), n: seen.length }; } finally { lib.DatabaseSync.prototype.prepare = prepare; }
  };
  const freshList = () => { files.setCodexHome(home); return files.listThreads(home); };
  try {
    files.setCodexHome(home);
    const first = files.listThreads(home);
    const second = queried(() => files.listThreads(home));
    eq([second.n, second.out], [0, first], 'with nothing committed since, the list is not queried again and is the same');
    second.out[0].title = 'changed by a caller';
    eq(files.listThreads(home)[0].title, first[0].title, 'each call gets copies, so a caller that changes one changes nothing kept');

    writer.prepare('update threads set title = ? where id = ?').run('Renamed here', made[0].id);
    const here = queried(() => files.listThreads(home));
    eq([here.n > 0, here.out.find((t) => t.id === made[0].id).title], [true, 'Renamed here'],
      'a commit through another connection makes the next call query again and see it');
    const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(dbFile)});
      db.prepare('update threads set title = ? where id = ?').run('Renamed elsewhere', ${JSON.stringify(made[1].id)}); db.close();`;
    cp.execFileSync(process.execPath, [...process.execArgv, '-e', script], { stdio: 'ignore' });
    const there = files.listThreads(home);
    eq(there.find((t) => t.id === made[1].id).title, 'Renamed elsewhere', 'and so does a commit from another process');
    eq(there, freshList(), 'what it gives is what a new connection reads');

    worker.ops.snapshot({ home, previous: '', extra: [] });
    const times = queried(() => worker.ops.userTimes({ home, id: made[0].id }));
    const left = queried(() => worker.ops.leftRunning({ home, proc: path.join(home, 'no-proc'), sessionsDir: path.join(home, 'no-sessions') }));
    eq([times.n, left.n], [0, 0], 'after a snapshot, the user\'s message times and the scan for work left running query no thread list');
    files.setCodexHome('');
    files.setCodexHome(home);
    eq([times.out, left.out], [worker.ops.userTimes({ home, id: made[0].id }), worker.ops.leftRunning({ home, proc: path.join(home, 'no-proc'),
      sessionsDir: path.join(home, 'no-sessions') })], 'and they give what they give over a new connection');
  } catch (e) { bad(`the thread list kept between queries: ${(e && e.stack) || e}`); } finally {
    writer.close();
    files.setCodexHome('');
  }
  ok('the thread list kept between queries is checked');
};
