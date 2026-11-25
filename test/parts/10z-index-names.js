// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The title of a thread whose database row has no `name` (listThreads and indexNames in src/codex-files.js). Codex
 * writes the title it generates, and a name the user gives, to both the row's `name` and session_index.jsonl; a row
 * has been seen without its `name` while the index kept it, and the tab then showed the first message instead. The
 * index's name fills an empty `name`; a `name` in the row still wins.
 */
const fs = require('fs');
const path = require('path');
const fixture = require('../fixture');

module.exports = ({ eq, note, tmp }) => {
  let lib;
  try { lib = require('node:sqlite'); } catch (_) { lib = null; }
  if (!lib || !lib.DatabaseSync) { note('no node:sqlite here to write the rows with'); return; }
  const files = require('../../src/codex-files');
  const home = tmp('home-index-names');
  const now = Date.now();
  const made = fixture.codexHome(home, [{ title: 'Can you look at the notes on drive D?', startMs: now - 600e3, turns: [{}] },
    { title: 'Run the tests again', startMs: now - 500e3, turns: [{}] }]);
  const db = new lib.DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('pragma journal_mode = wal');
  db.prepare('update threads set name = null where id = ?').run(made[0].id);
  db.prepare('update threads set name = ? where id = ?').run('Tests on the release branch', made[1].id);
  const index = path.join(home, 'session_index.jsonl');
  const line = (id, name) => JSON.stringify({ id, thread_name: name, updated_at: new Date().toISOString() }) + '\n';
  fs.writeFileSync(index, line(made[0].id, 'Notes on drive D') + line(made[1].id, 'An older name'));
  const titles = () => { const l = files.listThreads(home) || []; return made.map((m) => (l.find((t) => t.id === m.id) || {}).title); };
  try {
    files.setCodexHome(home);
    eq(titles(), ['Notes on drive D', 'Tests on the release branch'],
      'a row with no name takes the name session_index.jsonl gives it, and a row with a name keeps its own');
    fs.appendFileSync(index, line(made[0].id, 'Notes on drive D, read'));
    eq(titles()[0], 'Notes on drive D, read', 'a new line in the index is read at the next call, with nothing committed to the database');
    fs.unlinkSync(index);
    eq(titles()[0], 'Can you look at the notes on drive D?', 'with no index, a row with no name is titled from its other columns as before');
  } finally { db.close(); files.setCodexHome(''); }
};
