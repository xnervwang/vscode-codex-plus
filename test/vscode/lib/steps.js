// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which steps of a window test run. The steps share one window and run in their order in the file, and a step can rely on
 * what one before it left: a conversation open in a tab, or a variable it set. A run is given either a regular expression
 * of step names, or a shard "k/n": the k-th of n runs of consecutive steps, each beginning at a step named in `starts`.
 * The steps so picked bring in, in their places before them, the steps they rely on (`needs`, followed through), and the
 * steps of `base` run whenever any step runs. With neither, every step runs.
 */
const fs = require('fs');

/* The names of the steps of the script at `file`, in their order: the string each `await step('…', async` line opens. */
function namesIn(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^\s*await step\('((?:[^'\\]|\\.)*)', async/gm)].map((m) => m[1].replace(/\\(.)/g, '$1'));
}

/* "k/n" as { k, n }, or null when it is not one with 1 <= k <= n. */
function shardOf(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const k = +m[1], n = +m[2];
  return k >= 1 && k <= n ? { k, n } : null;
}

/*
 * The set of step names to run, or null for every step. `names` are all the steps in order; `only` a RegExp or null;
 * `shard` "k/n" or ''; `starts` the first step of each shard, in order, as many as n; `needs` maps a step to the steps it
 * relies on; `base` the steps that run whenever any does. Throws on a shard that `starts` does not divide the steps into.
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

/* The names in `needs`, `base` and `starts` that are not steps of `names`: each one a table out of step with the script. */
function unknown({ names, starts = [], needs = {}, base = [] }) {
  const have = new Set(names);
  return [...new Set([...starts, ...base, ...Object.keys(needs), ...Object.values(needs).flat()])].filter((x) => !have.has(x));
}

module.exports = { namesIn, shardOf, chosen, unknown };
