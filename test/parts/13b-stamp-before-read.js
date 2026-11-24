// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A write that lands while the worker reads the thread list. The worker answers "nothing moved" whenever its change
 * stamp is the same as last time (src/codex-worker.js snapshot), so the stamp of the files the list comes from has to
 * be taken before the list is read: taken after, it already covers a write the list missed, and every later read
 * answers "nothing moved" with that list until something else is written. Codex names a new conversation in the same
 * moment its first turn starts, and when nothing else writes for a while, as with a model that has not answered yet,
 * the tab kept the name "Codex".
 *
 * The write is made from inside the list read, after the list has been read; the Codex home has only
 * session_index.jsonl, as in 13-index-stamp.js.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp }) => {
  const { ops } = require('../../src/codex-worker');
  const files = require('../../src/codex-files');
  const home = tmp('home-stamp-before-read');
  const index = path.join(home, 'session_index.jsonl');
  const line = (id, name) => JSON.stringify({ id, thread_name: name, updated_at: new Date().toISOString() }) + '\n';
  fs.writeFileSync(index, line('01a1aa00-0000-7000-8000-000000000b01', 'First'));
  const listThreads = files.listThreads;
  try {
    let late = true;
    files.listThreads = (...a) => {
      const out = listThreads.apply(files, a);
      if (late) { late = false; fs.appendFileSync(index, line('01a1aa00-0000-7000-8000-000000000b02', 'Second')); }
      return out;
    };
    const first = ops.snapshot({ home });
    eq([first.same, first.threads.map((t) => t.title)], [false, ['First']],
      'a read with a write landing after the list was read has the list as it was');
    const next = ops.snapshot({ home, previous: first.stamp });
    eq([next.same, (next.threads || []).map((t) => t.title).sort()], [false, ['First', 'Second']],
      'and the next read has the conversation that write added, rather than answering that nothing moved');
  } finally { files.listThreads = listThreads; files.setCodexHome(''); }
};
