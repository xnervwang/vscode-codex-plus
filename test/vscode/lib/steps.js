// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which steps of a window test run. The steps share one window and run in the order they appear in the test script, and
 * a step can rely on something an earlier step left behind, such as a conversation open in a tab or a variable it set.
 * A run can be given a regular expression of step names, or a shard "k/n": the k-th of n runs of consecutive steps,
 * each beginning at a step named in `starts`. Each picked step brings along the steps it relies on (`needs`, followed
 * through), which run in their places before it, and the steps of `base` run whenever any step runs.
 */
const fs = require('fs');

/* The step names in the script at `file`, in order. */
function namesIn(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^\s*await step\('((?:[^'\\]|\\.)*)', async/gm)].map((m) => m[1].replace(/\\(.)/g, '$1'));
}

/* "k/n" as { k, n }, or null unless it has 1 <= k <= n. */
function shardOf(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const k = +m[1], n = +m[2];
  return k >= 1 && k <= n ? { k, n } : null;
}

/*
 * Picks the steps to run, as a set of names, or null for every step. Throws when `starts` cannot cut the steps into
 * the shard's n parts.
 *
 *   names    all the steps, in order
 *   only     a RegExp, or null
 *   shard    "k/n", or ''
 *   starts   the first step of each shard, in order, as many as n
 *   needs    a step -> the steps it relies on
 *   base     the steps that run whenever any does
 */
function chosen({ names, only = null, shard = '', starts = [], needs = {}, base = [] }) {
  let picked;
  if (shard) {
    const s = shardOf(shard);
    if (!s) throw new Error(`the shard "${shard}" is not k/n`);
    if (starts.length !== s.n) throw new Error(`the steps are cut into ${starts.length} shards, not ${s.n}`);
    const at = starts.map((x) => names.indexOf(x));
    if (at.some((i) => i < 0)) throw new Error(`a shard begins at a step there is not: ${starts.filter((x, i) => at[i] < 0).join(', ')}`);
    picked = names.slice(at[s.k - 1], s.k < s.n ? at[s.k] : names.length);
  } else if (only) {
    picked = names.filter((x) => only.test(x));
  } else return null;
  const out = new Set();
  const add = (x) => { if (out.has(x)) return; out.add(x); for (const y of needs[x] || []) add(y); };
  if (picked.length) for (const x of base) add(x);
  for (const x of picked) add(x);
  return out;
}

/* The names in `needs`, `base` and `starts` that `names` does not have. */
function unknown({ names, starts = [], needs = {}, base = [] }) {
  const have = new Set(names);
  return [...new Set([...starts, ...base, ...Object.keys(needs), ...Object.values(needs).flat()])].filter((x) => !have.has(x));
}

module.exports = { namesIn, shardOf, chosen, unknown };
