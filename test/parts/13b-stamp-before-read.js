// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A write that lands while the worker reads the thread list. The worker answers "nothing moved" when its change stamp
 * equals the previous one (src/codex-worker.js snapshot), so it has to stat the database and index files before it
 * reads the list. If it stats them after, the stamp already includes a write the list missed, and every later read
 * keeps that list. Codex writes a new conversation's name as its first turn starts. Until
 * the model replies nothing else is written, and the tab kept the name "Codex".
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
