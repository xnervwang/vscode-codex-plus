// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A full snapshot reads again only the rollouts that changed, and the state it keeps for one that did not is the state
 * a fresh read gives, field for field: for a short rollout, for long ones whose latest turn starts beyond one window or
 * beyond the largest, for one appended to, and for a compressed one, which is decompressed once per read rather than
 * once per window. A file written less than SETTLED_MS ago is never kept; the test dates its files back with utimes
 * rather than waiting.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const files = require('../../src/codex-files');
const fixture = require('../fixture');

module.exports = ({ ok, bad, eq, note, tmp }) => {
  const dir = tmp('rollouts');
  const iso = (ms) => new Date(ms).toISOString();
  const T = Date.parse('2026-11-01T00:00:00Z');
  const row = (at, type, payload) => JSON.stringify({ timestamp: iso(at), type, payload });
  /* Tool output that does not compress to nothing, from a fixed seed, so that a compressed rollout is larger than the
     first window it is read in. */
  let seed = 0;
  const noise = (n) => {
    let s = '';
    while (s.length < n) s += require('crypto').createHash('sha256').update(`noise ${seed++}`).digest('hex');
    return s.slice(0, n);
  };
  /* A rollout whose latest turn starts, then carries `filler` bytes of tool output, then (unless running) ends. */
  const make = (name, { filler = 0, running = false, model = 'gpt-test' } = {}) => {
    const lines = [row(T, 'session_meta', { id: name, cwd: '/w', source: 'vscode' }),
      row(T + 1, 'event_msg', { type: 'task_started', turn_id: 'old', started_at: (T + 1) / 1000 }),
      row(T + 2, 'event_msg', { type: 'task_complete', turn_id: 'old', duration_ms: 1 }),
      row(T + 10, 'event_msg', { type: 'task_started', turn_id: 'last', started_at: (T + 10) / 1000 }),
      row(T + 11, 'turn_context', { turn_id: 'last', model, effort: 'high' })];
    for (let n = 0, i = 0; n < filler; i++) {
      const l = row(T + 20 + i, 'response_item', { type: 'function_call_output', call_id: `c${i}`, output: noise(4000) });
      lines.push(l);
      n += l.length + 1;
    }
    lines.push(row(T + 9e6, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 1234 }, model_context_window: 258400,
      total_token_usage: { total_tokens: 99, input_tokens: 90, output_tokens: 9 } } }));
    if (!running) lines.push(row(T + 9e6 + 1, 'event_msg', { type: 'task_complete', turn_id: 'last', duration_ms: 77 }));
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };
  const settle = (file) => { const old = Date.now() / 1000 - 3600; fs.utimesSync(file, old, old); };
  const batch = [make('short'), make('beyond-one-window', { filler: 200e3 }), make('beyond-the-largest', { filler: 5e6 }),
    make('running', { running: true, filler: 70e3 })];
  const hasZstd = typeof zlib.zstdCompressSync === 'function';
  if (hasZstd) {
    const plain = make('compressed', { filler: 200e3 });
    fs.writeFileSync(plain + '.zst', zlib.zstdCompressSync(fs.readFileSync(plain)));
    fs.unlinkSync(plain);
    batch.push(plain);
  } else note('no zstd in this Node, so a compressed rollout was not read');
  for (const f of batch) settle(files.existingRollout(f));

  /* Reads of rollout files and decompressions while fn() runs. */
  const reads = (fn) => {
    let n = 0, unzipped = 0;
    const opened = new Set();
    const { openSync, readSync, readFileSync } = fs, unzip = zlib.zstdDecompressSync;
    fs.openSync = function (p, ...a) { const fd = openSync.call(this, p, ...a); if (String(p).startsWith(dir)) opened.add(fd); return fd; };
    fs.readSync = function (fd, ...a) { if (opened.has(fd)) n++; return readSync.call(this, fd, ...a); };
    fs.readFileSync = function (p, ...a) { if (String(p).startsWith(dir)) n++; return readFileSync.call(this, p, ...a); };
    if (unzip) zlib.zstdDecompressSync = function (...a) { unzipped++; return unzip.apply(this, a); };
    try { return { out: fn(), n, unzipped }; } finally {
      Object.assign(fs, { openSync, readSync, readFileSync });
      if (unzip) zlib.zstdDecompressSync = unzip;
    }
  };

  const cache = new Map();
  const fresh = batch.map((f) => files.rolloutState(f));
  eq(fresh.map((s) => [s.turnId, s.working, s.model]), [['last', false, 'gpt-test'], ['last', false, 'gpt-test'], ['last', false, ''],
    ['last', true, 'gpt-test'], ...(hasZstd ? [['last', false, 'gpt-test']] : [])],
  'the made-up rollouts are read as their last turn says, one of them past the largest window');
  const first = batch.map((f) => files.cachedRolloutState(f, cache));
  eq(first, fresh, 'the first read through the cache gives what a plain read gives');
  const again = reads(() => batch.map((f) => files.cachedRolloutState(f, cache)));
  eq([again.out, again.n, again.unzipped], [fresh, 0, 0], 'a second read of unchanged rollouts reads none of them and gives the same');
  again.out[0].model = 'changed by a caller';
  eq(files.cachedRolloutState(batch[0], cache).model, 'gpt-test', 'each caller gets a copy, so one that changes it changes nothing kept');

  if (hasZstd) {
    const z = reads(() => files.rolloutState(batch[4]));
    eq([z.unzipped, z.out], [1, fresh[4]], 'a compressed rollout whose turn starts beyond the first window is decompressed once');
  }

  fs.appendFileSync(batch[3], row(T + 9e6 + 5, 'event_msg', { type: 'task_complete', turn_id: 'last', duration_ms: 88 }) + '\n');
  const grown = reads(() => files.cachedRolloutState(batch[3], cache));
  eq([grown.out, grown.n > 0], [files.rolloutState(batch[3]), true], 'a rollout appended to is read again, and its new state is the one kept');
  eq(grown.out.working, false, 'which shows its turn has ended');
  eq(reads(() => files.cachedRolloutState(batch[3], cache)).n > 0, true, 'and one written less than SETTLED_MS ago is read again on the next pass too');
  settle(batch[3]);
  files.cachedRolloutState(batch[3], cache);
  eq(reads(() => files.cachedRolloutState(batch[3], cache)).n, 0, 'until it has gone that long without a write');

  /* The same size and times on another file in its place: the inode tells them apart. */
  const swap = batch[0] + '.new';
  fs.copyFileSync(batch[0], swap);
  const st = fs.statSync(batch[0]);
  const lines = fs.readFileSync(swap, 'utf8').replace('"effort":"high"', '"effort":"lowx"');
  fs.writeFileSync(swap, lines);
  fs.utimesSync(swap, st.atime, st.mtime);
  fs.renameSync(swap, batch[0]);
  eq(files.cachedRolloutState(batch[0], cache).effort, 'lowx', 'a file renamed over a kept one, with the same size and times, is read again');

  const capped = new Map();
  for (let i = 0; i < files.STATES_KEPT + 3; i++) capped.set(`x${i}`, { key: '', state: {} });
  files.cachedRolloutState(batch[1], capped);
  eq([capped.size, capped.has('x0'), capped.has(batch[1])], [files.STATES_KEPT, false, true], 'at most STATES_KEPT states are kept, the oldest going first');

  /* The worker's snapshot, twice, with the second reading no rollout. */
  const home = tmp('home');
  const now = Date.now();
  const made = fixture.codexHome(home, [{ title: 'A', startMs: now - 600e3, turns: [{}] }, { title: 'B', startMs: now - 500e3, turns: [{}, {}] }]);
  for (const t of made) settle(t.rollout);
  const worker = require('../../src/codex-worker');
  const snap = () => worker.ops.snapshot({ home, previous: '', extra: [] });
  const one = snap();
  const watch = (fn) => {
    let n = 0;
    const { openSync } = fs;
    fs.openSync = function (p, ...a) { if (made.some((t) => t.rollout === String(p))) n++; return openSync.call(this, p, ...a); };
    try { return { out: fn(), n }; } finally { fs.openSync = openSync; }
  };
  const two = watch(snap);
  eq([two.n, two.out.states], [0, one.states], 'a full snapshot with no rollout changed opens none of them, and has the same states');
  files.setCodexHome('');
  if (Object.keys(one.states).length !== 2) bad(`the snapshot read ${Object.keys(one.states).length} states, want 2`);
  else ok('a rollout state cache is checked on a real snapshot');
};
