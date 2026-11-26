// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which steps of the window test a run takes (test/vscode/lib/steps.js, ui.js stepsToRun), picked by a regular
 * expression of step names or by a shard, with the steps they rely on; and that every step named in ui.js's tables of
 * steps exists.
 */
const path = require('path');

module.exports = ({ eq, root }) => {
  const steps = require(path.join(root, 'test', 'vscode', 'lib', 'steps.js'));
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const opts = { names, starts: ['a', 'c', 'e'], needs: { d: ['c'], f: ['b'] }, base: ['a'] };
  const run = (more) => { const s = steps.chosen({ ...opts, ...more }); return s && names.filter((x) => s.has(x)); };
  eq(run({}), null, 'with no expression and no shard, every step runs');
  eq([run({ only: /^d$/ }), run({ only: /^f$/ }), run({ only: /^z$/ })], [['a', 'c', 'd'], ['a', 'b', 'f'], []],
    'an expression runs the steps it matches, the steps they rely on, and the base steps; none when it matches none');
  eq([run({ shard: '1/3' }), run({ shard: '2/3' }), run({ shard: '3/3' })], [['a', 'b'], ['a', 'c', 'd'], ['a', 'b', 'e', 'f']],
    'a shard runs its run of consecutive steps, with what they rely on before them');
  const thrown = (more) => { try { steps.chosen({ ...opts, ...more }); return ''; } catch (e) { return e.message; } };
  eq([/not k\/n/.test(thrown({ shard: '4/3' })), /3 shards, not 2/.test(thrown({ shard: '1/2' }))], [true, true], 'a shard outside the cut is refused');
  eq(steps.unknown({ ...opts, needs: { d: ['x'] } }), ['x'], 'a name in the tables that is no step is found');

  const ui = require(path.join(root, 'test', 'vscode', 'ui.js'));
  const all = steps.namesIn(path.join(root, 'test', 'vscode', 'ui.js'));
  eq([all.length > 40, new Set(all).size === all.length], [true, true], 'the window test\'s step names are read from it, each one once');
  eq(steps.unknown({ names: all, starts: ui.SHARD_STARTS, needs: ui.STEP_NEEDS, base: ui.STEP_BASE }), [],
    'every step its tables name is a step of it');
  const order = (list) => list.every((x, i) => i === 0 || all.indexOf(list[i - 1]) < all.indexOf(x));
  eq([ui.SHARD_STARTS[0] === all[0], order(ui.SHARD_STARTS), Object.entries(ui.STEP_NEEDS).every(([x, ys]) => ys.every((y) => all.indexOf(y) < all.indexOf(x)))],
    [true, true, true], 'the first shard begins at the first step, the shards in order, and each step relies only on steps before it');
  const shards = ui.SHARD_STARTS.map((_, i) => ui.stepsToRun({ CODEX_PLUS_UI_SHARD: `${i + 1}/${ui.SHARD_STARTS.length}` }));
  eq(all.filter((x) => !shards.some((s) => s.has(x))), [], 'and together the shards run every step');
};
