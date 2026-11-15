// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A full snapshot reads again only the rollouts that changed, and the state it keeps for one that did not is the state
 * a fresh read gives, field for field: for a short rollout, for long ones whose latest turn starts beyond one window or
 * beyond the largest, for one appended to, and for a compressed one, which is decompressed once per read rather than
 * once per window. A file changed less than SETTLED_MS ago is never kept; the test passes a time an hour on rather than
 * waiting.
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
  const later = () => Date.now() + 3600e3;
  const batch = [make('short'), make('beyond-one-window', { filler: 200e3 }), make('beyond-the-largest', { filler: 5e6 }),
    make('running', { running: true, filler: 70e3 })];
  const hasZstd = typeof zlib.zstdCompressSync === 'function';
  if (hasZstd) {
    const plain = make('compressed', { filler: 200e3 });
    fs.writeFileSync(plain + '.zst', zlib.zstdCompressSync(fs.readFileSync(plain)));
    fs.unlinkSync(plain);
    batch.push(plain);
  } else note('no zstd in this Node, so a compressed rollout was not read');

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
  const first = batch.map((f) => files.cachedRolloutState(f, cache, later()));
  eq(first, fresh, 'the first read through the cache gives what a plain read gives');
  const again = reads(() => batch.map((f) => files.cachedRolloutState(f, cache, later())));
  eq([again.out, again.n, again.unzipped], [fresh, 0, 0], 'a second read of unchanged rollouts reads none of them and gives the same');
  again.out[0].model = 'changed by a caller';
  eq(files.cachedRolloutState(batch[0], cache, later()).model, 'gpt-test', 'each caller gets a copy, so one that changes it changes nothing kept');

  if (hasZstd) {
    const z = reads(() => files.rolloutState(batch[4]));
    eq([z.unzipped, z.out], [1, fresh[4]], 'a compressed rollout whose turn starts beyond the first window is decompressed once');
  }

  fs.appendFileSync(batch[3], row(T + 9e6 + 5, 'event_msg', { type: 'task_complete', turn_id: 'last', duration_ms: 88 }) + '\n');
  const grown = reads(() => files.cachedRolloutState(batch[3], cache, later()));
  eq([grown.out, grown.n > 0], [files.rolloutState(batch[3]), true], 'a rollout appended to is read again, and its new state is the one kept');
  eq(grown.out.working, false, 'which shows its turn has ended');
  fs.appendFileSync(batch[3], '\n');
  /* "Now" is the moment of that change, so it is less than SETTLED_MS old whatever the scheduler does. */
  const changedAt = fs.statSync(batch[3]).ctimeMs;
  files.cachedRolloutState(batch[3], cache, changedAt);
  eq(reads(() => files.cachedRolloutState(batch[3], cache, changedAt)).n > 0, true, 'and one changed less than SETTLED_MS ago is read again on the next pass too');
  files.cachedRolloutState(batch[3], cache, later());
  eq(reads(() => files.cachedRolloutState(batch[3], cache, later())).n, 0, 'until its change time is that old');

  /* The same size and modification time, on another file renamed into its place and on the file itself rewritten. */
  const st = fs.statSync(batch[0]);
  const swap = batch[0] + '.new';
  fs.writeFileSync(swap, fs.readFileSync(batch[0], 'utf8').replace('"effort":"high"', '"effort":"lowx"'));
  fs.utimesSync(swap, st.atime, st.mtime);
  fs.renameSync(swap, batch[0]);
  eq(files.cachedRolloutState(batch[0], cache, later()).effort, 'lowx', 'a file renamed over a kept one, with the same size and modification time, is read again');
  /* Rewritten in place, same size, its modification time put back: only the change time tells. The times stat gives
     for this one file are pinned, so the test does not rest on the two writes falling in different clock ticks. */
  const pinned = (over, fn) => {
    const statSync = fs.statSync;
    fs.statSync = function (p, ...a) { const s = statSync.call(this, p, ...a); return String(p) === batch[0] ? { ...s, ...over } : s; };
    try { return fn(); } finally { fs.statSync = statSync; }
  };
  const P = Date.parse('2026-01-01T00:00:00Z');
  eq(pinned({ mtimeMs: P, ctimeMs: P }, () => files.cachedRolloutState(batch[0], cache, P + files.SETTLED_MS)).effort, 'lowx', 'a file settled at a given time is read once');
  fs.writeFileSync(batch[0], fs.readFileSync(batch[0], 'utf8').replace('"effort":"lowx"', '"effort":"lowy"'));
  eq(pinned({ mtimeMs: P, ctimeMs: P + 1 }, () => files.cachedRolloutState(batch[0], cache, P + 1 + files.SETTLED_MS)).effort, 'lowy',
    'and read again once it was rewritten in place with its modification time put back, its change time having moved');
  const young = () => files.cachedRolloutState(batch[0], cache, P + 1 + files.SETTLED_MS);
  pinned({ mtimeMs: P, ctimeMs: P + 2 }, young);
  eq(pinned({ mtimeMs: P, ctimeMs: P + 2 }, () => reads(young).n) > 0, true, 'a file whose change time is less than SETTLED_MS old is not kept');

  const capped = new Map();
  for (let i = 0; i < files.STATES_KEPT + 3; i++) capped.set(`x${i}`, { key: '', state: {} });
  files.cachedRolloutState(batch[1], capped, later());
  eq([capped.size, capped.has('x0'), capped.has(batch[1])], [files.STATES_KEPT, false, true], 'at most STATES_KEPT states are kept, the oldest going first');

  /* The worker's snapshot, twice, with the second reading no rollout. */
  const home = tmp('home');
  const now = Date.now();
  const made = fixture.codexHome(home, [{ title: 'A', startMs: now - 600e3, turns: [{}] }, { title: 'B', startMs: now - 500e3, turns: [{}, {}] }]);
  const worker = require('../../src/codex-worker');
  /* An hour on, by the clock the worker reads, so that the rollouts just written count as settled. */
  const snap = () => {
    const real = Date.now;
    const on = real() + 3600e3;
    Date.now = () => on;
    try { return worker.ops.snapshot({ home, previous: '', extra: [] }); } finally { Date.now = real; }
  };
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
