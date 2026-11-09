// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What a page said about an approval card, through the pruning that forgets a conversation once it stops running.
 *
 * A page reports a card by its conversation (src/patching.js, the 'approval' page message), and a conversation stopped
 * on an approval is still running as far as its rollout goes, so the card has to last for as long as the conversation
 * runs, however many redraws pass meanwhile, and go two passes after it stops, as a request of this window does.
 */
module.exports = async ({ eq }) => {
  const { createApprovals, STRIKES } = require('../../src/approvals');
  const T = '01a1e0e0-0000-7000-8000-0000000000e1';
  const a = createApprovals();
  a.pageSays(T, true);
  const runs = (t) => t === T;
  const droppedWhileRunning = [];
  for (let i = 0; i < STRIKES + 3; i++) droppedWhileRunning.push(...a.prune(runs));
  eq([a.of(T).decide, a._pages(), droppedWhileRunning], [1, [T], []],
    'a card a page reports stays for as long as its conversation runs, through any number of redraws');
  const droppedAfter = [];
  for (let i = 0; i < STRIKES; i++) droppedAfter.push(...a.prune(() => false));
  eq([a.of(T).decide, a._pages(), droppedAfter], [0, [], [T]],
    'and goes once its conversation has stopped for two passes, naming that conversation as the one that changed');
};
