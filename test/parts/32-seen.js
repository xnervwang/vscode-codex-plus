// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The record of when each conversation was last in front of the user, which "replied and unread" is measured against:
 * where it starts, how marks made in two windows come together, and how large it may grow.
 */
const fake = require('../fake-vscode');

module.exports = async ({ eq }) => {
  const { createSeen, SINCE_KEY, SEEN_KEY, KEEP } = require('../../src/seen');
  let clock = 1000;
  const now = () => clock;
  const timers = [];
  const setTimer = (fn) => { timers.push(fn); return timers.length; };
  const run = () => { while (timers.length) timers.shift()(); };

  const shared = fake.memento();
  const a = createSeen(shared, { now, setTimer, clearTimer: () => {} });
  eq([shared.get(SINCE_KEY), a.unread('t1', 900), a.unread('t1', 1500)], [1000, false, true],
    'it starts when it is first used: a turn that ended before then counts as read, one after as unread');
  eq([a.unread('t1', 0), a.unread('', 1500)], [false, false], 'with no turn ended, or no conversation, nothing is unread');

  clock = 2000;
  a.mark('t1');
  eq([a.unread('t1', 1500), a.unread('t1', 2500), shared.get(SEEN_KEY, null)], [false, true, null],
    'looking at it reads every turn that ended before, not one that ends after, and the mark is not written straight away');
  run();
  eq(shared.get(SEEN_KEY), { t1: 2000 }, 'it is written a moment later');

  /* A second window: same shared state, its own marks. Each window's question reads the stored value afresh. */
  const b = createSeen(shared, { now, setTimer, clearTimer: () => {} });
  eq([shared.get(SINCE_KEY), b.unread('t1', 1500)], [1000, false],
    'another window keeps the same start and sees what the first one read');
  clock = 3000;
  b.mark('t2');
  clock = 2500;
  a.mark('t1');
  run();
  eq([shared.get(SEEN_KEY).t1, shared.get(SEEN_KEY).t2, Object.keys(shared.get(SEEN_KEY)).length], [2500, 3000, 2],
    'marks made in two windows are merged, neither replacing the other');
  clock = 4000;
  b.mark('t1');
  b.flush();
  clock = 1200;
  a.mark('t1');
  a.flush();
  eq(shared.get(SEEN_KEY).t1, 4000, 'and an older mark written later does not take a newer one back');

  const big = fake.memento();
  clock = 5000;
  const c = createSeen(big, { now, setTimer, clearTimer: () => {} });
  for (let i = 0; i < KEEP + 50; i++) { clock = 10000 + i; c.mark(`id${i}`); }
  c.flush();
  const kept = Object.keys(big.get(SEEN_KEY));
  eq([kept.length, kept.includes('id0'), kept.includes(`id${KEEP + 49}`)], [KEEP, false, true],
    `it keeps the ${KEEP} most recently looked at, so it cannot grow without end`);
  eq([big.get(SINCE_KEY), c.unread('id0', 10020), c.unread('id49', 10049), c.unread('id0', 20000)], [10049, false, false, true],
    'the start moves up to the newest mark it dropped: a reply already looked at stays read, and a newer one still shows');
  eq(c.unread('never-looked-at', 7000), false, 'which also counts as read anything that ended before it, looked at or not');
};
