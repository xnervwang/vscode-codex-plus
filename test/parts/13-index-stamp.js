// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The thread list read from session_index.jsonl, which src/codex-files.js listThreads falls back to when Codex's state
 * database cannot be read by either means. The worker answers "nothing moved" whenever its change stamp is the same
 * (src/codex-worker.js stampOf), and a list from the index has no rollout paths for that stamp to look at, so the index
 * file itself has to be in it.
 *
 * The index is one JSON object per line with id, thread_name and updated_at, as Codex writes it; this Codex home has no
 * state database at all.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp }) => {
  const { ops } = require('../../src/codex-worker');
  const files = require('../../src/codex-files');
  const home = tmp('home-index-only');
  const index = path.join(home, 'session_index.jsonl');
  const line = (id, name) => JSON.stringify({ id, thread_name: name, updated_at: new Date().toISOString() }) + '\n';
  fs.writeFileSync(index, line('01a1aa00-0000-7000-8000-000000000a01', 'First'));
  try {
    const first = ops.snapshot({ home });
    eq([files.stateDbPath(home), first.same, first.threads.map((t) => t.title)], ['', false, ['First']],
      'with no state database the list comes from the index');
    fs.appendFileSync(index, line('01a1aa00-0000-7000-8000-000000000a02', 'Second'));
    const next = ops.snapshot({ home, previous: first.stamp });
    eq([next.same, (next.threads || []).map((t) => t.title).sort()], [false, ['First', 'Second']],
      'and a conversation added to the index shows up at the next read, rather than the read answering that nothing moved');
  } finally { files.setCodexHome(''); }
};
